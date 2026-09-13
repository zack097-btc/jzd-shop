//! Shop Hub backups.
//!
//! A backup is a folder: every field with its revision, the shop's identity,
//! the paired devices (never their secrets), the photographs, and a manifest
//! with a SHA-256 of every file and of the whole book. Verifying a backup
//! rebuilds the book from the backup itself and checks it against the manifest,
//! so "verified" means "this can actually be restored", not "the files exist".

use crate::flat;
use crate::store::{now_iso, HubStore};
use crate::util;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn backups_dir(store: &HubStore) -> PathBuf {
    store.dir().parent().map(|p| p.join("hub-backups")).unwrap_or_else(|| store.dir().join("backups"))
}

fn write_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut f = std::fs::File::create(path).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())
}

pub fn create(store: &HubStore, reason: &str) -> Result<Value, String> {
    let reason: String = reason.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').take(30).collect();
    let stamp = now_iso().replace(':', "").replace('-', "");
    let dir = backups_dir(store).join(format!("{stamp}-{reason}-{}", util::rand_hex(2)));
    std::fs::create_dir_all(dir.join("attachments")).map_err(|e| e.to_string())?;
    let rows = store.dump()?;
    let mut lines = String::new();
    for r in &rows {
        lines.push_str(&r.to_string());
        lines.push('\n');
    }
    let book = store.book()?;
    let meta = json!({"seq": store.seq()?, "shopId": store.shop_id(), "shopName": store.meta("shopName")?.unwrap_or(Value::Null),
        "epoch": store.epoch(), "schema": crate::store::SCHEMA_VERSION, "createdAt": now_iso(), "reason": reason});
    let devices = store.devices()?;
    let atts = store.att_all()?;
    let mut files = Vec::new();
    for (name, bytes) in [
        ("leaves.jsonl", lines.into_bytes()),
        ("meta.json", serde_json::to_vec_pretty(&meta).unwrap()),
        ("devices.json", serde_json::to_vec_pretty(&devices).unwrap()),
        ("attachments.json", serde_json::to_vec_pretty(&atts).unwrap()),
    ] {
        write_file(&dir.join(name), &bytes)?;
        files.push(json!({"name": name, "sha256": flat::sha256_hex(&bytes), "bytes": bytes.len()}));
    }
    let mut att_count = 0;
    for a in &atts {
        if a["state"] != "stored" {
            continue;
        }
        let id = a["id"].as_str().unwrap_or("");
        let ext = a["ext"].as_str().unwrap_or("");
        let src = store.att_dir().join(format!("{id}.{ext}"));
        let bytes = std::fs::read(&src).map_err(|e| format!("photo {id} could not be read for the backup: {e}"))?;
        write_file(&dir.join("attachments").join(format!("{id}.{ext}")), &bytes)?;
        att_count += 1;
    }
    let counts: serde_json::Map<String, Value> = book
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), json!(match v { Value::Object(o) => o.len(), Value::Array(a) => a.len(), _ => 1 }))).collect())
        .unwrap_or_default();
    let manifest = json!({"format": 1, "files": files, "bookSha256": flat::sha256_hex(flat::canonical(&book).as_bytes()),
        "leaves": rows.len(), "attachments": att_count, "counts": counts, "meta": meta});
    write_file(&dir.join("manifest.json"), &serde_json::to_vec_pretty(&manifest).unwrap())?;
    rotate(store);
    Ok(json!({"name": dir.file_name().unwrap().to_string_lossy(), "path": dir.display().to_string(), "leaves": rows.len(), "attachments": att_count, "createdAt": meta["createdAt"]}))
}

/// Keep every pre-migration and pre-restore backup, the last 14 daily ones and
/// the last 20 of everything else.
fn rotate(store: &HubStore) {
    let Ok(rd) = std::fs::read_dir(backups_dir(store)) else { return };
    let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
    names.sort();
    for (kind, keep) in [("-daily-", 14usize), ("-manual-", 20)] {
        let list: Vec<&String> = names.iter().filter(|n| n.contains(kind)).collect();
        if list.len() > keep {
            for n in &list[..list.len() - keep] {
                let _ = std::fs::remove_dir_all(backups_dir(store).join(n));
            }
        }
    }
}

pub fn list(store: &HubStore) -> Vec<Value> {
    let Ok(rd) = std::fs::read_dir(backups_dir(store)) else { return vec![] };
    let mut out: Vec<Value> = rd
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let m: Value = serde_json::from_slice(&std::fs::read(e.path().join("manifest.json")).ok()?).ok()?;
            Some(json!({"name": e.file_name().to_string_lossy(), "createdAt": m["meta"]["createdAt"], "reason": m["meta"]["reason"], "leaves": m["leaves"], "attachments": m["attachments"]}))
        })
        .collect();
    out.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
    out
}

