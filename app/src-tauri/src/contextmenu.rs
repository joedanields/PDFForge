//! Explorer right-click menu for PDFs (docs/02 §J): "Open with PDFForge" and "Merge with
//! PDFForge", registered per user under `HKCU\Software\Classes` (no administrator rights).
//!
//! The installer adds the entries and the uninstaller removes them (`windows/hooks.nsh`);
//! Settings → Windows integration turns them on or off. Explorer starts one process per
//! selected file (up to 15), each forwarded to the running app by the single-instance plugin.

use std::path::Path;

use serde::Serialize;

pub const SHELL_KEY: &str = r"Software\Classes\SystemFileAssociations\.pdf\shell";
pub const OPEN_VERB: &str = "PDFForge.Open";
pub const MERGE_VERB: &str = "PDFForge.Merge";
pub const MERGE_FLAG: &str = "--merge";

/// The few registry operations the menu needs, so tests can use an in-memory store.
pub trait Registry {
    fn get(&self, key: &str, name: &str) -> Option<String>;
    fn set(&mut self, key: &str, name: &str, value: &str) -> Result<(), String>;
    fn delete_tree(&mut self, key: &str) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MenuState {
    Off,
    On,
    /// Registered, but for another copy of PDFForge (e.g. an older install location).
    Elsewhere,
}

/// (key, value name, value): "" is the key's default value.
pub fn entries(exe: &Path) -> Vec<(String, &'static str, String)> {
    let exe = exe.to_string_lossy();
    let icon = format!("\"{exe}\",0");
    let open = format!(r"{SHELL_KEY}\{OPEN_VERB}");
    let merge = format!(r"{SHELL_KEY}\{MERGE_VERB}");
    vec![
        (open.clone(), "", "Open with PDFForge".into()),
        (open.clone(), "Icon", icon.clone()),
        (format!(r"{open}\command"), "", format!("\"{exe}\" \"%1\"")),
        (merge.clone(), "", "Merge with PDFForge".into()),
        (merge.clone(), "Icon", icon),
        (merge.clone(), "MultiSelectModel", "Document".into()),
        (
            format!(r"{merge}\command"),
            "",
            format!("\"{exe}\" {MERGE_FLAG} \"%1\""),
        ),
    ]
}

pub fn install(reg: &mut dyn Registry, exe: &Path) -> Result<(), String> {
    for (key, name, value) in entries(exe) {
        reg.set(&key, name, &value)?;
    }
    Ok(())
}

pub fn uninstall(reg: &mut dyn Registry) -> Result<(), String> {
    reg.delete_tree(&format!(r"{SHELL_KEY}\{OPEN_VERB}"))?;
    reg.delete_tree(&format!(r"{SHELL_KEY}\{MERGE_VERB}"))
}

pub fn state(reg: &dyn Registry, exe: &Path) -> MenuState {
    let wanted = entries(exe);
    let commands: Vec<_> = wanted
        .iter()
        .filter(|(k, _, _)| k.ends_with(r"\command"))
        .collect();
    let present = commands.iter().filter_map(|(k, n, _)| reg.get(k, n)).count();
    if present == 0 {
        MenuState::Off
    } else if commands
        .iter()
        .all(|(k, n, v)| reg.get(k, n).as_deref() == Some(v))
    {
        MenuState::On
    } else {
        MenuState::Elsewhere
    }
}

// ── the real registry (HKCU) ──────────────────────────────────────────────────────────────

#[cfg(windows)]
pub struct CurrentUser;

#[cfg(windows)]
impl Registry for CurrentUser {
    fn get(&self, key: &str, name: &str) -> Option<String> {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        hkcu.open_subkey(key).ok()?.get_value(name).ok()
    }

    fn set(&mut self, key: &str, name: &str, value: &str) -> Result<(), String> {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        let (sub, _) = hkcu.create_subkey(key).map_err(|e| e.to_string())?;
        sub.set_value(name, &value).map_err(|e| e.to_string())
    }

