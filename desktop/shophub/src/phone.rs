//! A phone's seat on the hub.
//!
//! A phone in a browser does not keep its own replica of the shop. The hub
//! keeps one for it: the same `Engine` and `Client` a laptop runs, connected to
//! this hub over the loopback address as that phone's paired device. The phone
//! is the screen for that seat. Every rule a computer follows - a field-level
//! base revision per change, a field changed on two devices asking which to
//! keep, changes held while a popup is open, SYNCED only after the hub has
//! acknowledged - is therefore the same code for a phone, not a second copy of
//! it.
//!
//! The phone reaches its seat over a sealed "screen" connection and asks it the
//! same questions the desktop shell answers for the installed app: open the
//! book, save it, take and confirm other devices' changes, settle a conflict,
//! store and read a photograph. Anything a phone is not allowed to do (provider
//! credentials, backups, pairing) is refused by name.
//!
//! When the phone loses the shop's Wi-Fi its screen keeps the book and the
//! photographs it took, and hands them to the seat when it is back. The seat's
//! idea of what that phone last saw only moves when the phone confirms it, so
//! a phone that was away sends only what it changed, never stale values.

use crate::client::{Client, Emit, Link};
use crate::crypto::{b64, unb64};
use crate::engine::Engine;
use crate::secrets::SecretStore;
use crate::store::Device;
use crate::util;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};

/// The seat logs in to the hub with the secret the hub already holds for that
/// phone; it never stores one of its own.
struct SeatSecrets {
    inner: Arc<dyn SecretStore>,
    device: String,
}

impl SecretStore for SeatSecrets {
    fn put(&self, _name: &str, _secret: &[u8]) -> Result<(), String> {
        Err("a phone's seat does not store secrets".into())
    }
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        if name.ends_with(&format!("/{}", self.device)) {
            self.inner.get(&format!("device/{}", self.device))
        } else {
            Ok(None)
        }
    }
    fn delete(&self, _name: &str) -> Result<(), String> {
        Ok(())
    }
}

pub struct Seat {
    pub device_id: String,
    pub client: Client,
    att_dir: PathBuf,
    hub_att_dir: PathBuf,
    listeners: Arc<Mutex<Vec<Sender<String>>>>,
}

const PHOTO_EXT: &[&str] = &["jpg", "jpeg", "png", "webp", "gif", "pdf"];
const MAX_PHOTO_BYTES: usize = 25 * 1024 * 1024;

impl Seat {
    pub fn open(dir: PathBuf, hub_att_dir: PathBuf, secrets: Arc<dyn SecretStore>, device: &Device, link: Link) -> Result<Arc<Seat>, String> {
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let att_dir = dir.join("attachments");
        std::fs::create_dir_all(&att_dir).map_err(|e| e.to_string())?;
        let engine = Arc::new(Engine::open(&dir.join("replica"))?);
        let listeners: Arc<Mutex<Vec<Sender<String>>>> = Arc::new(Mutex::new(Vec::new()));
        let l2 = listeners.clone();
        let emit: Emit = Arc::new(move |kind: &str, data: Value| {
            let msg = json!({"t": "ev", "kind": kind, "data": data}).to_string();
            l2.lock().unwrap().retain(|tx| tx.send(msg.clone()).is_ok());
        });
        let client = Client::new(engine, Arc::new(SeatSecrets { inner: secrets, device: device.id.clone() }), att_dir.clone(), emit);
        client.set_link(Some(link));
        client.start();
        Ok(Arc::new(Seat { device_id: device.id.clone(), client, att_dir, hub_att_dir, listeners }))
    }

    pub fn listen(&self, tx: Sender<String>) {
        self.listeners.lock().unwrap().push(tx);
    }

    pub fn stop(&self) {
        self.client.stop();
    }

    fn engine(&self) -> &Arc<Engine> {
        &self.client.inner.engine
    }

    fn find_photo(&self, id: &str) -> Option<Vec<u8>> {
        for dir in [&self.att_dir, &self.hub_att_dir] {
            for ext in PHOTO_EXT {
                if let Ok(b) = std::fs::read(dir.join(format!("{id}.{ext}"))) {
                    return Some(b);
                }
            }
        }
        None
    }

