//! Auto-update (docs/02 §J "opt-in", 06 §6, D-044) with the Tauri updater plugin.
//!
//! Off by default twice over: a build only knows where to look once the owner puts an
//! endpoint in `plugins.updater.endpoints` (tauri.conf.json, empty in the repository), and
//! even then PDFForge only checks on start when the user turned on Settings → Updates.
//! "Check now" always asks first. Updates are verified against `plugins.updater.pubkey`
//! (minisign) and must carry their signed version (`requireSignedVersion`, no downgrades).

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_updater::UpdaterExt;

use crate::engine::Engine;
use crate::settings::SettingsStore;

pub const AVAILABLE_EVENT: &str = "updater://available";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterStatus {
    /// The build has an update endpoint and a public key.
    pub configured: bool,
    pub current_version: String,
}

/// Whether the updater section of the config names at least one endpoint and a key.
pub fn is_configured(updater: Option<&Value>) -> bool {
    let Some(updater) = updater else {
        return false;
    };
    let endpoints = updater
        .get("endpoints")
        .and_then(Value::as_array)
        .is_some_and(|e| e.iter().any(|u| u.as_str().is_some_and(|s| !s.trim().is_empty())));
    let key = updater
        .get("pubkey")
        .and_then(Value::as_str)
        .is_some_and(|k| !k.trim().is_empty());
    endpoints && key
}

fn configured<R: Runtime>(app: &AppHandle<R>) -> bool {
    is_configured(app.config().plugins.0.get("updater"))
}

async fn check<R: Runtime>(app: &AppHandle<R>) -> Result<Option<UpdateInfo>, String> {
    if !configured(app) {
        return Err("Updates are not set up for this build.".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Could not check for updates: {e}"))?;
    Ok(update.map(|u| UpdateInfo {
        version: u.version.clone(),
        current_version: u.current_version.clone(),
        notes: u.body.clone(),
        date: u.date.map(|d| d.to_string()),
    }))
}

#[tauri::command]
pub fn updater_status(app: AppHandle) -> UpdaterStatus {
    UpdaterStatus {
        configured: configured(&app),
        current_version: app.package_info().version.to_string(),
    }
}

#[tauri::command]
pub async fn check_for_update(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    check(&app).await
}

/// Download, verify and install the update, then restart. The engine is stopped first so the
/// installer can replace `engine.exe`.
#[tauri::command]
pub async fn install_update(app: AppHandle) -> Result<(), String> {
    if !configured(&app) {
        return Err("Updates are not set up for this build.".into());
    }
    if app.state::<Engine>().running_jobs() > 0 {
        return Err("Wait until the running job has finished, then install the update.".into());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| format!("Could not check for updates: {e}"))?
        .ok_or_else(|| "PDFForge is up to date.".to_string())?;
    let bytes = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|e| format!("The update could not be downloaded: {e}"))?;
    app.state::<Engine>().shutdown().await;
    update
        .install(bytes)
        .map_err(|e| format!("The update could not be installed: {e}"))?;
    app.restart();
}

/// On start: check once in the background if the user opted in (Settings → Updates).
pub fn check_on_start(app: &AppHandle) {
    let wanted = app.state::<SettingsStore>().get().auto_update;
    if !wanted || !configured(app) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match check(&app).await {
            Ok(Some(info)) => {
                let _ = app.emit(AVAILABLE_EVENT, info);
            }
            Ok(None) => log::info!("PDFForge is up to date"),
            Err(err) => log::warn!("update check failed: {err}"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn configured_needs_an_endpoint_and_a_key() {
        assert!(!is_configured(None));
        assert!(!is_configured(Some(&json!({"pubkey": "abc", "endpoints": []}))));
        assert!(!is_configured(Some(
            &json!({"pubkey": "", "endpoints": ["https://x/latest.json"]})
        )));
        assert!(!is_configured(Some(
            &json!({"pubkey": "abc", "endpoints": [" "]})
        )));
        assert!(is_configured(Some(&json!({
            "pubkey": "abc",
            "endpoints": ["https://github.com/o/r/releases/latest/download/latest.json"]
        }))));
    }

    #[test]
    fn repository_config_ships_with_updates_off() {
        let conf: Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let updater = conf.pointer("/plugins/updater");
        assert!(
            updater.is_some(),
            "plugins.updater must exist (the plugin needs a pubkey)"
        );
        assert!(
            !is_configured(updater),
            "no endpoint may be committed: updates stay off"
        );
        assert_eq!(
            conf.pointer("/plugins/updater/requireSignedVersion"),
            Some(&json!(true))
        );
    }
}
