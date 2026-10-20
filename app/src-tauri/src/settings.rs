//! User settings persisted as `%APPDATA%\PDFForge\settings.json`.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}

/// UI language (docs/02 §J: English first; Tamil, Hindi).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    #[default]
    En,
    Ta,
    Hi,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: Theme,
    pub language: Language,
    /// `None` = save next to the first input file (docs/02 common rules).
    pub default_output_dir: Option<String>,
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if let Some(dir) = &self.default_output_dir {
            let path = Path::new(dir);
            if !path.is_absolute() {
                return Err("The default output folder must be an absolute path.".into());
            }
            if !path.is_dir() {
                return Err("The default output folder does not exist.".into());
            }
        }
        Ok(())
    }
}

pub struct SettingsStore {
    path: PathBuf,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// Load settings; a missing or unreadable file falls back to defaults (and is logged).
    pub fn load(path: PathBuf) -> Self {
        let current = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|err| {
                log::warn!("settings.json is invalid ({err}); using defaults");
                Settings::default()
            }),
            Err(_) => Settings::default(),
        };
        Self {
            path,
            current: Mutex::new(current),
        }
    }

    pub fn get(&self) -> Settings {
        self.current.lock().unwrap_or_else(|p| p.into_inner()).clone()
    }

    pub fn set(&self, settings: Settings) -> Result<Settings, String> {
        let mut settings = settings;
        if settings
            .default_output_dir
            .as_deref()
            .is_some_and(|d| d.trim().is_empty())
        {
            settings.default_output_dir = None;
        }
        settings.validate()?;
        let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // Write to a temp file then rename over the old one: never a half-written settings file.
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, text).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &self.path).map_err(|e| e.to_string())?;
        *self.current.lock().unwrap_or_else(|p| p.into_inner()) = settings.clone();
        Ok(settings)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::load(dir.path().join("settings.json"));
        assert_eq!(store.get(), Settings::default());
        assert_eq!(store.get().theme, Theme::System);
    }

    #[test]
    fn roundtrip_and_camel_case() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let out_dir = dir.path().to_string_lossy().to_string();
        let store = SettingsStore::load(path.clone());
        store
            .set(Settings {
                theme: Theme::Dark,
                default_output_dir: Some(out_dir.clone()),
                ..Settings::default()
            })
            .unwrap();
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.contains("\"defaultOutputDir\""));
        assert!(text.contains("\"dark\""));
        let reloaded = SettingsStore::load(path);
        assert_eq!(reloaded.get().default_output_dir, Some(out_dir));
    }

    #[test]
    fn invalid_file_falls_back_to_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, "{ not json").unwrap();
        assert_eq!(SettingsStore::load(path).get(), Settings::default());
    }

    #[test]
    fn unknown_fields_ignored_and_missing_fields_defaulted() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        fs::write(&path, r#"{"theme":"light","futureOption":42}"#).unwrap();
        let s = SettingsStore::load(path).get();
        assert_eq!(s.theme, Theme::Light);
        assert_eq!(s.default_output_dir, None);
    }

    #[test]
    fn language_round_trips_and_defaults_to_english() {
        let parsed: Settings = serde_json::from_str(r#"{"language":"ta"}"#).unwrap();
        assert_eq!(parsed.language, Language::Ta);
        assert_eq!(Settings::default().language, Language::En);
        assert!(serde_json::to_string(&parsed)
            .unwrap()
            .contains(r#""language":"ta""#));
        assert!(serde_json::from_str::<Settings>(r#"{"language":"xx"}"#).is_err());
    }

    #[test]
    fn rejects_missing_or_relative_output_dir() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::load(dir.path().join("settings.json"));
        let missing = dir.path().join("nope").to_string_lossy().to_string();
        assert!(store
            .set(Settings {
                default_output_dir: Some(missing),
                ..Default::default()
            })
            .is_err());
        assert!(store
            .set(Settings {
                default_output_dir: Some("relative".into()),
                ..Default::default()
            })
            .is_err());
        let cleared = store
            .set(Settings {
                default_output_dir: Some("  ".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(cleared.default_output_dir, None);
    }
}