    /// One request from the phone's screen.
    pub fn rpc(&self, cmd: &str, a: &Value) -> Result<Value, String> {
        let s = |k: &str| a.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
        let e = self.engine();
        match cmd {
            "db_load" => {
                let text = if e.initialized() { e.book()?.to_string() } else { String::new() };
                Ok(json!({"text": text, "existed": !text.is_empty(), "error": null, "path": "Shop Hub", "sync": "client"}))
            }
            "db_save" => {
                let text = s("text");
                if text.trim().is_empty() {
                    return Err("refusing to write an empty book".into());
                }
                let book: Value = serde_json::from_str(&text).map_err(|x| format!("the book is not valid: {x}"))?;
                if !book.is_object() {
                    return Err("refusing to save something that is not a shop book".into());
                }
                if !e.initialized() {
                    return Err("this phone has not received the shop yet; nothing was saved".into());
                }
                let queued = e.save_book(&book)?;
                Ok(json!({"bytes": text.len(), "path": "Shop Hub", "backup": null, "sync": {"queued": queued, "pending": e.pending_count()}}))
            }
            "db_where" => Ok(json!("Shop Hub")),
            "sync_status" => Ok(json!({"mode": "client", "phone": true, "client": self.client.status(), "numbers": e.numbers()})),
            "sync_take_patches" => Ok(json!(e.take_patches()?)),
            "sync_confirm_patches" => {
                let ids: Vec<String> = serde_json::from_value(a["ids"].clone()).unwrap_or_default();
                e.confirm_patches(&ids).map(|_| json!(true))
            }
            "sync_resolve" => e.resolve(&s("opId"), a["keepMine"].as_bool().unwrap_or(false)).map(|_| json!(true)),
            "sync_presence" => {
                self.client.set_presence(a.get("open").and_then(|x| x.as_str()).map(|x| x.to_string()));
                Ok(json!(true))
            }
            "sync_numbers" => Ok(json!(e.numbers())),
            "sync_use_number" => e.use_number(&s("key"), a["n"].as_u64().unwrap_or(0)).map(|_| json!(true)),
            "sync_att_status" => {
                let mut m = serde_json::Map::new();
                for x in e.att_all() {
                    m.insert(x["id"].as_str().unwrap_or("").to_string(), x["state"].clone());
                }
                Ok(Value::Object(m))
            }
            "att_save" => {
                let ext = s("ext").trim().trim_start_matches('.').to_ascii_lowercase();
                if !PHOTO_EXT.contains(&ext.as_str()) {
                    return Err(format!("{ext} is not a kind of file this keeps"));
                }
                let bytes = unb64(&s("dataB64"))?;
                if bytes.is_empty() {
                    return Err("refusing to store an empty photo".into());
                }
                if bytes.len() > MAX_PHOTO_BYTES {
                    return Err("that photo is larger than 25 MB".into());
                }
                // the id the phone asked for, if it made one while offline and
                // this is it arriving; otherwise a new one
                let wanted = s("id");
                let id = if crate::server::safe_id(&wanted) && wanted.starts_with("att-") { wanted } else { format!("att-{}-{}", util::now_ms(), util::rand_hex(3)) };
                let sha = crate::flat::sha256_hex(&bytes);
                if let Some(have) = self.find_photo(&id) {
                    if crate::flat::sha256_hex(&have) != sha {
                        return Err("a different photo already has that id".into());
                    }
                } else {
                    let tmp = self.att_dir.join(format!("{id}.writing"));
                    std::fs::write(&tmp, &bytes).map_err(|x| x.to_string())?;
                    std::fs::rename(&tmp, self.att_dir.join(format!("{id}.{ext}"))).map_err(|x| x.to_string())?;
                }
                e.att_queue(&id, &json!({"id": id, "ext": ext, "state": "pending", "at": util::now_ms()}))?;
                Ok(json!({"id": id, "file": format!("{id}.{ext}"), "bytes": bytes.len(), "sha256": sha}))
            }
            "att_read" | "att_exists" => {
                let id = s("id");
                if !crate::server::safe_id(&id) {
                    return Err("bad attachment id".into());
                }
                let found = self.find_photo(&id);
                if cmd == "att_exists" {
                    return Ok(json!(found.is_some()));
                }
                found.map(|b| json!(b64(&b))).ok_or_else(|| "The Shop Hub does not have this photo yet.".into())
            }
            "att_delete" => Ok(Value::Null),
            other => Err(format!("{other} is not available on a phone")),
        }
    }
}
