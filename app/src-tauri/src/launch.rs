//! "Open with PDFForge" (docs/06 §4) and the Explorer menu's "Merge with PDFForge"
//! (`contextmenu.rs`).
//!
//! Windows starts `pdfforge.exe [--merge] <file.pdf>`. Requests are queued here until the UI
//! takes them: the first instance queues its own command line; later launches are forwarded
//! by the single-instance plugin, queued, and announced with [`OPEN_EVENT`].

use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::contextmenu::MERGE_FLAG;

pub const OPEN_EVENT: &str = "app://open-files";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct OpenRequest {
    /// "view" (open in the viewer) or "merge" (add to Merge PDF).
    pub action: &'static str,
    pub files: Vec<String>,
}

/// The request on a command line, if it names any existing PDF.
pub fn open_request<I: IntoIterator<Item = String>>(argv: I) -> Option<OpenRequest> {
    let argv: Vec<String> = argv.into_iter().collect();
    let merge = argv.iter().skip(1).any(|a| a == MERGE_FLAG);
    let files = pdf_args(argv);
    (!files.is_empty()).then_some(OpenRequest {
        action: if merge { "merge" } else { "view" },
        files,
    })
}

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
pub struct PendingOpen(Mutex<Vec<OpenRequest>>);

impl PendingOpen {
    pub fn new(first: Option<OpenRequest>) -> Self {
        Self(Mutex::new(first.into_iter().collect()))
    }

    pub fn push(&self, request: OpenRequest) {
        if let Ok(mut queue) = self.0.lock() {
            queue.push(request);
        }
    }
}

/// Requests not yet handled by the UI; each is returned once.
#[tauri::command]
pub fn take_open_requests(pending: State<'_, PendingOpen>) -> Vec<OpenRequest> {
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
    fn pending_requests_are_taken_once() {
        let request = OpenRequest {
            action: "view",
            files: vec!["a.pdf".into()],
        };
        let pending = PendingOpen::new(Some(request.clone()));
        pending.push(OpenRequest {
            action: "merge",
            files: vec!["b.pdf".into()],
        });
        let first = std::mem::take(&mut *pending.0.lock().unwrap());
        assert_eq!(first.len(), 2);
        assert_eq!(first[0], request);
        assert!(pending.0.lock().unwrap().is_empty());
    }

    #[test]
    fn merge_flag_selects_the_action() {
        let tmp = tempfile::tempdir().unwrap();
        let pdf = tmp.path().join("a.pdf");
        std::fs::write(&pdf, b"%PDF-1.7").unwrap();
        let path = pdf.to_string_lossy().into_owned();
        let merge = open_request(["x.exe".into(), MERGE_FLAG.into(), path.clone()]).unwrap();
        assert_eq!(merge.action, "merge");
        assert_eq!(merge.files, vec![path.clone()]);
        assert_eq!(open_request(["x.exe".into(), path]).unwrap().action, "view");
        assert!(open_request(["x.exe".to_string(), MERGE_FLAG.into()]).is_none());
    }
}
