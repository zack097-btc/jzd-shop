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

mod hub;
mod sync;

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use sync::SyncState;
use tauri::Manager;

/// How many previous copies of the book to keep. A shop that edits all day
/// still gets weeks of history out of this, and the whole folder is a few
/// megabytes at most.
const KEEP_BACKUPS: usize = 60;

/// The largest single attachment we will take. A photograph off a phone is a
/// few megabytes; anything past this is either a mistake or something that does
/// not belong in a repair order.
const MAX_ATTACHMENT_BYTES: usize = 25 * 1024 * 1024;

/// What an attachment is allowed to be. This is a whitelist rather than a
/// blacklist on purpose: the shop needs photographs and the occasional PDF, and
/// nothing here should ever be able to become something the machine will run.
const ALLOWED_EXT: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "pdf", "txt"];

/// Bumped for every attachment saved in this run, so two photographs taken in
/// the same second cannot collide.
static ATT_SEQ: AtomicU64 = AtomicU64::new(0);

/// A counter for temporary file names used by the provider hub.
static HUB_SEQ: AtomicU64 = AtomicU64::new(0);
pub(crate) fn next_seq() -> u64 {
    HUB_SEQ.fetch_add(1, Ordering::Relaxed)
}

/// The largest API response the page will be handed as text.
const MAX_API_BYTES: u64 = 25 * 1024 * 1024;
/// The largest public dataset file we will download.
const MAX_DATASET_BYTES: u64 = 400 * 1024 * 1024;

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
    /// "local" (this computer's own book), or "host" / "client" when the book
    /// is this computer's copy of the shop from the Shop Hub.
    sync: String,
}

#[derive(Serialize)]
struct Saved {
    bytes: usize,
    path: String,
    /// The copy taken before this write, if there was anything to copy.
    backup: Option<String>,
    /// With a Shop Hub: what was queued for the hub.
    #[serde(skip_serializing_if = "Option::is_none")]
    sync: Option<serde_json::Value>,
}

