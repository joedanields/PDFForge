//! Engine sidecar supervisor (docs/03_ARCHITECTURE.md §2–3).
//!
//! Spawns the Python engine, performs the `hello` handshake, forwards every protocol event to
//! a [`Sink`], and restarts the engine with backoff when it dies. Jobs that were in flight when
//! the engine died are reported as failed so the UI never waits forever.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::{oneshot, watch, Mutex, Notify};

pub const PROTOCOL_VERSION: u64 = 1;
const HELLO_ID: &str = "__hello";
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(45);
const READY_WAIT: Duration = Duration::from_secs(45);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
const STABLE_UPTIME: Duration = Duration::from_secs(60);
const MAX_RAPID_FAILURES: u32 = 5;
const MAX_BACKOFF: Duration = Duration::from_secs(30);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EngineState {
    Starting,
    Ready,
    Restarting,
    Failed,
    Incompatible,
    Stopped,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub state: EngineState,
    pub engine_version: Option<String>,
    pub protocol_version: Option<u64>,
    pub restarts: u32,
    pub message: Option<String>,
}

impl EngineStatus {
    fn new(state: EngineState, restarts: u32) -> Self {
        Self {
            state,
            engine_version: None,
            protocol_version: None,
            restarts,
            message: None,
        }
    }
}

/// What the app remembers about a submitted job, for history and crash reporting.
#[derive(Clone, Debug)]
pub struct JobMeta {
    pub id: String,
    pub method: String,
    pub inputs: Vec<String>,
    pub options: Value,
    pub started_at_ms: i64,
    pub started: Instant,
}

/// Receives everything the supervisor produces. Implemented by the Tauri app and by tests.
pub trait Sink: Send + Sync + 'static {
    fn event(&self, event: &Value);
    fn status(&self, status: &EngineStatus);
    fn job_finished(&self, meta: &JobMeta, final_event: &Value);
}

/// How to launch the engine.
#[derive(Clone, Debug)]
pub struct EngineCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

impl EngineCommand {
    /// Dev mode: `uv run python main.py` inside the repo's `engine/` folder.
    pub fn dev() -> Self {
        let engine_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("..")
            .join("engine");
        Self {
            program: PathBuf::from("uv"),
            args: ["run", "--quiet", "python", "main.py"].map(String::from).to_vec(),
            cwd: Some(engine_dir),
        }
    }

