//! IPC contract + watchdog test against the real Python engine (dev command: `uv run`).
//! Skipped with a notice when `uv` is not installed.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use pdfforge_lib::engine::{Engine, EngineCommand, EngineState, EngineStatus, JobMeta, Sink};
use serde_json::{json, Value};

#[derive(Default)]
struct Recorder {
    events: Mutex<Vec<Value>>,
    statuses: Mutex<Vec<EngineStatus>>,
    finished: Mutex<Vec<(String, Value)>>,
}

impl Sink for Recorder {
    fn event(&self, event: &Value) {
        self.events.lock().unwrap().push(event.clone());
    }
    fn status(&self, status: &EngineStatus) {
        self.statuses.lock().unwrap().push(status.clone());
    }
    fn job_finished(&self, meta: &JobMeta, final_event: &Value) {
        self.finished
            .lock()
            .unwrap()
            .push((meta.id.clone(), final_event.clone()));
    }
}

impl Recorder {
    fn final_for(&self, id: &str) -> Option<Value> {
        self.finished
            .lock()
            .unwrap()
            .iter()
            .find(|(i, _)| i == id)
            .map(|(_, e)| e.clone())
    }
}

fn meta(id: &str, method: &str) -> JobMeta {
    JobMeta {
        id: id.into(),
        method: method.into(),
        inputs: vec![],
        options: Value::Null,
        started_at_ms: 0,
        started: Instant::now(),
    }
}

async fn wait_for<F: Fn() -> bool>(what: &str, timeout: Duration, check: F) {
    let deadline = Instant::now() + timeout;
    while !check() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn uv_available() -> bool {
    std::process::Command::new("uv").arg("--version").output().is_ok()
}

#[test]
fn supervisor_handshake_jobs_crash_restart_shutdown() {
    if !uv_available() {
        eprintln!("skipping: uv not installed");
        return;
    }
    tauri::async_runtime::block_on(async {
        let sink = Arc::new(Recorder::default());
        let engine = Engine::start(
            EngineCommand::dev(),
            sink.clone(),
            env!("CARGO_PKG_VERSION").into(),
        );

        // 1. handshake
        wait_for("ready", Duration::from_secs(90), || {
            engine.status().state == EngineState::Ready
        })
        .await;
        let status = engine.status();
        assert_eq!(status.engine_version.as_deref(), Some(env!("CARGO_PKG_VERSION")));
        assert_eq!(status.protocol_version, Some(1));

        // 2. a job round-trip
        engine
            .submit(
                meta("echo-1", "echo"),
                json!({"message": "hi", "steps": 3, "delay_ms": 1}),
            )
            .await
            .expect("submit");
        wait_for("echo-1", Duration::from_secs(10), || {
            sink.final_for("echo-1").is_some()
        })
        .await;
        let done = sink.final_for("echo-1").unwrap();
        assert_eq!(done["event"], "done");
        assert_eq!(done["stats"]["echo"], "hi");
        let progress = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter(|e| e["id"] == "echo-1" && e["event"] == "progress")
            .count();
        assert_eq!(progress, 3);

        // duplicate id while running is rejected locally
        engine
            .submit(meta("long", "echo"), json!({"steps": 400, "delay_ms": 25}))
            .await
            .expect("submit long");
        assert!(engine.submit(meta("long", "echo"), json!({})).await.is_err());

        // 3. crash while "long" is in flight: it must be failed, and the engine must come back
        engine
            .submit(meta("boom", "echo"), json!({"crash": "engine"}))
            .await
            .expect("submit crash");
        wait_for("long failed", Duration::from_secs(15), || {
            sink.final_for("long").is_some()
        })
        .await;
        let failed = sink.final_for("long").unwrap();
        assert_eq!(failed["event"], "error");
        assert_eq!(failed["code"], "INTERNAL");
        wait_for("restart", Duration::from_secs(90), || {
            let s = engine.status();
            s.state == EngineState::Ready && s.restarts == 1
        })
        .await;
        assert!(sink
            .statuses
            .lock()
            .unwrap()
            .iter()
            .any(|s| s.state == EngineState::Restarting));

        engine
            .submit(meta("echo-2", "echo"), json!({"steps": 1, "delay_ms": 1}))
            .await
            .expect("submit after restart");
        wait_for("echo-2", Duration::from_secs(10), || {
            sink.final_for("echo-2").is_some()
        })
        .await;
        assert_eq!(sink.final_for("echo-2").unwrap()["event"], "done");

        // cancel
        engine
            .submit(meta("to-cancel", "echo"), json!({"steps": 400, "delay_ms": 25}))
            .await
            .expect("submit");
        tokio::time::sleep(Duration::from_millis(200)).await;
        engine.cancel("to-cancel").await;
        wait_for("cancelled", Duration::from_secs(10), || {
            sink.final_for("to-cancel").is_some()
        })
        .await;
        assert_eq!(sink.final_for("to-cancel").unwrap()["code"], "CANCELLED");

        // 4. shutdown
        engine.shutdown().await;
        wait_for("stopped", Duration::from_secs(10), || {
            engine.status().state == EngineState::Stopped
        })
        .await;
        assert!(engine.submit(meta("late", "echo"), json!({})).await.is_err());
    });
}
