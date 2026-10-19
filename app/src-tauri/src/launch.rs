//! "Open with PDFForge" (docs/06 §4: the .pdf association arrives with the viewer, Phase 3).
//!
//! Windows starts `pdfforge.exe <file.pdf>`. The first instance keeps those paths until the UI
//! asks for them; a second launch is forwarded to the running instance by the single-instance
//! plugin, which emits [`OPEN_EVENT`] instead of opening another window.

use std::path::Path;
use std::sync::Mutex;

use tauri::State;

pub const OPEN_EVENT: &str = "app://open-files";

/// PDFs named on a command line (`argv[0]` is the program itself).
pub fn pdf_args<I: IntoIterator<Item = String>>(argv: I) -> Vec<String> {
    argv.into_iter()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter(|arg| {
            let path = Path::new(arg);
            path.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")) && path.is_file()
        })
        .collect()
}

#[derive(Default)]
pub struct PendingOpen(Mutex<Vec<String>>);

impl PendingOpen {
    pub fn new(files: Vec<String>) -> Self {
        Self(Mutex::new(files))
    }
}

/// Files the app was started with; returned once.
#[tauri::command]
pub fn take_open_requests(pending: State<'_, PendingOpen>) -> Vec<String> {
    pending
        .0
        .lock()
        .map(|mut files| std::mem::take(&mut *files))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_existing_pdfs_only() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("Report.PDF");
        std::fs::write(&pdf, b"%PDF-1.7").unwrap();
        let txt = tmp.path().join("notes.txt");
        std::fs::write(&txt, b"x").unwrap();
        let args = vec![
            "pdfforge.exe".to_string(),
            "--flag".to_string(),
            pdf.to_string_lossy().into_owned(),
            txt.to_string_lossy().into_owned(),
            tmp.path().join("missing.pdf").to_string_lossy().into_owned(),
        ];
        assert_eq!(pdf_args(args), vec![pdf.to_string_lossy().into_owned()]);
    }

    #[test]
    fn pending_files_are_taken_once() {
        let pending = PendingOpen::new(vec!["a.pdf".into()]);
        let first = std::mem::take(&mut *pending.0.lock().unwrap());
        assert_eq!(first, vec!["a.pdf".to_string()]);
        assert!(pending.0.lock().unwrap().is_empty());
    }
}