    /// Installed app: the PyInstaller onedir bundle at `<resources>/engine/engine.exe`.
    pub fn bundled(resource_dir: PathBuf) -> Self {
        let dir = resource_dir.join("engine");
        Self {
            program: dir.join("engine.exe"),
            args: Vec::new(),
            cwd: Some(dir),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EngineError {
    #[error("The PDF engine is not available ({0:?}). Please retry in a moment.")]
    NotReady(EngineState),
    #[error("Invalid job id")]
    InvalidJobId,
    #[error("A job with this id is already running")]
    DuplicateJob,
    #[error("Could not send the job to the engine: {0}")]
    Write(String),
}

pub struct Engine {
    inner: Arc<Inner>,
}

struct Inner {
    command: EngineCommand,
    app_version: String,
    sink: Arc<dyn Sink>,
    stdin: Mutex<Option<ChildStdin>>,
    jobs: StdMutex<HashMap<String, JobMeta>>,
    hello: StdMutex<Option<oneshot::Sender<Value>>>,
    status: watch::Sender<EngineStatus>,
    running: AtomicBool,
    shutdown: AtomicBool,
    shutdown_notify: Notify,
}

enum Exit {
    Exited,
    Incompatible(String),
    SpawnFailed(String),
    Shutdown,
}

pub fn is_valid_job_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id != HELLO_ID
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

impl Engine {
    pub fn start(command: EngineCommand, sink: Arc<dyn Sink>, app_version: String) -> Self {
        let (status, _) = watch::channel(EngineStatus::new(EngineState::Starting, 0));
        let inner = Arc::new(Inner {
            command,
            app_version,
            sink,
            stdin: Mutex::new(None),
            jobs: StdMutex::new(HashMap::new()),
            hello: StdMutex::new(None),
            status,
            running: AtomicBool::new(false),
            shutdown: AtomicBool::new(false),
            shutdown_notify: Notify::new(),
        });
        Inner::spawn_supervisor(&inner);
        Self { inner }
    }

    pub fn status(&self) -> EngineStatus {
        self.inner.status.borrow().clone()
    }

    /// Manually retry after the engine gave up (Failed). No-op while it is running.
    pub fn restart(&self) {
        if !self.inner.shutdown.load(Ordering::SeqCst) {
            Inner::spawn_supervisor(&self.inner);
        }
    }

    pub async fn submit(&self, meta: JobMeta, params: Value) -> Result<(), EngineError> {
        if !is_valid_job_id(&meta.id) {
            return Err(EngineError::InvalidJobId);
        }
        self.inner.wait_ready().await?;
        let line = json!({ "id": meta.id, "method": meta.method, "params": params });
        let id = meta.id.clone();
        {
            let mut jobs = self.inner.jobs.lock().expect("jobs lock");
            if jobs.contains_key(&id) {
                return Err(EngineError::DuplicateJob);
            }
            jobs.insert(id.clone(), meta);
        }
        if let Err(err) = self.inner.write_line(&line).await {
            self.inner.jobs.lock().expect("jobs lock").remove(&id);
            return Err(err);
        }
        Ok(())
    }

    /// Jobs submitted and not yet finished (the updater waits for none, docs/06 §6).
    pub fn running_jobs(&self) -> usize {
        self.inner.jobs.lock().map(|jobs| jobs.len()).unwrap_or(0)
    }

    pub async fn cancel(&self, id: &str) {
        if is_valid_job_id(id) {
            // Best effort: if the engine is gone the job has already been failed.
            let _ = self
                .inner
                .write_line(&json!({ "id": id, "method": "cancel" }))
                .await;
        }
    }

    /// Close the engine's stdin (it then cancels jobs and exits); kill it after a grace period.
    pub async fn shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
        self.inner.shutdown_notify.notify_waiters();
        self.inner.stdin.lock().await.take();
        let mut rx = self.inner.status.subscribe();
        let _ = tokio::time::timeout(SHUTDOWN_GRACE + Duration::from_secs(1), async {
            while self.inner.running.load(Ordering::SeqCst) {
                if rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
    }
}

impl Inner {
    fn spawn_supervisor(inner: &Arc<Self>) {
        if inner.running.swap(true, Ordering::SeqCst) {
            return; // already supervising
        }
        let inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            inner.supervise().await;
            inner.running.store(false, Ordering::SeqCst);
            inner.status.send_modify(|_| {}); // wake shutdown waiters
        });
    }

    fn set_status(&self, status: EngineStatus) {
        self.sink.status(&status);
        self.status.send_replace(status);
    }

    async fn supervise(self: &Arc<Self>) {
        let mut restarts = 0u32;
        let mut rapid_failures = 0u32;
        let mut backoff = Duration::from_secs(1);
        loop {
            let state = if restarts == 0 {
                EngineState::Starting
            } else {
                EngineState::Restarting
            };
            self.set_status(EngineStatus::new(state, restarts));
            let started = Instant::now();
            let exit = self.run_once(restarts).await;
            self.fail_inflight();
            if self.shutdown.load(Ordering::SeqCst) {
                self.set_status(EngineStatus::new(EngineState::Stopped, restarts));
                return;
            }
            match exit {
                Exit::Shutdown => {
                    self.set_status(EngineStatus::new(EngineState::Stopped, restarts));
                    return;
                }
                Exit::Incompatible(message) => {
                    log::error!("engine incompatible: {message}");
                    let mut status = EngineStatus::new(EngineState::Incompatible, restarts);
                    status.message = Some(message);
                    self.set_status(status);
                    return;
                }
                Exit::SpawnFailed(message) => {
                    log::error!("engine failed to start: {message}");
                    rapid_failures += 1;
                    if rapid_failures >= MAX_RAPID_FAILURES {
                        let mut status = EngineStatus::new(EngineState::Failed, restarts);
                        status.message = Some(message);
                        self.set_status(status);
                        return;
                    }
                }
                Exit::Exited => {
                    if started.elapsed() >= STABLE_UPTIME {
                        rapid_failures = 0;
                        backoff = Duration::from_secs(1);
                    } else {
                        rapid_failures += 1;
                    }
                    if rapid_failures >= MAX_RAPID_FAILURES {
                        let mut status = EngineStatus::new(EngineState::Failed, restarts);
                        status.message = Some("The PDF engine keeps stopping unexpectedly.".into());
                        self.set_status(status);
                        return;
                    }
                    log::warn!("engine exited; restarting in {backoff:?}");
                }
            }
            restarts += 1;
            self.set_status(EngineStatus::new(EngineState::Restarting, restarts));
            tokio::select! {
                _ = tokio::time::sleep(backoff) => {}
                _ = self.shutdown_notify.notified() => {}
            }
            if self.shutdown.load(Ordering::SeqCst) {
                self.set_status(EngineStatus::new(EngineState::Stopped, restarts));
                return;
            }
            backoff = (backoff * 2).min(MAX_BACKOFF);
        }
    }

    async fn run_once(self: &Arc<Self>, restarts: u32) -> Exit {
        if self.shutdown.load(Ordering::SeqCst) {
            return Exit::Shutdown;
        }
        let mut cmd = Command::new(&self.command.program);
        cmd.args(&self.command.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUNBUFFERED", "1")
            .kill_on_drop(true);
        if let Some(cwd) = &self.command.cwd {
            cmd.current_dir(cwd);
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = match cmd.spawn() {
            Ok(child) => child,
            Err(err) => return Exit::SpawnFailed(format!("{}: {err}", self.command.program.display())),
        };
        let (Some(stdin), Some(stdout), Some(stderr)) =
            (child.stdin.take(), child.stdout.take(), child.stderr.take())
        else {
            return Exit::SpawnFailed("engine pipes unavailable".into());
        };
        log::info!("engine spawned (pid {:?})", child.id());

        *self.stdin.lock().await = Some(stdin);
        let (hello_tx, hello_rx) = oneshot::channel();
        *self.hello.lock().expect("hello lock") = Some(hello_tx);

        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                log::info!(target: "engine", "{line}");
            }
        });
        let reader = {
            let inner = self.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    inner.handle_line(&line);
                }
            })
        };