    fn delete_tree(&mut self, key: &str) -> Result<(), String> {
        let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        match hkcu.delete_subkey_all(key) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }
}

fn current_exe() -> Result<std::path::PathBuf, String> {
    std::env::current_exe().map_err(|e| e.to_string())
}

#[cfg(windows)]
#[tauri::command]
pub fn context_menu_state() -> Result<MenuState, String> {
    Ok(state(&CurrentUser, &current_exe()?))
}

#[cfg(windows)]
#[tauri::command]
pub fn set_context_menu(enabled: bool) -> Result<MenuState, String> {
    let exe = current_exe()?;
    let mut reg = CurrentUser;
    if enabled {
        uninstall(&mut reg)?;
        install(&mut reg, &exe)?;
    } else {
        uninstall(&mut reg)?;
    }
    Ok(state(&reg, &exe))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    use std::path::PathBuf;

    #[derive(Default)]
    struct Memory(BTreeMap<(String, String), String>);

    impl Registry for Memory {
        fn get(&self, key: &str, name: &str) -> Option<String> {
            self.0.get(&(key.to_lowercase(), name.into())).cloned()
        }
        fn set(&mut self, key: &str, name: &str, value: &str) -> Result<(), String> {
            self.0.insert((key.to_lowercase(), name.into()), value.into());
            Ok(())
        }
        fn delete_tree(&mut self, key: &str) -> Result<(), String> {
            let prefix = key.to_lowercase();
            self.0
                .retain(|(k, _), _| k != &prefix && !k.starts_with(&format!(r"{prefix}\")));
            Ok(())
        }
    }

    #[test]
    fn install_state_uninstall() {
        let exe = PathBuf::from(r"C:\Users\a\AppData\Local\PDFForge\pdfforge.exe");
        let mut reg = Memory::default();
        assert_eq!(state(&reg, &exe), MenuState::Off);
        install(&mut reg, &exe).unwrap();
        assert_eq!(state(&reg, &exe), MenuState::On);
        let open = format!(r"{SHELL_KEY}\{OPEN_VERB}\command");
        assert_eq!(
            reg.get(&open, "").unwrap(),
            r#""C:\Users\a\AppData\Local\PDFForge\pdfforge.exe" "%1""#
        );
        let merge = format!(r"{SHELL_KEY}\{MERGE_VERB}\command");
        assert!(reg.get(&merge, "").unwrap().contains(" --merge \"%1\""));
        assert_eq!(
            state(&reg, Path::new(r"D:\other\pdfforge.exe")),
            MenuState::Elsewhere
        );
        uninstall(&mut reg).unwrap();
        assert_eq!(state(&reg, &exe), MenuState::Off);
        assert!(reg.0.is_empty());
    }

    #[test]
    fn installer_hooks_write_the_same_entries() {
        let hooks = include_str!("../windows/hooks.nsh");
        assert!(hooks.contains(r"Software\Classes\SystemFileAssociations\.pdf\shell"));
        for (key, name, value) in entries(Path::new(r"$INSTDIR\${MAINBINARYNAME}.exe")) {
            let key = key.replace(SHELL_KEY, "${PDFFORGE_SHELL}");
            let line = format!("WriteRegStr HKCU \"{key}\" \"{name}\"");
            let found = hooks.lines().find(|l| l.trim().starts_with(&line));
            let found = found.unwrap_or_else(|| panic!("hooks.nsh lacks {line}"));
            assert!(found.contains(&value), "{found} should write {value}");
        }
        for verb in [OPEN_VERB, MERGE_VERB] {
            assert!(hooks.contains(&format!("DeleteRegKey HKCU \"${{PDFFORGE_SHELL}}\\{verb}\"")));
        }
    }

    #[test]
    fn all_keys_are_per_user_classes() {
        for (key, _, _) in entries(Path::new(r"C:\x.exe")) {
            assert!(key.starts_with(r"Software\Classes\SystemFileAssociations\.pdf\shell\PDFForge."));
        }
    }
}
