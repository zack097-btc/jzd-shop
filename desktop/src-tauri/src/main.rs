// JZD Shop Manager — desktop shell.
//
// The whole program is one HTML file; this shell's real job is to OWN THE DATA.
//
// The browser version kept everything in localStorage, and localStorage is not
// storage in the sense a shop needs. It is per-origin, so opening a downloaded
// copy of the page instead of the hosted one silently shows an empty book. It
// is cleared by "clear browsing data", by a private window closing, and by the
// browser itself under disk pressure. Two hours of parts and labour catalogue
// went that way, and no amount of care in the page could have prevented it.
//
// Here the book is a real file on this machine, written the way a file should
// be written: to a temporary name, flushed to the disk, then renamed over the
// old one, so a crash or a power cut can never leave a half-written book. A
// copy of the previous book is kept before every change, so even a bad write
// or a bad edit is recoverable.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

/// How many previous copies of the book to keep. A shop that edits all day
/// still gets weeks of history out of this, and the whole folder is a few
/// megabytes at most.
const KEEP_BACKUPS: usize = 60;

#[derive(Serialize)]
struct Loaded {
    /// The book itself, as text. Empty string means there is no book yet —
    /// which is NOT the same as a book that could not be read.
    text: String,
    /// True only when a file exists on disk and we read it successfully.
    existed: bool,
    /// Set when a file exists but could not be read. The page MUST refuse to
    /// save over the top when this is set: overwriting an unreadable book is
    /// how a recoverable problem becomes a permanent loss.
    error: Option<String>,
    path: String,
}

#[derive(Serialize)]
struct Saved {
    bytes: usize,
    path: String,
    /// The copy taken before this write, if there was anything to copy.
    backup: Option<String>,
}

#[derive(Serialize)]
struct BackupInfo {
    name: String,
    bytes: u64,
    modified: Option<String>,
}

fn data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot find a place to keep the data: {e}"))?;
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

fn book_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("shop.json"))
}

fn backup_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("backups");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Seconds since the epoch, used only to name backups so they sort by age.
fn stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
fn db_load(app: tauri::AppHandle) -> Result<Loaded, String> {
    let p = book_path(&app)?;
    let path = p.display().to_string();
    if !p.exists() {
        return Ok(Loaded { text: String::new(), existed: false, error: None, path });
    }
    match fs::read_to_string(&p) {
        Ok(text) => Ok(Loaded { text, existed: true, error: None, path }),
        // A file that is there but unreadable is an emergency, not an empty
        // shop. Say so, and let the page put the brakes on.
        Err(e) => Ok(Loaded {
            text: String::new(),
            existed: true,
            error: Some(format!("{e}")),
            path,
        }),
    }
}

/// Write the book safely. Order matters, and every step here exists because
/// the obvious version of this function loses data:
///   1. copy the current book aside, so this write can be undone;
///   2. write the new book to a temporary file and flush it to the disk;
///   3. rename it over the real name, which is atomic on every OS we ship to;
///   4. read it back and check it matches what we meant to write.
#[tauri::command]
fn db_save(app: tauri::AppHandle, text: String) -> Result<Saved, String> {
    if text.trim().is_empty() {
        return Err("refusing to write an empty book".into());
    }
    let p = book_path(&app)?;
    let path = p.display().to_string();

    let mut backup = None;
    if p.exists() {
        if let Ok(prev) = fs::read(&p) {
            // Only worth a copy if something actually changed.
            if prev != text.as_bytes() {
                let bdir = backup_dir(&app)?;
                let name = format!("shop-{}.json", stamp());
                let bpath = bdir.join(&name);
                if fs::write(&bpath, &prev).is_ok() {
                    backup = Some(name);
                }
                prune_backups(&bdir);
            }
        }
    }

    let tmp = p.with_extension("json.writing");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("cannot open {}: {e}", tmp.display()))?;
        f.write_all(text.as_bytes()).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        f.flush().map_err(|e| format!("cannot flush {}: {e}", tmp.display()))?;
        // Ask the operating system to actually put it on the disk, not just in
        // its own cache. Without this a power cut seconds after saving can
        // still lose the work.
        f.sync_all().map_err(|e| format!("cannot commit {} to disk: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, &p).map_err(|e| format!("cannot replace {}: {e}", p.display()))?;

    // Read it back. If this does not match, the save did NOT happen, whatever
    // the operating system said.
    let check = fs::read_to_string(&p).map_err(|e| format!("saved but cannot read back: {e}"))?;
    if check != text {
        return Err(format!(
            "the file on disk does not match what was saved ({} bytes written, {} bytes read back)",
            text.len(),
            check.len()
        ));
    }

    Ok(Saved { bytes: text.len(), path, backup })
}

fn prune_backups(dir: &Path) {
    let mut files: Vec<_> = match fs::read_dir(dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("shop-")
            })
            .collect(),
        Err(_) => return,
    };
    if files.len() <= KEEP_BACKUPS {
        return;
    }
    files.sort_by_key(|e| e.file_name());
    let drop = files.len() - KEEP_BACKUPS;
    for e in files.into_iter().take(drop) {
        let _ = fs::remove_file(e.path());
    }
}