        let exit = 'run: {
            if let Err(err) = self
                .write_line(&json!({ "id": HELLO_ID, "method": "hello" }))
                .await
            {
                log::error!("handshake write failed: {err}");
                break 'run Exit::Exited;
            }
            let hello = tokio::select! {
                res = tokio::time::timeout(HANDSHAKE_TIMEOUT, hello_rx) => match res {
                    Ok(Ok(hello)) => hello,
                    _ => {
                        log::error!("engine did not complete the handshake");
                        break 'run Exit::Exited;
                    }
                },
                _ = self.shutdown_notify.notified() => break 'run Exit::Shutdown,
            };
            match check_hello(&hello, &self.app_version) {
                Ok(status) => {
                    let mut status = status;
                    status.restarts = restarts;
                    log::info!(
                        "engine ready: v{:?} protocol {:?}",
                        status.engine_version,
                        status.protocol_version
                    );
                    self.set_status(status);
                }
                Err(message) => break 'run Exit::Incompatible(message),
            }
            tokio::select! {
                status = child.wait() => {
                    log::warn!("engine exited: {status:?}");
                    if self.shutdown.load(Ordering::SeqCst) { Exit::Shutdown } else { Exit::Exited }
                }
                _ = self.shutdown_notify.notified() => Exit::Shutdown,
            }
        };

        self.stdin.lock().await.take(); // EOF: a healthy engine cancels jobs and exits
        if tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
        let _ = reader.await; // deliver every event the engine wrote before dying
        exit
    }

    fn handle_line(&self, line: &str) {
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            log::warn!("engine wrote a non-JSON line ({} bytes)", line.len());
            return;
        };
        let id = event.get("id").and_then(Value::as_str);
        if id == Some(HELLO_ID) {
            if let Some(tx) = self.hello.lock().expect("hello lock").take() {
                let _ = tx.send(event);
            }
            return;
        }
        let Some(id) = id else {
            log::warn!(
                "engine error without job id: {}",
                event.get("message").unwrap_or(&Value::Null)
            );
            return;
        };
        self.sink.event(&event);
        let kind = event.get("event").and_then(Value::as_str);
        if matches!(kind, Some("done" | "error")) {
            let meta = self.jobs.lock().expect("jobs lock").remove(id);
            if let Some(meta) = meta {
                self.sink.job_finished(&meta, &event);
            }
        }
    }

    fn fail_inflight(&self) {
        let jobs: Vec<JobMeta> = self
            .jobs
            .lock()
            .expect("jobs lock")
            .drain()
            .map(|(_, m)| m)
            .collect();
        for meta in jobs {
            let event = crash_event(&meta.id);
            self.sink.event(&event);
            self.sink.job_finished(&meta, &event);
        }
    }

    async fn wait_ready(&self) -> Result<(), EngineError> {
        let mut rx = self.status.subscribe();
        let wait = async {
            loop {
                let state = rx.borrow_and_update().state;
                match state {
                    EngineState::Ready => return Ok(()),
                    EngineState::Failed | EngineState::Incompatible | EngineState::Stopped => {
                        return Err(EngineError::NotReady(state))
                    }
                    EngineState::Starting | EngineState::Restarting => {}
                }
                if rx.changed().await.is_err() {
                    return Err(EngineError::NotReady(EngineState::Stopped));
                }
            }
        };
        match tokio::time::timeout(READY_WAIT, wait).await {
            Ok(res) => res,
            Err(_) => Err(EngineError::NotReady(self.status.borrow().state)),
        }
    }

    async fn write_line(&self, message: &Value) -> Result<(), EngineError> {
        let mut line = message.to_string();
        line.push('\n');
        let mut guard = self.stdin.lock().await;
        let stdin = guard
            .as_mut()
            .ok_or(EngineError::NotReady(self.status.borrow().state))?;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| EngineError::Write(e.to_string()))?;
        stdin.flush().await.map_err(|e| EngineError::Write(e.to_string()))
    }
}

