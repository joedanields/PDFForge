mod commands;
pub mod db;
pub mod engine;
pub mod launch;
pub mod ocr;
pub mod settings;
pub mod signatures;
pub mod workflows;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

use crate::db::{Db, JobRecord};
use crate::engine::{Engine, EngineCommand, EngineStatus, JobMeta, Sink};
use crate::settings::SettingsStore;

pub const EVENT_ENGINE: &str = "engine://event";
pub const EVENT_ENGINE_STATUS: &str = "engine://status";
pub const EVENT_RECENTS_CHANGED: &str = "recents://changed";

/// `%APPDATA%\PDFForge` (docs/03_ARCHITECTURE.md §6).
pub fn app_data_root() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("PDFForge")
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Forwards engine events to the WebView and records finished jobs in SQLite.
struct AppSink {
    app: AppHandle,
    db: Arc<Db>,
}

impl Sink for AppSink {
    fn event(&self, event: &Value) {
        let _ = self.app.emit(EVENT_ENGINE, event);
    }

    fn status(&self, status: &EngineStatus) {
        let _ = self.app.emit(EVENT_ENGINE_STATUS, status);
    }

    fn job_finished(&self, meta: &JobMeta, final_event: &Value) {
        let done = final_event.get("event").and_then(Value::as_str) == Some("done");
        let outputs: Vec<String> = final_event
            .get("outputs")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        let record = JobRecord {
            id: &meta.id,
            tool: &meta.method,
            inputs: &meta.inputs,
            options: &meta.options,
            outputs: &outputs,
            status: if done { "done" } else { "error" },
            error_code: final_event.get("code").and_then(Value::as_str),
            started_at: meta.started_at_ms,
            duration_ms: meta.started.elapsed().as_millis() as i64,
        };
        if let Err(err) = self.db.record_job(&record) {
            log::error!("could not record job history: {err}");
        }
        if done && !outputs.is_empty() {
            let now = now_ms();
            // Multi-file results (split, export images...) live in one new folder: remember the
            // folder, not every file in it.
            let folder = final_event.pointer("/stats/folder").and_then(Value::as_str);
            let recents: Vec<&str> = match folder {
                Some(folder) => vec![folder],
                None => outputs.iter().map(String::as_str).collect(),
            };
            for path in recents {
                let bytes = std::fs::metadata(path)
                    .ok()
                    .filter(|m| m.is_file())
                    .map(|m| m.len() as i64);
                if let Err(err) = self.db.add_recent(path, &meta.method, &meta.id, now, bytes) {
                    log::error!("could not record recent output: {err}");
                }
            }
            let _ = self.app.emit(EVENT_RECENTS_CHANGED, ());
        }
    }
}

fn log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let mut targets = vec![Target::new(TargetKind::Folder {
        path: app_data_root().join("logs"),
        file_name: Some("pdfforge".into()),
    })];
    if cfg!(debug_assertions) {
        targets.push(Target::new(TargetKind::Stdout));
    }
    tauri_plugin_log::Builder::new()
        .clear_targets()
        .targets(targets)
        .level(log::LevelFilter::Info)
        .max_file_size(5 * 1024 * 1024)
        .rotation_strategy(RotationStrategy::KeepSome(7))
        .build()
}

fn engine_command(app: &AppHandle) -> EngineCommand {
    if cfg!(debug_assertions) {
        EngineCommand::dev()
    } else {
        let resources = app.path().resource_dir().unwrap_or_else(|_| PathBuf::from("."));
        EngineCommand::bundled(resources)
    }
}

pub fn run() {
    let app = tauri::Builder::default()
        // Must be the first plugin: a second launch ("Open with PDFForge") hands its files to
        // this instance and exits.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            let files = launch::pdf_args(argv);
            if !files.is_empty() {
                let _ = app.emit(launch::OPEN_EVENT, files);
            }
        }))
        .plugin(log_plugin())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data = app_data_root();
            std::fs::create_dir_all(&data)?;
            let db = Arc::new(Db::open(&data.join("app.db"))?);
            app.manage(SettingsStore::load(data.join("settings.json")));
            app.manage(db.clone());
            app.manage(launch::PendingOpen::new(launch::pdf_args(std::env::args())));

            let handle = app.handle().clone();
            let sink = Arc::new(AppSink {
                app: handle.clone(),
                db,
            });
            let engine = Engine::start(engine_command(&handle), sink, env!("CARGO_PKG_VERSION").into());
            app.manage(engine);
            log::info!("PDFForge {} started", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::engine_status,
            commands::restart_engine,
            commands::run_job,
            commands::cancel_job,
            commands::get_settings,
            commands::set_settings,
            commands::list_recents,
            commands::clear_history,
            commands::open_output,
            commands::reveal_output,
            commands::open_notices,
            commands::open_licenses_folder,
            commands::read_input_file,
            commands::file_stats,
            commands::list_folder,
            launch::take_open_requests,
            ocr::ocr_languages,
            signatures::list_signatures,
            signatures::save_signature,
            signatures::delete_signature,
            signatures::clear_signatures,
            workflows::list_workflows,
            workflows::save_workflow,
            workflows::delete_workflow,
            ocr::add_ocr_language,
            ocr::remove_ocr_language,
        ])
        .build(tauri::generate_context!())
        .expect("error while building PDFForge");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let engine = handle.state::<Engine>();
            tauri::async_runtime::block_on(engine.shutdown());
        }
    });
}