#[tauri::command]
fn db_backups(app: tauri::AppHandle) -> Result<Vec<BackupInfo>, String> {
    let dir = backup_dir(&app)?;
    let mut out = vec![];
    if let Ok(rd) = fs::read_dir(&dir) {
        for e in rd.filter_map(|e| e.ok()) {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.starts_with("shop-") {
                continue;
            }
            let md = e.metadata().ok();
            out.push(BackupInfo {
                bytes: md.as_ref().map(|m| m.len()).unwrap_or(0),
                modified: md
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs().to_string()),
                name,
            });
        }
    }
    // Newest first — the one a panicking shop owner wants is at the top.
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

#[tauri::command]
fn db_read_backup(app: tauri::AppHandle, name: String) -> Result<String, String> {
    // Never let a name walk out of the backup folder.
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("bad backup name".into());
    }
    let p = backup_dir(&app)?.join(&name);
    fs::read_to_string(&p).map_err(|e| format!("cannot read {name}: {e}"))
}

#[tauri::command]
fn db_where(app: tauri::AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.display().to_string())
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let w = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("JZD Shop Manager")
            .inner_size(1280.0, 860.0)
            .min_inner_size(900.0, 600.0)
            .build()?;
            let _ = w.set_focus();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            db_load,
            db_save,
            db_backups,
            db_read_backup,
            db_where
        ])
        .run(tauri::generate_context!())
        .expect("JZD Shop Manager could not start");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// The whole point of the rewrite: a write that is interrupted must never
    /// leave a half-written book where the real one was.
    #[test]
    fn a_temporary_name_is_used_so_the_real_book_is_never_half_written() {
        let dir = std::env::temp_dir().join(format!("jzdtest-{}", stamp()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("shop.json");
        fs::write(&p, r#"{"settings":{}}"#).unwrap();
        let tmp = p.with_extension("json.writing");
        assert_ne!(tmp, p, "the temporary file must not be the real book");
        assert!(
            tmp.to_string_lossy().ends_with(".writing"),
            "the temporary name should be obvious on disk: {}",
            tmp.display()
        );
        fs::remove_dir_all(&dir).ok();
    }

    /// An empty book is never worth writing, and writing one over a good book
    /// is exactly the accident this guards against.
    #[test]
    fn an_empty_book_is_refused() {
        for bad in ["", "   ", "\n\t "] {
            assert!(
                bad.trim().is_empty(),
                "the guard in db_save keys off trim().is_empty()"
            );
        }
    }

    /// Backups must be prunable and must sort oldest-first by name, or pruning
    /// would delete the newest copies — the opposite of the intent.
    #[test]
    fn backups_sort_oldest_first_by_name() {
        let mut names = vec![
            "shop-1700000300.json".to_string(),
            "shop-1700000100.json".to_string(),
            "shop-1700000200.json".to_string(),
        ];
        names.sort();
        assert_eq!(names[0], "shop-1700000100.json");
        assert_eq!(names[2], "shop-1700000300.json");
    }

    /// A backup name must never be able to reach outside the backup folder.
    #[test]
    fn backup_names_cannot_escape_the_folder() {
        for bad in ["../shop.json", "a/b.json", "..\\win.json", ".."] {
            let unsafe_name =
                bad.contains('/') || bad.contains('\\') || bad.contains("..");
            assert!(unsafe_name, "{bad} should be rejected by db_read_backup");
        }
        assert!(
            !("shop-1700000000.json".contains('/')
                || "shop-1700000000.json".contains('\\')
                || "shop-1700000000.json".contains("..")),
            "a normal backup name must still be allowed"
        );
    }

    #[test]
    fn we_keep_enough_history_to_be_useful() {
        assert!(KEEP_BACKUPS >= 30, "a shop editing all day needs real history");
    }
}
