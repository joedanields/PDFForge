//! Tauri commands exposed to the UI. Everything the WebView can do outside its sandbox is here.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use serde_json::Value;
use tauri::ipc::Response;
use tauri::State;

use crate::db::{Db, RecentOutput};
use crate::engine::{Engine, EngineStatus, JobMeta};
use crate::settings::{Settings, SettingsStore};
use crate::{app_data_root, now_ms};

/// Inputs the UI may read for thumbnails (bytes only, never written).
const READABLE_EXTENSIONS: &[&str] = &[
    "pdf", "jpg", "jpeg", "png", "bmp", "tif", "tiff", "webp", "gif", "heic", "heif",
];
const MAX_READ_BYTES: u64 = 256 * 1024 * 1024;

type CmdResult<T> = Result<T, String>;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    version: String,
    data_dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    path: String,
    name: String,
    size: Option<u64>,
    /// Last modified, Unix ms (for "sort by date").
    modified: Option<i64>,
    exists: bool,
}

#[tauri::command]
pub fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: app_data_root().to_string_lossy().into(),
    }
}

#[tauri::command]
pub fn engine_status(engine: State<'_, Engine>) -> EngineStatus {
    engine.status()
}

#[tauri::command]
pub fn restart_engine(engine: State<'_, Engine>) {
    engine.restart();
}

/// Submit a job. The UI picks the id so it can subscribe to events before they arrive.
#[tauri::command]
pub async fn run_job(
    engine: State<'_, Engine>,
    settings: State<'_, SettingsStore>,
    id: String,
    method: String,
    params: Value,
) -> CmdResult<()> {
    let Value::Object(mut params) = params else {
        return Err("Job parameters must be an object".into());
    };
    let has_target = ["output", "output_dir"]
        .iter()
        .any(|k| params.get(*k).is_some_and(|v| !v.is_null()));
    if !has_target {
        if let Some(dir) = settings.get().default_output_dir {
            params.insert("output_dir".into(), Value::String(dir));
        }
    }
    let inputs = params
        .get("inputs")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let meta = JobMeta {
        id,
        method,
        inputs,
        options: params.get("options").cloned().unwrap_or(Value::Null), // never `passwords`
        started_at_ms: now_ms(),
        started: Instant::now(),
    };
    engine
        .submit(meta, Value::Object(params))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn cancel_job(engine: State<'_, Engine>, id: String) -> CmdResult<()> {
    engine.cancel(&id).await;
    Ok(())
}

#[tauri::command]
pub fn get_settings(settings: State<'_, SettingsStore>) -> Settings {
    settings.get()
}

#[tauri::command]
pub fn set_settings(settings: State<'_, SettingsStore>, value: Settings) -> CmdResult<Settings> {
    settings.set(value)
}

#[tauri::command]
pub fn list_recents(db: State<'_, Arc<Db>>, limit: Option<u32>) -> CmdResult<Vec<RecentOutput>> {
    db.recents(limit.unwrap_or(8).min(100)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn clear_history(db: State<'_, Arc<Db>>) -> CmdResult<()> {
    db.clear_history().map_err(|e| e.to_string())
}

fn ensure_known_output(db: &Db, path: &str) -> CmdResult<()> {
    match db.is_known_output(path) {
        Ok(true) => Ok(()),
        Ok(false) => Err("Only files created by PDFForge can be opened from here.".into()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn open_output(db: State<'_, Arc<Db>>, path: String) -> CmdResult<()> {
    ensure_known_output(&db, &path)?;
    if !Path::new(&path).exists() {
        return Err("The file no longer exists.".into());
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

/// Open the bundled THIRD_PARTY_NOTICES.txt (Settings → About, docs/09 §4).
#[tauri::command]
pub fn open_notices(app: tauri::AppHandle) -> CmdResult<()> {
    use tauri::Manager;
    let path = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../THIRD_PARTY_NOTICES.txt")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("THIRD_PARTY_NOTICES.txt")
    };
    if !path.is_file() {
        return Err("The licence file is missing. Please reinstall PDFForge.".into());
    }
    tauri_plugin_opener::open_path(&path, None::<&str>).map_err(|e| e.to_string())
}

/// Open the folder with the licences, the written source offer and the shipped source
/// archives (docs/09 §4).
#[tauri::command]
pub fn open_licenses_folder(app: tauri::AppHandle) -> CmdResult<()> {
    use tauri::Manager;
    let dir = if cfg!(debug_assertions) {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../licenses")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("licenses")
    };
    if !dir.is_dir() {
        return Err("The licences folder is missing. Please reinstall PDFForge.".into());
    }
    tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn reveal_output(db: State<'_, Arc<Db>>, path: String) -> CmdResult<()> {
    ensure_known_output(&db, &path)?;
    if !Path::new(&path).exists() {
        return Err("The file no longer exists.".into());
    }
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

fn readable(path: &Path) -> CmdResult<u64> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !READABLE_EXTENSIONS.contains(&ext.as_str()) {
        return Err("Unsupported file type".into());
    }
    let meta = std::fs::metadata(path).map_err(|_| "File not found".to_string())?;
    if !meta.is_file() {
        return Err("Not a file".into());
    }
    Ok(meta.len())
}

/// Raw bytes of an input file for pdf.js thumbnails. Files above 256 MB get no thumbnail.
#[tauri::command]
pub async fn read_input_file(path: String) -> CmdResult<Response> {
    let p = Path::new(&path);
    let size = readable(p)?;
    if size > MAX_READ_BYTES {
        return Err("File too large for preview".into());
    }
    let bytes = tokio::fs::read(p).await.map_err(|e| e.to_string())?;
    Ok(Response::new(bytes))
}

#[tauri::command]
pub fn file_stats(paths: Vec<String>) -> Vec<FileStat> {
    paths
        .into_iter()
        .map(|path| {
            let p = Path::new(&path);
            let meta = std::fs::metadata(p).ok().filter(|m| m.is_file());
            FileStat {
                name: p
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.clone()),
                size: meta.as_ref().map(|m| m.len()),
                modified: meta
                    .as_ref()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as i64),
                exists: meta.is_some(),
                path,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readable_rejects_other_types() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("tool.exe");
        std::fs::write(&exe, b"MZ").unwrap();
        assert!(readable(&exe).is_err());
        let pdf = dir.path().join("a.PDF");
        std::fs::write(&pdf, b"%PDF-1.7").unwrap();
        assert_eq!(readable(&pdf).unwrap(), 8);
        assert!(readable(&dir.path().join("missing.pdf")).is_err());
    }

    #[test]
    fn open_gate_requires_known_output() {
        let db = Db::open_in_memory().unwrap();
        assert!(ensure_known_output(&db, "C:/Windows/notepad.exe").is_err());
        db.add_recent("C:/o/a.pdf", "merge", "j", 1, None).unwrap();
        assert!(ensure_known_output(&db, "C:/o/a.pdf").is_ok());
    }
}
