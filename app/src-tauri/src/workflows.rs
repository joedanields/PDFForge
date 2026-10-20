//! Saved workflows (docs/02 §G): `%APPDATA%\PDFForge\workflows\<id>.json`.
//!
//! A workflow is a name plus a list of steps (`{"tool": "...", "options": {...}}`). Passwords
//! are never part of a saved workflow: the UI asks for them when the workflow runs.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{app_data_root, now_ms};

const MAX_STEPS: usize = 20;
const MAX_NAME_CHARS: usize = 100;
const MAX_FILE_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: String,
    pub name: String,
    pub steps: Vec<Value>,
    #[serde(default)]
    pub created: i64,
    #[serde(default)]
    pub updated: i64,
}

pub fn dir() -> PathBuf {
    app_data_root().join("workflows")
}

fn valid_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

fn validate(workflow: &Workflow) -> Result<(), String> {
    if !valid_id(&workflow.id) {
        return Err("The workflow id is invalid.".into());
    }
    let name = workflow.name.trim();
    if name.is_empty() || name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "Give the workflow a name of up to {MAX_NAME_CHARS} characters."
        ));
    }
    if workflow.steps.is_empty() || workflow.steps.len() > MAX_STEPS {
        return Err(format!("A workflow needs between 1 and {MAX_STEPS} steps."));
    }
    let well_formed = workflow.steps.iter().all(|step| {
        step.get("tool").is_some_and(Value::is_string) && step.get("options").map_or(true, Value::is_object)
    });
    if !well_formed {
        return Err("A workflow step is invalid.".into());
    }
    Ok(())
}

pub fn list_in(dir: &Path) -> Vec<Workflow> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut found: Vec<Workflow> = entries
        .filter_map(Result::ok)
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter(|e| e.metadata().is_ok_and(|m| m.len() <= MAX_FILE_BYTES))
        .filter_map(|e| {
            let text = fs::read_to_string(e.path()).ok()?;
            let workflow: Workflow = serde_json::from_str(&text).ok()?;
            let named_after_file = e.path().file_stem().is_some_and(|s| s == workflow.id.as_str());
            (named_after_file && validate(&workflow).is_ok()).then_some(workflow)
        })
        .collect();
    found.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.created.cmp(&b.created))
    });
    found
}

pub fn save_in(dir: &Path, mut workflow: Workflow) -> Result<Workflow, String> {
    workflow.name = workflow.name.trim().to_string();
    validate(&workflow)?;
    let now = now_ms();
    if workflow.created == 0 {
        workflow.created = now;
    }
    workflow.updated = now;
    let text = serde_json::to_string_pretty(&workflow).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let target = dir.join(format!("{}.json", workflow.id));
    let partial = dir.join(format!("{}.json.partial", workflow.id));
    fs::write(&partial, text).map_err(|e| e.to_string())?;
    fs::rename(&partial, &target).map_err(|e| e.to_string())?;
    Ok(workflow)
}

pub fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err("Unknown workflow".into());
    }
    let path = dir.join(format!("{id}.json"));
    if path.is_file() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn list_workflows() -> Vec<Workflow> {
    list_in(&dir())
}

#[tauri::command]
pub fn save_workflow(workflow: Workflow) -> Result<Workflow, String> {
    save_in(&dir(), workflow)
}

#[tauri::command]
pub fn delete_workflow(id: String) -> Result<(), String> {
    delete_in(&dir(), &id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample(id: &str, name: &str) -> Workflow {
        Workflow {
            id: id.into(),
            name: name.into(),
            steps: vec![json!({"tool": "compress", "options": {"level": "recommended"}})],
            created: 0,
            updated: 0,
        }
    }

    #[test]
    fn save_list_delete_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let saved = save_in(dir.path(), sample("b-1", "  Shrink  ")).unwrap();
        assert_eq!(saved.name, "Shrink");
        assert!(saved.created > 0 && saved.updated >= saved.created);
        save_in(dir.path(), sample("a-2", "archive")).unwrap();
        let names: Vec<_> = list_in(dir.path()).into_iter().map(|w| w.name).collect();
        assert_eq!(names, ["archive", "Shrink"]);

        let again = save_in(
            dir.path(),
            Workflow {
                name: "Shrink more".into(),
                ..saved.clone()
            },
        )
        .unwrap();
        assert_eq!(again.created, saved.created);
        assert_eq!(list_in(dir.path()).len(), 2);

        delete_in(dir.path(), "b-1").unwrap();
        assert_eq!(list_in(dir.path()).len(), 1);
    }

    #[test]
    fn rejects_bad_ids_names_and_steps() {
        let dir = tempfile::tempdir().unwrap();
        assert!(save_in(dir.path(), sample("../evil", "x")).is_err());
        assert!(save_in(dir.path(), sample("UPPER", "x")).is_err());
        assert!(save_in(dir.path(), sample("ok", "   ")).is_err());
        let mut no_steps = sample("ok", "x");
        no_steps.steps.clear();
        assert!(save_in(dir.path(), no_steps).is_err());
        let mut bad_step = sample("ok", "x");
        bad_step.steps = vec![json!({"options": {}})];
        assert!(save_in(dir.path(), bad_step).is_err());
        assert!(delete_in(dir.path(), "..\\settings").is_err());
    }

    #[test]
    fn skips_invalid_or_renamed_files() {
        let dir = tempfile::tempdir().unwrap();
        save_in(dir.path(), sample("good", "Good")).unwrap();
        fs::write(dir.path().join("broken.json"), "{ not json").unwrap();
        fs::copy(dir.path().join("good.json"), dir.path().join("copy.json")).unwrap();
        let ids: Vec<_> = list_in(dir.path()).into_iter().map(|w| w.id).collect();
        assert_eq!(ids, ["good"]);
    }
}