/// The error event reported for jobs that were running when the engine died.
pub fn crash_event(id: &str) -> Value {
    json!({
        "id": id,
        "event": "error",
        "code": "INTERNAL",
        "message": "The PDF engine stopped unexpectedly. Please try again.",
    })
}

/// Validate the engine's `hello` (docs/06 §7: refuse mismatched engines).
pub fn check_hello(hello: &Value, app_version: &str) -> Result<EngineStatus, String> {
    let protocol = hello.get("protocol_version").and_then(Value::as_u64);
    let version = hello.get("engine_version").and_then(Value::as_str);
    if hello.get("event").and_then(Value::as_str) != Some("hello") {
        return Err("The engine sent an invalid handshake.".into());
    }
    if protocol != Some(PROTOCOL_VERSION) {
        return Err(format!(
            "Engine protocol {protocol:?} is not supported (expected {PROTOCOL_VERSION})."
        ));
    }
    if version != Some(app_version) {
        return Err(format!(
            "Engine version {} does not match the app version {app_version}. Please reinstall PDFForge.",
            version.unwrap_or("unknown")
        ));
    }
    Ok(EngineStatus {
        state: EngineState::Ready,
        engine_version: version.map(String::from),
        protocol_version: protocol,
        restarts: 0,
        message: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn job_id_validation() {
        assert!(is_valid_job_id("job-1_a"));
        assert!(!is_valid_job_id(""));
        assert!(!is_valid_job_id(HELLO_ID));
        assert!(!is_valid_job_id("../etc"));
        assert!(!is_valid_job_id(&"x".repeat(65)));
    }

    #[test]
    fn hello_accepts_matching_versions() {
        let hello =
            json!({"id": HELLO_ID, "event": "hello", "engine_version": "0.1.0", "protocol_version": 1});
        let status = check_hello(&hello, "0.1.0").expect("compatible");
        assert_eq!(status.state, EngineState::Ready);
        assert_eq!(status.engine_version.as_deref(), Some("0.1.0"));
    }

    #[test]
    fn hello_rejects_mismatches() {
        let wrong_protocol = json!({"event": "hello", "engine_version": "0.1.0", "protocol_version": 2});
        assert!(check_hello(&wrong_protocol, "0.1.0").is_err());
        let wrong_version = json!({"event": "hello", "engine_version": "0.0.9", "protocol_version": 1});
        assert!(check_hello(&wrong_version, "0.1.0")
            .unwrap_err()
            .contains("0.0.9"));
        assert!(check_hello(&json!({"event": "done"}), "0.1.0").is_err());
    }

    #[test]
    fn crash_event_shape() {
        let event = crash_event("j1");
        assert_eq!(event["event"], "error");
        assert_eq!(event["code"], "INTERNAL");
        assert_eq!(event["id"], "j1");
    }
}
