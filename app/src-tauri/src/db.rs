//! Local SQLite store: job history and recent outputs (`%APPDATA%\PDFForge\app.db`).

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

const SCHEMA_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecentOutput {
    pub path: String,
    pub tool: String,
    pub created_at: i64,
    pub bytes: Option<i64>,
    pub exists: bool,
}

#[derive(Debug, Clone)]
pub struct JobRecord<'a> {
    pub id: &'a str,
    pub tool: &'a str,
    pub inputs: &'a [String],
    /// Tool options only — never passwords (docs/05 S4).
    pub options: &'a serde_json::Value,
    pub outputs: &'a [String],
    pub status: &'a str,
    pub error_code: Option<&'a str>,
    pub started_at: i64,
    pub duration_ms: i64,
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> rusqlite::Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> rusqlite::Result<Self> {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE IF NOT EXISTS history (
                     id          TEXT PRIMARY KEY,
                     tool        TEXT NOT NULL,
                     inputs      TEXT NOT NULL,
                     options     TEXT NOT NULL,
                     outputs     TEXT NOT NULL,
                     status      TEXT NOT NULL,
                     error_code  TEXT,
                     started_at  INTEGER NOT NULL,
                     duration_ms INTEGER NOT NULL
                 );
                 CREATE INDEX IF NOT EXISTS history_started ON history(started_at DESC);
                 CREATE TABLE IF NOT EXISTS recent_outputs (
                     path       TEXT PRIMARY KEY COLLATE NOCASE,
                     tool       TEXT NOT NULL,
                     job_id     TEXT,
                     created_at INTEGER NOT NULL,
                     bytes      INTEGER
                 );
                 CREATE INDEX IF NOT EXISTS recent_created ON recent_outputs(created_at DESC);
                 COMMIT;",
            )?;
        }
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn record_job(&self, job: &JobRecord<'_>) -> rusqlite::Result<()> {
        let inputs = serde_json::to_string(job.inputs).unwrap_or_else(|_| "[]".into());
        let outputs = serde_json::to_string(job.outputs).unwrap_or_else(|_| "[]".into());
        self.conn().execute(
            "INSERT OR REPLACE INTO history
                 (id, tool, inputs, options, outputs, status, error_code, started_at, duration_ms)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                job.id,
                job.tool,
                inputs,
                job.options.to_string(),
                outputs,
                job.status,
                job.error_code,
                job.started_at,
                job.duration_ms
            ],
        )?;
        Ok(())
    }

    pub fn add_recent(
        &self,
        path: &str,
        tool: &str,
        job_id: &str,
        created_at: i64,
        bytes: Option<i64>,
    ) -> rusqlite::Result<()> {
        self.conn().execute(
            "INSERT INTO recent_outputs (path, tool, job_id, created_at, bytes) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(path) DO UPDATE SET tool = excluded.tool, job_id = excluded.job_id,
                 created_at = excluded.created_at, bytes = excluded.bytes",
            params![path, tool, job_id, created_at, bytes],
        )?;
        Ok(())
    }

    pub fn recents(&self, limit: u32) -> rusqlite::Result<Vec<RecentOutput>> {
        let conn = self.conn();
        let mut stmt = conn.prepare(
            "SELECT path, tool, created_at, bytes FROM recent_outputs ORDER BY created_at DESC, rowid DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| {
            let path: String = r.get(0)?;
            Ok(RecentOutput {
                exists: Path::new(&path).exists(), // file, or folder of a multi-file result
                path,
                tool: r.get(1)?,
                created_at: r.get(2)?,
                bytes: r.get(3)?,
            })
        })?;
        rows.collect()
    }

    /// Whether `path` is an output PDFForge produced (gate for open / reveal commands).
    pub fn is_known_output(&self, path: &str) -> rusqlite::Result<bool> {
        let found: Option<i64> = self
            .conn()
            .query_row("SELECT 1 FROM recent_outputs WHERE path = ?1", [path], |r| {
                r.get(0)
            })
            .optional()?;
        Ok(found.is_some())
    }

    pub fn history_count(&self) -> rusqlite::Result<i64> {
        self.conn()
            .query_row("SELECT COUNT(*) FROM history", [], |r| r.get(0))
    }

    pub fn clear_history(&self) -> rusqlite::Result<()> {
        self.conn()
            .execute_batch("DELETE FROM history; DELETE FROM recent_outputs;")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(db: &Db, id: &str, status: &str, outputs: &[String]) {
        db.record_job(&JobRecord {
            id,
            tool: "merge",
            inputs: &["C:/a.pdf".into(), "C:/b.pdf".into()],
            options: &json!({"bookmarks": true}),
            outputs,
            status,
            error_code: None,
            started_at: 1,
            duration_ms: 10,
        })
        .expect("record");
    }

    #[test]
    fn records_history() {
        let db = Db::open_in_memory().unwrap();
        record(&db, "j1", "done", &["C:/a_merge.pdf".into()]);
        record(&db, "j2", "error", &[]);
        assert_eq!(db.history_count().unwrap(), 2);
    }

    #[test]
    fn recents_newest_first_and_deduplicated() {
        let db = Db::open_in_memory().unwrap();
        db.add_recent("C:/x/a.pdf", "merge", "j1", 100, Some(5)).unwrap();
        db.add_recent("C:/x/b.pdf", "merge", "j2", 200, Some(6)).unwrap();
        db.add_recent("C:/X/A.PDF", "merge", "j3", 300, Some(7)).unwrap(); // same file, other case
        let recents = db.recents(8).unwrap();
        assert_eq!(recents.len(), 2);
        assert_eq!(recents[0].created_at, 300);
        assert_eq!(recents[1].path, "C:/x/b.pdf");
        assert!(!recents[0].exists);
    }

    #[test]
    fn recents_limit() {
        let db = Db::open_in_memory().unwrap();
        for n in 0..12 {
            db.add_recent(&format!("C:/o/{n}.pdf"), "merge", "j", n, None)
                .unwrap();
        }
        assert_eq!(db.recents(8).unwrap().len(), 8);
    }

    #[test]
    fn known_outputs_gate() {
        let db = Db::open_in_memory().unwrap();
        db.add_recent("C:/o/a_merge.pdf", "merge", "j1", 1, None).unwrap();
        assert!(db.is_known_output("C:/o/a_merge.pdf").unwrap());
        assert!(db.is_known_output("c:/O/A_MERGE.pdf").unwrap());
        assert!(!db.is_known_output("C:/Windows/system32/calc.exe").unwrap());
    }

    #[test]
    fn clear_history_removes_everything() {
        let db = Db::open_in_memory().unwrap();
        record(&db, "j1", "done", &[]);
        db.add_recent("C:/o/a.pdf", "merge", "j1", 1, None).unwrap();
        db.clear_history().unwrap();
        assert_eq!(db.history_count().unwrap(), 0);
        assert!(db.recents(8).unwrap().is_empty());
    }

    #[test]
    fn reopen_keeps_data() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app.db");
        Db::open(&path)
            .unwrap()
            .add_recent("C:/o/a.pdf", "merge", "j1", 1, None)
            .unwrap();
        assert_eq!(Db::open(&path).unwrap().recents(8).unwrap().len(), 1);
    }
}
