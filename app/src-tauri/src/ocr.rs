//! OCR languages (docs/04_UI_UX.md Settings → "OCR languages", D-027).
//!
//! Bundled models live in `<resources>/vendor/tesseract/tessdata` (dev: the repo's `vendor/`);
//! languages the user adds are `.traineddata` files copied into `%APPDATA%\PDFForge\tessdata`,
//! the folder the engine also reads (engine/utils/tesseract.py). Nothing is downloaded.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::Manager;

use crate::app_data_root;

/// Largest model accepted (tessdata_best models are up to ~25 MB; leave head-room).
const MAX_MODEL_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OcrLanguage {
    pub code: String,
    pub bundled: bool,
}

pub fn user_dir() -> PathBuf {
    app_data_root().join("tessdata")
}

pub fn bundled_dir(app: &tauri::AppHandle) -> PathBuf {
    if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../vendor/tesseract/tessdata")
    } else {
        app.path()
            .resource_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join("vendor/tesseract/tessdata")
    }
}

/// `eng`, `chi_sim`, `script_Latin`… — what Tesseract accepts as a language name.
pub fn valid_code(code: &str) -> bool {
    (2..=40).contains(&code.len())
        && code.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && code != "osd"
}

fn codes_in(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let path = e.path();
            let is_model = path
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("traineddata"));
            let stem = path.file_stem()?.to_str()?.to_string();
            (is_model && path.is_file() && valid_code(&stem)).then_some(stem)
        })
        .collect()
}

/// Bundled and user languages, sorted by code; bundled wins when both exist.
pub fn list(bundled: &Path, user: &Path) -> Vec<OcrLanguage> {
    let mut all = BTreeMap::new();
    for code in codes_in(user) {
        all.insert(code, false);
    }
    for code in codes_in(bundled) {
        all.insert(code, true);
    }
    all.into_iter()
        .map(|(code, bundled)| OcrLanguage { code, bundled })
        .collect()
}

/// Copy a `.traineddata` file into the user folder (atomically, never over a bundled model).
pub fn add(bundled: &Path, user: &Path, source: &Path) -> Result<(), String> {
    let is_model = source
        .extension()
        .is_some_and(|x| x.eq_ignore_ascii_case("traineddata"));
    let code = source
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string();
    if !is_model || !valid_code(&code) {
        return Err("Choose a Tesseract language file, e.g. deu.traineddata.".into());
    }
    let meta = fs::metadata(source).map_err(|_| "The file could not be read.".to_string())?;
    if meta.len() < 1024 || meta.len() > MAX_MODEL_BYTES {
        return Err("This does not look like a Tesseract language file.".into());
    }
    if bundled.join(format!("{code}.traineddata")).is_file() {
        return Err(format!("'{code}' is already included with PDFForge."));
    }
    fs::create_dir_all(user).map_err(|e| e.to_string())?;
    let target = user.join(format!("{code}.traineddata"));
    let partial = user.join(format!("{code}.traineddata.partial"));
    fs::copy(source, &partial).map_err(|e| e.to_string())?;
    fs::rename(&partial, &target).map_err(|e| {
        let _ = fs::remove_file(&partial);
        e.to_string()
    })
}

/// Delete a language the user added (bundled models cannot be removed).
pub fn remove(user: &Path, code: &str) -> Result<(), String> {
    if !valid_code(code) {
        return Err("Unknown language".into());
    }
    let path = user.join(format!("{code}.traineddata"));
    if !path.is_file() {
        return Err("Only languages you added can be removed.".into());
    }
    fs::remove_file(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ocr_languages(app: tauri::AppHandle) -> Vec<OcrLanguage> {
    list(&bundled_dir(&app), &user_dir())
}

#[tauri::command]
pub fn add_ocr_language(app: tauri::AppHandle, path: String) -> Result<Vec<OcrLanguage>, String> {
    let bundled = bundled_dir(&app);
    add(&bundled, &user_dir(), Path::new(&path))?;
    Ok(list(&bundled, &user_dir()))
}

#[tauri::command]
pub fn remove_ocr_language(app: tauri::AppHandle, code: String) -> Result<Vec<OcrLanguage>, String> {
    remove(&user_dir(), &code)?;
    Ok(list(&bundled_dir(&app), &user_dir()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(dir: &Path, name: &str) -> PathBuf {
        fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        fs::write(&path, vec![7u8; 2048]).unwrap();
        path
    }

    #[test]
    fn lists_bundled_and_user_languages() {
        let tmp = tempfile::tempdir().unwrap();
        let (bundled, user) = (tmp.path().join("b"), tmp.path().join("u"));
        model(&bundled, "eng.traineddata");
        model(&bundled, "osd.traineddata");
        model(&user, "deu.traineddata");
        model(&user, "eng.traineddata");
        model(&user, "notes.txt");
        assert_eq!(
            list(&bundled, &user),
            vec![
                OcrLanguage {
                    code: "deu".into(),
                    bundled: false
                },
                OcrLanguage {
                    code: "eng".into(),
                    bundled: true
                },
            ]
        );
    }

    #[test]
    fn add_and_remove_user_languages() {
        let tmp = tempfile::tempdir().unwrap();
        let (bundled, user) = (tmp.path().join("b"), tmp.path().join("u"));
        model(&bundled, "eng.traineddata");
        let source = model(&tmp.path().join("downloads"), "fra.traineddata");
        add(&bundled, &user, &source).unwrap();
        assert!(user.join("fra.traineddata").is_file());
        assert!(!user.join("fra.traineddata.partial").exists());

        let duplicate = model(&tmp.path().join("other"), "eng.traineddata");
        assert!(add(&bundled, &user, &duplicate)
            .unwrap_err()
            .contains("already included"));
        let wrong = model(&tmp.path().join("other"), "fra.txt");
        assert!(add(&bundled, &user, &wrong).is_err());
        let tiny = tmp.path().join("ita.traineddata");
        fs::write(&tiny, b"x").unwrap();
        assert!(add(&bundled, &user, &tiny).is_err());

        remove(&user, "fra").unwrap();
        assert!(!user.join("fra.traineddata").exists());
        assert!(remove(&user, "eng").is_err());
        assert!(remove(&user, "../x").is_err());
    }

    #[test]
    fn language_codes() {
        assert!(valid_code("eng"));
        assert!(valid_code("chi_sim"));
        assert!(!valid_code("osd"));
        assert!(!valid_code("e"));
        assert!(!valid_code("en-g"));
        assert!(!valid_code("..\\eng"));
    }
}