/// Prove a backup restores: every file matches its checksum, and the book
/// rebuilt from the backup's own fields matches the book it was taken from.
pub fn verify(dir: &Path) -> Result<Value, String> {
    let manifest: Value = serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).map_err(|e| format!("no manifest: {e}"))?).map_err(|e| e.to_string())?;
    for f in manifest["files"].as_array().ok_or("bad manifest")? {
        let name = f["name"].as_str().unwrap_or("");
        let bytes = std::fs::read(dir.join(name)).map_err(|e| format!("{name} is missing: {e}"))?;
        if flat::sha256_hex(&bytes) != f["sha256"].as_str().unwrap_or("") {
            return Err(format!("{name} does not match its checksum"));
        }
    }
    let text = std::fs::read_to_string(dir.join("leaves.jsonl")).map_err(|e| e.to_string())?;
    let mut leaves = flat::Leaves::new();
    let mut n = 0;
    for line in text.lines().filter(|l| !l.is_empty()) {
        let row: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        n += 1;
        if let Some(v) = row["rec"].get("v") {
            leaves.insert(row["p"].as_str().unwrap_or("").to_string(), v.clone());
        }
    }
    let book = flat::unflatten(leaves.iter());
    if flat::sha256_hex(flat::canonical(&book).as_bytes()) != manifest["bookSha256"].as_str().unwrap_or("") {
        return Err("the book rebuilt from this backup does not match the book it was taken from".into());
    }
    let atts: Vec<Value> = serde_json::from_slice(&std::fs::read(dir.join("attachments.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let mut photos = 0;
    for a in atts.iter().filter(|a| a["state"] == "stored") {
        let file = dir.join("attachments").join(format!("{}.{}", a["id"].as_str().unwrap_or(""), a["ext"].as_str().unwrap_or("")));
        let bytes = std::fs::read(&file).map_err(|_| format!("photo {} is missing from the backup", a["id"]))?;
        if flat::sha256_hex(&bytes) != a["sha"].as_str().unwrap_or("") {
            return Err(format!("photo {} in the backup is damaged", a["id"]));
        }
        photos += 1;
    }
    Ok(json!({"verified": true, "leaves": n, "photos": photos, "bookSha256": manifest["bookSha256"], "counts": manifest["counts"]}))
}

/// Build a new hub store from a verified backup, in `new_dir`.
pub fn restore_into(backup: &Path, new_dir: &Path) -> Result<Value, String> {
    let check = verify(backup)?;
    let store = HubStore::open(new_dir)?;
    if store.seq()? > 0 {
        return Err("the restore target is not empty".into());
    }
    let meta: Value = serde_json::from_slice(&std::fs::read(backup.join("meta.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let text = std::fs::read_to_string(backup.join("leaves.jsonl")).map_err(|e| e.to_string())?;
    let rows: Vec<Value> = text.lines().filter(|l| !l.is_empty()).map(|l| serde_json::from_str(l).unwrap_or(Value::Null)).collect();
    store.load_dump(&rows, meta["seq"].as_u64().unwrap_or(0))?;
    for d in serde_json::from_slice::<Vec<crate::store::Device>>(&std::fs::read(backup.join("devices.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())? {
        store.put_device(&d)?;
    }
    for a in serde_json::from_slice::<Vec<Value>>(&std::fs::read(backup.join("attachments.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())? {
        if a["state"] == "stored" {
            let name = format!("{}.{}", a["id"].as_str().unwrap_or(""), a["ext"].as_str().unwrap_or(""));
            std::fs::copy(backup.join("attachments").join(&name), store.att_dir().join(&name)).map_err(|e| e.to_string())?;
        }
        store.put_att_meta(a["id"].as_str().unwrap_or(""), &a)?;
    }
    store.set_meta("shopId", &meta["shopId"])?;
    store.set_meta("shopName", &meta["shopName"])?;
    // a new epoch tells every connected computer to take the restored shop whole
    store.set_meta("epoch", &json!(format!("{}-restored-{}", meta["shopId"].as_str().unwrap_or(""), util::rand_hex(4))))?;
    store.set_meta("initializedAt", &json!(now_iso()))?;
    store.set_meta("restoredFrom", &json!(backup.file_name().map(|n| n.to_string_lossy().to_string())))?;
    let rebuilt = flat::sha256_hex(flat::canonical(&store.book()?).as_bytes());
    if rebuilt != check["bookSha256"].as_str().unwrap_or("") {
        return Err("the restored hub does not match the backup".into());
    }
    Ok(json!({"restored": true, "leaves": check["leaves"], "photos": check["photos"], "bookSha256": rebuilt}))
}