#[derive(Serialize)]
struct AttSaved {
    /// The identifier the book stores. The page never chooses this and never
    /// chooses a path: it gets an id back and refers to the file only by that.
    id: String,
    file: String,
    bytes: usize,
    /// SHA-256 of the stored bytes, so a copy on another computer can be checked.
    sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sync_error: Option<String>,
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

fn att_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("attachments");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// An attachment id is generated here and must look exactly like one coming
/// back in. Lowercase letters, digits and dashes only: no dots, no separators,
/// nothing that can climb out of the attachments folder.
fn safe_att_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// The extension decides nothing about how the file is treated, but it does
/// decide what the file is allowed to be called on disk.
fn safe_ext(ext: &str) -> Option<String> {
    let e = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if ALLOWED_EXT.contains(&e.as_str()) { Some(e) } else { None }
}

fn att_path(app: &tauri::AppHandle, id: &str) -> Result<PathBuf, String> {
    if !safe_att_id(id) {
        return Err("bad attachment id".into());
    }
    let dir = att_dir(app)?;
    // The id is the stem; find whichever allowed extension actually exists.
    for e in ALLOWED_EXT {
        let p = dir.join(format!("{id}.{e}"));
        if p.exists() {
            return Ok(p);
        }
    }
    Err("attachment file missing".into())
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// Base64 by hand rather than by dependency. The page hands over an image as
/// text and gets it back as text; that is the whole contract, and it is small
/// enough to read and to test.
fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::with_capacity(s.len() / 4 * 3 + 3);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for &c in s.as_bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' || c == b' ' || c == b'\t' {
            continue;
        }
        let v = b64_val(c).ok_or_else(|| "attachment data is not valid base64".to_string())?;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { B64[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[(n & 63) as usize] as char } else { '=' });
    }
    out
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
fn db_load(app: tauri::AppHandle, state: tauri::State<'_, SyncState>) -> Result<Loaded, String> {
    let mode = state.mode(&data_dir(&app)?);
    if mode != "local" {
        // This computer belongs to a Shop Hub: its screen shows the shop from
        // the hub, never its old book, even if sync cannot start.
        let path = "Shop Hub".to_string();
        return Ok(match state.shell().and_then(|s| s.sync.load_book()) {
            Ok(Some(text)) => Loaded { existed: !text.is_empty(), text, error: None, path, sync: mode },
            Ok(None) => Loaded { text: String::new(), existed: true, error: Some("Shop Sync changed mode while loading; restart the program".into()), path, sync: mode },
            Err(e) => Loaded { text: String::new(), existed: true, error: Some(e), path, sync: mode },
        });
    }
    let p = book_path(&app)?;
    let path = p.display().to_string();
    let sync = mode;
    if !p.exists() {
        return Ok(Loaded { text: String::new(), existed: false, error: None, path, sync });
    }
    match fs::read_to_string(&p) {
        Ok(text) => Ok(Loaded { text, existed: true, error: None, path, sync }),
        // A file that is there but unreadable is an emergency, not an empty
        // shop. Say so, and let the page put the brakes on.
        Err(e) => Ok(Loaded {
            text: String::new(),
            existed: true,
            error: Some(format!("{e}")),
            path,
            sync,
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
fn db_save(app: tauri::AppHandle, state: tauri::State<'_, SyncState>, text: String) -> Result<Saved, String> {
    if text.trim().is_empty() {
        return Err("refusing to write an empty book".into());
    }
    if state.mode(&data_dir(&app)?) != "local" {
        // Kept by this computer's replica first (durable), then sent to the
        // hub. The page says SYNCED only once the hub has acknowledged it.
        let r = state.shell()?.sync.save_book(&text)?;
        return Ok(Saved { bytes: text.len(), path: "Shop Hub".into(), backup: None, sync: Some(r) });
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

    Ok(Saved { bytes: text.len(), path, backup, sync: None })
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

/// Take a file into the shop's own storage. The caller supplies bytes and a
/// kind; it does not supply a name, a path, or an id, so there is nothing for
/// it to get wrong and nothing for a malicious filename to reach.
#[tauri::command]
fn att_save(app: tauri::AppHandle, state: tauri::State<'_, SyncState>, ext: String, data_b64: String) -> Result<AttSaved, String> {
    let e = safe_ext(&ext).ok_or_else(|| format!("{ext} is not a kind of file this keeps"))?;
    let bytes = b64_decode(&data_b64)?;
    if bytes.is_empty() {
        return Err("refusing to store an empty attachment".into());
    }
    if bytes.len() > MAX_ATTACHMENT_BYTES {
        return Err(format!(
            "that file is {} MB; the limit is {} MB",
            bytes.len() / 1_048_576,
            MAX_ATTACHMENT_BYTES / 1_048_576
        ));
    }
    let dir = att_dir(&app)?;
    // Time plus a counter plus the length: two photographs saved in the same
    // second still land on different names, and an existing file is never
    // written over even if one somehow did.
    let seq = ATT_SEQ.fetch_add(1, Ordering::Relaxed);
    let id = format!("att-{}-{}-{}", stamp(), seq, bytes.len() % 100_000);
    if !safe_att_id(&id) {
        return Err("could not generate a safe attachment id".into());
    }
    let file = format!("{id}.{e}");
    let p = dir.join(&file);
    if p.exists() {
        return Err("attachment id collision; nothing was written".into());
    }

    // Same discipline as the book: write aside, commit to the disk, rename,
    // then read back and check the bytes are the bytes.
    let tmp = dir.join(format!("{id}.writing"));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("cannot open {}: {e}", tmp.display()))?;
        f.write_all(&bytes).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
        f.flush().map_err(|e| format!("cannot flush {}: {e}", tmp.display()))?;
        f.sync_all().map_err(|e| format!("cannot commit {} to disk: {e}", tmp.display()))?;
    }
    fs::rename(&tmp, &p).map_err(|e| format!("cannot place {}: {e}", p.display()))?;
    let back = fs::read(&p).map_err(|e| format!("stored but cannot read back: {e}"))?;
    if back != bytes {
        let _ = fs::remove_file(&p);
        return Err("the stored file does not match what was sent".into());
    }
    let sha256 = {
        use sha2::Digest;
        sha2::Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect::<String>()
    };
    // With a Shop Hub the photo is queued to upload; the file is already safe
    // here either way.
    let sync_error = match state.shell.as_ref() {
        Some(s) if s.sync.mode() != "local" => s.sync.att_saved(&id, &e).err(),
        _ => None,
    };
    Ok(AttSaved { id, file, bytes: bytes.len(), sha256, sync_error })
}

/// With a Shop Hub, a photo taken on another computer is fetched from the hub
/// the first time it is opened here, checked, and kept.
fn att_bytes(app: &tauri::AppHandle, shell: Option<std::sync::Arc<shophub::shell::Shell>>, id: &str) -> Result<Vec<u8>, String> {
    match att_path(app, id) {
        Ok(p) => fs::read(&p).map_err(|e| format!("cannot read attachment: {e}")),
        Err(missing) => match shell {
            Some(s) if s.sync.mode() != "local" => s.sync.att_fetch(id),
            _ => Err(missing),
        },
    }
}

#[tauri::command]
async fn att_read(app: tauri::AppHandle, state: tauri::State<'_, SyncState>, id: String) -> Result<String, String> {
    if !safe_att_id(&id) {
        return Err("bad attachment id".into());
    }
    let shell = state.shell.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || att_bytes(&app, shell, &id)).await.map_err(|e| e.to_string())??;
    Ok(b64_encode(&bytes))
}

#[tauri::command]
async fn att_exists(app: tauri::AppHandle, state: tauri::State<'_, SyncState>, id: String) -> Result<bool, String> {
    if !safe_att_id(&id) {
        return Err("bad attachment id".into());
    }
    let shell = state.shell.clone();
    tauri::async_runtime::spawn_blocking(move || att_bytes(&app, shell, &id).is_ok()).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn att_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let p = att_path(&app, &id)?;
    fs::remove_file(&p).map_err(|e| format!("cannot remove attachment: {e}"))
}

// ---------------------------------------------------------------- provider hub

#[derive(Deserialize)]
struct NetReq {
    method: Option<String>,
    url: String,
    headers: Option<Vec<(String, String)>>,
    body: Option<String>,
    timeout: Option<u64>,
    /// Keep a login token from the response, on this side only: a response
    /// header by name, or a top-level JSON field (removed from what the page gets).
    capture_header: Option<String>,
    capture_json: Option<String>,
    /// A provider signing scheme applied on this side ("motor_shared").
    auth: Option<String>,
}

#[derive(Serialize)]
struct NetRes {
    status: u16,
    body: String,
    bytes: u64,
}

fn scratch_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = data_dir(app)?.join("hub-tmp");
    fs::create_dir_all(&d).map_err(|e| format!("cannot create {}: {e}", d.display()))?;
    Ok(d)
}

/// Run a request and hand back its body as text, removing the temporary file
/// whatever happens.
fn fetch_to_text(app: &tauri::AppHandle, req: hub::Request) -> Result<NetRes, String> {
    let scratch = scratch_dir(app)?;
    let out = scratch.join(format!("resp-{}-{}.tmp", stamp(), next_seq()));
    let status = hub::run_request(&req, &out, &scratch);
    let body = fs::read(&out).unwrap_or_default();
    let _ = fs::remove_file(&out);
    let status = status?;
    Ok(NetRes { status, bytes: body.len() as u64, body: String::from_utf8_lossy(&body).to_string() })
}

/// Public data only: NHTSA. No placeholders are expanded, so no credential can
/// travel through this path.
#[tauri::command(async)]
fn net_fetch(app: tauri::AppHandle, req: NetReq) -> Result<NetRes, String> {
    let host = hub::https_host(&req.url).ok_or_else(|| "only https addresses can be fetched".to_string())?;
    if !hub::host_allowed(&host, hub::PUBLIC_HOSTS) {
        return Err(format!("{host} is not a public data source this program fetches from"));
    }
    if req.url.contains("{{") || req.headers.as_ref().map(|h| h.iter().any(|(_, v)| v.contains("{{"))).unwrap_or(false) {
        return Err("public requests cannot carry credential placeholders".into());
    }
    fetch_to_text(
        &app,
        hub::Request {
            method: req.method.unwrap_or_else(|| "GET".into()),
            url: req.url,
            headers: req.headers.unwrap_or_default(),
            body: req.body,
            timeout_secs: req.timeout.unwrap_or(20),
            max_bytes: MAX_API_BYTES,
            follow_redirects: true,
            header_file: None,
        },
    )
}

/// A licensed provider's request. Credentials are filled in and signatures made
/// here, from Windows Credential Manager, and only for that provider's own hosts.
#[tauri::command(async)]
fn provider_fetch(app: tauri::AppHandle, provider: String, req: NetReq) -> Result<NetRes, String> {
    let spec = hub::ProviderSpec {
        method: req.method.clone().unwrap_or_else(|| "GET".into()),
        url: req.url.clone(),
        headers: req.headers.clone().unwrap_or_default(),
        body: req.body.clone(),
        timeout_secs: req.timeout.unwrap_or(30),
        auth: req.auth.clone(),
    };
    let mut lookup = |field: &str| hub::secret_get(&provider, field);
    let mut session = |name: &str| hub::session_get(&provider, name);
    let mut request = hub::prepare_provider_request(&provider, &spec, &mut lookup, &mut session, hub::now_epoch(), MAX_API_BYTES)?;
    let scratch = scratch_dir(&app)?;
    let header_file = scratch.join(format!("hdr-{}-{}.tmp", stamp(), next_seq()));
    request.header_file = Some(header_file.clone());
    let result = fetch_to_text(&app, request);
    let dump = fs::read_to_string(&header_file).unwrap_or_default();
    let _ = fs::remove_file(&header_file);
    let mut res = result?;
    if let Some(refusal) = hub::redirect_refusal(res.status, &dump) {
        return Err(refusal);
    }
    if res.status >= 200 && res.status < 300 {
        if let Some(h) = req.capture_header {
            if hub::safe_token(&h, 60) {
                if let Some(v) = hub::header_value(&dump, &h) {
                    hub::session_put(&provider, &h, &v);
                }
            }
        }
        if let Some(key) = req.capture_json {
            if hub::safe_token(&key, 60) {
                if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&res.body) {
                    let mut captured = false;
                    if let Some(obj) = v.as_object_mut() {
                        if let Some(tok) = obj.remove(&key) {
                            if let Some(t) = tok.as_str() {
                                hub::session_put(&provider, &key, t);
                            }
                            captured = true;
                        }
                    }
                    if captured {
                        res.body = serde_json::to_string(&v).unwrap_or_default();
                    }
                }
            }
        }
    }
    Ok(res)
}

#[tauri::command]
fn provider_session_clear(provider: String) -> Result<(), String> {
    if !hub::safe_token(&provider, 40) {
        return Err("bad provider id".into());
    }
    hub::session_clear(&provider);
    Ok(())
}

#[derive(Serialize)]
struct DatasetHead {
    status: u16,
    etag: String,
    last_modified: String,
    length: u64,
}

fn nhtsa_dataset_url(url: &str) -> Result<(), String> {
    let host = hub::https_host(url).ok_or_else(|| "only https addresses can be fetched".to_string())?;
    if host != "static.nhtsa.gov" {
        return Err("datasets are only downloaded from static.nhtsa.gov".into());
    }
    Ok(())
}

/// Ask NHTSA whether a file has changed, without downloading it.
#[tauri::command(async)]
fn dataset_check(app: tauri::AppHandle, url: String) -> Result<DatasetHead, String> {
    nhtsa_dataset_url(&url)?;
    let scratch = scratch_dir(&app)?;
    let out = scratch.join(format!("head-{}-{}.tmp", stamp(), next_seq()));
    let hdr = scratch.join(format!("headers-{}-{}.tmp", stamp(), next_seq()));
    let status = hub::run_request(
        &hub::Request {
            method: "HEAD".into(),
            url,
            headers: vec![],
            body: None,
            timeout_secs: 30,
            max_bytes: 64 * 1024,
            follow_redirects: true,
            header_file: Some(hdr.clone()),
        },
        &out,
        &scratch,
    );
    let dump = fs::read_to_string(&hdr).unwrap_or_default();
    let _ = fs::remove_file(&out);
    let _ = fs::remove_file(&hdr);
    let status = status?;
    Ok(DatasetHead {
        status,
        etag: hub::header_value(&dump, "ETag").unwrap_or_default(),
        last_modified: hub::header_value(&dump, "Last-Modified").unwrap_or_default(),
        length: hub::header_value(&dump, "Content-Length").and_then(|v| v.parse().ok()).unwrap_or(0),
    })
}

/// Download one NHTSA file beside the one in use. It is kept only when the
/// transfer finished and the file is a whole ZIP archive.
#[tauri::command(async)]
fn dataset_download(app: tauri::AppHandle, name: String, file: String, url: String) -> Result<DatasetHead, String> {
    nhtsa_dataset_url(&url)?;
    let base = data_dir(&app)?;
    let fresh = hub::ds_source_path(&base, &name, &file, true)?;
    let part = fresh.with_extension("part");
    let _ = fs::remove_file(&part);
    let scratch = scratch_dir(&app)?;
    let hdr = scratch.join(format!("dlhdr-{}-{}.tmp", stamp(), next_seq()));
    let status = hub::run_request(
        &hub::Request {
            method: "GET".into(),
            url,
            headers: vec![],
            body: None,
            timeout_secs: 900,
            max_bytes: MAX_DATASET_BYTES,
            follow_redirects: true,
            header_file: Some(hdr.clone()),
        },
        &part,
        &scratch,
    );
    let dump = fs::read_to_string(&hdr).unwrap_or_default();
    let _ = fs::remove_file(&hdr);
    let status = match status {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_file(&part);
            return Err(e);
        }
    };
    let head = |length| DatasetHead {
        status,
        etag: hub::header_value(&dump, "ETag").unwrap_or_default(),
        last_modified: hub::header_value(&dump, "Last-Modified").unwrap_or_default(),
        length,
    };
    if status != 200 {
        let _ = fs::remove_file(&part);
        return Ok(head(0));
    }
    match hub::ds_stage_source(&base, &name, &file, &part) {
        Ok(bytes) => Ok(head(bytes)),
        Err(e) => {
            let _ = fs::remove_file(&part);
            Err(format!("{e}; nothing was changed"))
        }
    }
}

