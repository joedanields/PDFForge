//! Saved signatures (docs/02 F3 "stored locally (encrypted)", 03 §6: Windows DPAPI).
//!
//! Each signature is a PNG kept in `%APPDATA%\PDFForge\signatures\<id>.sig`, encrypted with
//! DPAPI for the current Windows user, so another account on the machine (or a copied file)
//! cannot read it. Signature images never enter job history: the UI passes them to the
//! engine as job secrets.

use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};

use crate::{app_data_root, now_ms};

const MAX_PNG_BYTES: usize = 5 * 1024 * 1024;
const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
const ENTROPY: &[u8] = b"PDFForge saved signatures v1";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SavedSignature {
    pub id: String,
    /// "signature" or "initials".
    pub kind: String,
    pub created: i64,
    /// PNG image, base64.
    pub png: String,
}

pub fn dir() -> PathBuf {
    app_data_root().join("signatures")
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.chars().all(|c| c.is_ascii_hexdigit())
}

pub fn list_in(dir: &Path) -> Vec<SavedSignature> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<SavedSignature> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "sig"))
        .filter_map(|e| {
            let sealed = fs::read(e.path()).ok()?;
            let plain = unprotect(&sealed).ok()?;
            serde_json::from_slice::<SavedSignature>(&plain).ok()
        })
        .collect();
    found.sort_by_key(|s| s.created);
    found
}

pub fn save_in(dir: &Path, kind: &str, png_base64: &str) -> Result<SavedSignature, String> {
    if kind != "signature" && kind != "initials" {
        return Err("Unknown signature type".into());
    }
    let png = B64
        .decode(png_base64.trim())
        .map_err(|_| "The signature image is invalid.".to_string())?;
    if png.len() > MAX_PNG_BYTES || !png.starts_with(PNG_MAGIC) {
        return Err("The signature image is invalid.".into());
    }
    let signature = SavedSignature {
        id: uuid::Uuid::new_v4().simple().to_string(),
        kind: kind.into(),
        created: now_ms(),
        png: B64.encode(&png),
    };
    let plain = serde_json::to_vec(&signature).map_err(|e| e.to_string())?;
    let sealed = protect(&plain)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let target = dir.join(format!("{}.sig", signature.id));
    let partial = dir.join(format!("{}.sig.partial", signature.id));
    fs::write(&partial, sealed).map_err(|e| e.to_string())?;
    fs::rename(&partial, &target).map_err(|e| e.to_string())?;
    Ok(signature)
}

pub fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Unknown signature".into());
    }
    let path = dir.join(format!("{id}.sig"));
    if path.is_file() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn clear_in(dir: &Path) -> Result<(), String> {
    if dir.is_dir() {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_signatures() -> Vec<SavedSignature> {
    list_in(&dir())
}

#[tauri::command]
pub fn save_signature(kind: String, png: String) -> Result<SavedSignature, String> {
    save_in(&dir(), &kind, &png)
}

#[tauri::command]
pub fn delete_signature(id: String) -> Result<(), String> {
    delete_in(&dir(), &id)
}

#[tauri::command]
pub fn clear_signatures() -> Result<(), String> {
    clear_in(&dir())
}

// ── DPAPI ─────────────────────────────────────────────────────────────────────────────────

#[cfg(windows)]
fn crypt(data: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len()).map_err(|_| "data too large".to_string())?,
        pbData: data.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: ENTROPY.len() as u32,
        pbData: ENTROPY.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: std::ptr::null_mut(),
    };
    // SAFETY: all blobs point at live buffers for the duration of the call; the output buffer
    // is allocated by Windows and released with LocalFree below.
    let ok = unsafe {
        if encrypt {
            CryptProtectData(
                &input,
                std::ptr::null(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                &entropy,
                std::ptr::null(),
                std::ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 || output.pbData.is_null() {
        return Err("The saved signature could not be protected or opened.".into());
    }
    // SAFETY: Windows returned `cbData` bytes at `pbData`.
    let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
    // SAFETY: the buffer was allocated by CryptProtectData/CryptUnprotectData.
    unsafe {
        LocalFree(output.pbData.cast());
    }
    Ok(bytes)
}

#[cfg(windows)]
fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
    crypt(data, true)
}

#[cfg(windows)]
fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
    crypt(data, false)
}

#[cfg(not(windows))]
fn protect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("Saving signatures needs Windows".into())
}

#[cfg(not(windows))]
fn unprotect(_data: &[u8]) -> Result<Vec<u8>, String> {
    Err("Saving signatures needs Windows".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png() -> String {
        let mut bytes = PNG_MAGIC.to_vec();
        bytes.extend_from_slice(&[0u8; 64]);
        B64.encode(bytes)
    }

    #[test]
    fn saves_encrypted_lists_and_deletes() {
        let tmp = tempfile::tempdir().unwrap();
        let saved = save_in(tmp.path(), "signature", &png()).unwrap();
        let file = tmp.path().join(format!("{}.sig", saved.id));
        let raw = fs::read(&file).unwrap();
        assert!(!raw.windows(PNG_MAGIC.len()).any(|w| w == PNG_MAGIC));
        assert!(!String::from_utf8_lossy(&raw).contains(&saved.png[..16]));
        let listed = list_in(tmp.path());
        assert_eq!(listed, vec![saved.clone()]);
        delete_in(tmp.path(), &saved.id).unwrap();
        assert!(list_in(tmp.path()).is_empty());
    }

    #[test]
    fn rejects_bad_input() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(save_in(tmp.path(), "stamp", &png()).is_err());
        assert!(save_in(tmp.path(), "signature", "bm90IGEgcG5n").is_err());
        assert!(save_in(tmp.path(), "signature", "%%%").is_err());
        assert!(delete_in(tmp.path(), "../../etc").is_err());
    }

    #[test]
    fn tampered_files_are_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        save_in(tmp.path(), "initials", &png()).unwrap();
        fs::write(
            tmp.path().join("0123456789abcdef0123456789abcdef.sig"),
            b"garbage",
        )
        .unwrap();
        assert_eq!(list_in(tmp.path()).len(), 1);
        clear_in(tmp.path()).unwrap();
        assert!(!tmp.path().exists());
    }
}