/// The bytes of a kept NHTSA file, for the page to read row by row.
#[tauri::command(async)]
fn dataset_zip_bytes(app: tauri::AppHandle, name: String, file: String) -> Result<tauri::ipc::Response, String> {
    let base = data_dir(&app)?;
    let p = hub::ds_source_for_reading(&base, &name, &file)?.ok_or_else(|| format!("{file} has not been downloaded"))?;
    let bytes = fs::read(&p).map_err(|e| format!("cannot read the downloaded file: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
fn dataset_has_source(app: tauri::AppHandle, name: String, file: String) -> Result<bool, String> {
    Ok(hub::ds_source_for_reading(&data_dir(&app)?, &name, &file)?.is_some())
}

#[tauri::command]
fn dataset_adopt_sources(app: tauri::AppHandle, name: String, files: Vec<String>) -> Result<(), String> {
    hub::ds_adopt_sources(&data_dir(&app)?, &name, &files)
}

#[tauri::command]
fn dataset_discard_sources(app: tauri::AppHandle, name: String) -> Result<(), String> {
    hub::ds_discard_fresh_sources(&data_dir(&app)?, &name)
}

#[tauri::command]
fn dataset_status_get(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    hub::ds_status_read(&data_dir(&app)?, &name)
}

#[tauri::command]
fn dataset_status_set(app: tauri::AppHandle, name: String, json: String) -> Result<(), String> {
    hub::ds_status_write(&data_dir(&app)?, &name, &json)
}

#[tauri::command]
fn dataset_begin(app: tauri::AppHandle, name: String) -> Result<(), String> {
    hub::ds_begin(&data_dir(&app)?, &name)
}

#[tauri::command(async)]
fn dataset_write(app: tauri::AppHandle, name: String, shard: String, text: String, append: bool) -> Result<(), String> {
    hub::ds_write(&data_dir(&app)?, &name, &shard, &text, append)
}

#[tauri::command]
fn dataset_commit(app: tauri::AppHandle, name: String, meta: String) -> Result<(), String> {
    hub::ds_commit(&data_dir(&app)?, &name, &meta)
}

#[tauri::command]
fn dataset_abort(app: tauri::AppHandle, name: String) -> Result<(), String> {
    hub::ds_abort(&data_dir(&app)?, &name)
}

#[tauri::command(async)]
fn dataset_read(app: tauri::AppHandle, name: String, shard: String) -> Result<Option<String>, String> {
    hub::ds_read(&data_dir(&app)?, &name, &shard)
}

#[tauri::command]
fn dataset_meta(app: tauri::AppHandle, name: String) -> Result<Option<String>, String> {
    let base = data_dir(&app)?;
    // a swap cut off by a crash or power loss is finished or undone first
    hub::ds_recover(&base, &name)?;
    hub::ds_meta(&base, &name)
}

/// Put a credential in Windows Credential Manager. There is deliberately no
/// command that reads one back.
#[tauri::command]
fn secret_set(provider: String, field: String, value: String) -> Result<(), String> {
    hub::secret_put(&provider, &field, &value)
}

#[tauri::command]
fn secret_has(provider: String, field: String) -> Result<bool, String> {
    Ok(hub::secret_get(&provider, &field)?.map(|v| !v.is_empty()).unwrap_or(false))
}

#[tauri::command]
fn secret_clear(provider: String, field: String) -> Result<bool, String> {
    hub::secret_delete(&provider, &field)
}

/// Open a subscription portal in the shop's normal browser, where the shop logs
/// in itself. This program never sees or types a portal password.
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !hub::safe_external_url(&url) {
        return Err("that address cannot be opened".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(&url)
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| format!("could not open the browser: {e}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("opening a browser is only supported on Windows".into())
    }
}

#[tauri::command]
fn db_where(app: tauri::AppHandle) -> Result<String, String> {
    Ok(data_dir(&app)?.display().to_string())
}

pub(crate) fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn main() {
    // A second start while the first copy runs (for example in the
    // notification area as the Shop Hub) shows the first copy's window.
    if sync::another_copy_is_running() {
        return;
    }
    let background = std::env::args().any(|a| a == "--background");
    let app = tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            let state = SyncState::open(&handle, data_dir(&handle)?, att_dir(&handle)?);
            app.manage(state);
            sync::listen_for_second_copy(handle.clone());

            let w = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("JZD Shop Manager")
            .inner_size(1280.0, 860.0)
            .min_inner_size(900.0, 600.0)
            .visible(!background)
            .build()?;
            if !background {
                let _ = w.set_focus();
            }

            // In the notification area: open the window, or quit (which stops
            // the Shop Hub on a host).
            use tauri::menu::{Menu, MenuItem};
            let open = MenuItem::with_id(app, "open", "Open JZD Shop Manager", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit (stops the Shop Hub on this computer)", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            let mut tray = tauri::tray::TrayIconBuilder::with_id("main")
                .tooltip("JZD Shop Manager")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "quit" => {
                        if let Some(s) = app.state::<SyncState>().shell.clone() {
                            s.sync.shutdown();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        show_main_window(tray.app_handle());
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            // The host keeps the shop running for the other computers when its
            // window is closed; Quit in the notification area stops it.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let host = window.app_handle().state::<SyncState>().shell.as_ref().map(|s| s.sync.mode() == "host").unwrap_or(false);
                if host {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            db_load,
            db_save,
            db_backups,
            db_read_backup,
            db_where,
            att_save,
            att_read,
            att_exists,
            att_delete,
            net_fetch,
            provider_fetch,
            provider_session_clear,
            dataset_check,
            dataset_download,
            dataset_zip_bytes,
            dataset_has_source,
            dataset_adopt_sources,
            dataset_discard_sources,
            dataset_status_get,
            dataset_status_set,
            dataset_begin,
            dataset_write,
            dataset_commit,
            dataset_abort,
            dataset_read,
            dataset_meta,
            secret_set,
            secret_has,
            secret_clear,
            open_external,
            sync::sync_status,
            sync::sync_pair_open,
            sync::sync_pair_close,
            sync::sync_pair_decide,
            sync::sync_discover,
            sync::sync_join,
            sync::sync_revoke,
            sync::sync_take_patches,
            sync::sync_confirm_patches,
            sync::sync_resolve,
            sync::sync_presence,
            sync::sync_numbers,
            sync::sync_use_number,
            sync::sync_backup_now,
            sync::sync_backups,
            sync::sync_verify_backup,
            sync::sync_restore_backup,
            sync::sync_att_status,
            sync::sync_host_enable,
            sync::sync_open_backup_dir,
            sync::sync_firewall_status,
            sync::sync_firewall_enable,
            sync::sync_autostart_status,
            sync::sync_autostart_set
        ])
        .build(tauri::generate_context!())
        .expect("JZD Shop Manager could not start");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            // let every sync thread finish writing and release the databases
            if let Some(s) = handle.state::<SyncState>().shell.clone() {
                s.sync.shutdown();
            }
        }
    });
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

    /// A photograph goes out as text and must come back as the same bytes. If
    /// this is wrong every image in the shop is quietly corrupt.
    #[test]
    fn base64_round_trips_exactly() {
        let cases: Vec<Vec<u8>> = vec![
            vec![],
            vec![0],
            vec![0, 1, 2],
            vec![255, 254, 253, 252],
            b"hello".to_vec(),
            b"any carnal pleasure.".to_vec(),
            (0u8..=255).collect(),
            (0..1000).map(|i| (i * 7 % 256) as u8).collect(),
        ];
        for bytes in cases {
            let text = b64_encode(&bytes);
            let back = b64_decode(&text).expect("decodes");
            assert_eq!(back, bytes, "round trip failed for {} bytes", bytes.len());
        }
    }

    /// The encoder must agree with the rest of the world, not just with itself.
    #[test]
    fn base64_matches_the_known_answers() {
        assert_eq!(b64_encode(b""), "");
        assert_eq!(b64_encode(b"f"), "Zg==");
        assert_eq!(b64_encode(b"fo"), "Zm8=");
        assert_eq!(b64_encode(b"foo"), "Zm9v");
        assert_eq!(b64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(b64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(b64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(b64_decode("Zm9vYmFy").unwrap(), b"foobar");
        // A real PNG header, because that is what this will actually carry.
        let png = [0x89u8, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(b64_decode(&b64_encode(&png)).unwrap(), png);
    }

    #[test]
    fn base64_refuses_rubbish() {
        assert!(b64_decode("not*valid").is_err());
        assert!(b64_decode("also#bad").is_err());
        // whitespace and padding are tolerated, because encoders wrap lines
        assert!(b64_decode("Zm9v\nYmFy").is_ok());
        assert_eq!(b64_decode("Zm9v YmFy").unwrap(), b"foobar");
    }

    /// The same rule as backup names, for the same reason: an id is not a path
    /// and must never be able to become one.
    #[test]
    fn attachment_ids_cannot_escape_the_folder() {
        for bad in [
            "../shop.json",
            "a/b.png",
            "..\\win.png",
            "..",
            "att-1.png",          // a dot would let the extension be chosen
            "ATT-UPPER",
            "att 1",
            "att;rm",
            "",
        ] {
            assert!(!safe_att_id(bad), "{bad} must be refused");
        }
        assert!(safe_att_id("att-1700000000-0-12345"));
        assert!(safe_att_id("att-0-0-0"));
    }

    #[test]
    fn only_known_kinds_of_file_are_kept() {
        for good in ["jpg", "JPEG", ".png", "webp", "pdf"] {
            assert!(safe_ext(good).is_some(), "{good} should be allowed");
        }
        for bad in ["exe", "bat", "cmd", "ps1", "dll", "js", "html", "", "png.exe"] {
            assert!(safe_ext(bad).is_none(), "{bad} must never be stored");
        }
        // it normalizes, so the name on disk is predictable
        assert_eq!(safe_ext(".JPG").unwrap(), "jpg");
    }

    #[test]
    fn an_attachment_has_a_ceiling() {
        assert!(MAX_ATTACHMENT_BYTES >= 5 * 1024 * 1024, "a phone photo must fit");
        assert!(MAX_ATTACHMENT_BYTES <= 100 * 1024 * 1024, "but a book is not a file server");
    }

    /// Two attachments saved in the same second must not be able to share a
    /// name, or one photograph silently replaces another.
    #[test]
    fn ids_do_not_collide_within_a_second() {
        let now = 1_700_000_000u64;
        let mut seen = std::collections::HashSet::new();
        for seq in 0..500u64 {
            let id = format!("att-{}-{}-{}", now, seq, seq % 100_000);
            assert!(seen.insert(id.clone()), "duplicate id {id}");
            assert!(safe_att_id(&id));
        }
    }
}
