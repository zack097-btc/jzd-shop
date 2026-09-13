//! Everything the desktop app asks of shop sync, in one place, so the Tauri
//! commands and the development harness drive exactly the same code.
//!
//! Modes:
//!   * "local"  - v2.8.2 behaviour, the book is shop.json on this computer;
//!   * "host"   - this computer runs the Shop Hub and also works from it;
//!   * "client" - this computer works from another computer's Shop Hub.

use crate::backup;
use crate::client::{self, Client, Emit, Link};
use crate::engine::Engine;
use crate::secrets::SecretStore;
use crate::server::{Hub, DEFAULT_PORT};
use crate::store::now_iso;
use crate::util;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Config {
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub link: Option<Link>,
    #[serde(default)]
    pub host_device_id: String,
    #[serde(default)]
    pub initialized_at: String,
    #[serde(default)]
    pub migration: Option<Value>,
}

pub struct Options {
    pub data_dir: PathBuf,
    pub att_dir: PathBuf,
    pub secrets: Arc<dyn SecretStore>,
    pub emit: Emit,
    /// Normally 0.0.0.0; the test harness uses 127.0.0.1.
    pub bind_ip: String,
    pub discovery: bool,
}

#[derive(Default, Clone)]
struct JoinState {
    state: String,
    verify: String,
    shop_name: String,
    error: String,
}

pub struct ShopSync {
    o: Options,
    cfg: Mutex<Config>,
    hub: Mutex<Option<Hub>>,
    client: Mutex<Option<Client>>,
    join: Arc<Mutex<JoinState>>,
}

fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

impl ShopSync {
    pub fn open(o: Options) -> Result<Arc<ShopSync>, String> {
        std::fs::create_dir_all(o.data_dir.join("shophub")).map_err(e)?;
        let cfg: Config = std::fs::read_to_string(o.data_dir.join("shophub").join("sync.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let me = Arc::new(ShopSync { o, cfg: Mutex::new(cfg), hub: Mutex::new(None), client: Mutex::new(None), join: Arc::new(Mutex::new(JoinState::default())) });
        me.start()?;
        Ok(me)
    }

    fn hub_dir(&self) -> PathBuf {
        self.o.data_dir.join("shophub").join("hub")
    }
    fn replica_dir(&self) -> PathBuf {
        self.o.data_dir.join("shophub").join("replica")
    }

    fn save_cfg(&self) -> Result<(), String> {
        let cfg = self.cfg.lock().unwrap().clone();
        let p = self.o.data_dir.join("shophub").join("sync.json");
        let tmp = p.with_extension("json.writing");
        std::fs::write(&tmp, serde_json::to_vec_pretty(&cfg).unwrap()).map_err(e)?;
        std::fs::rename(&tmp, &p).map_err(e)
    }

    pub fn mode(&self) -> String {
        let m = self.cfg.lock().unwrap().mode.clone();
        if m.is_empty() {
            "local".into()
        } else {
            m
        }
    }

    fn start(self: &Arc<Self>) -> Result<(), String> {
        let cfg = self.cfg.lock().unwrap().clone();
        match cfg.mode.as_str() {
            "host" => {
                let hub = Hub::open(&self.hub_dir(), self.o.secrets.clone())?;
                let port = if cfg.port == 0 { DEFAULT_PORT } else { cfg.port };
                let bind: SocketAddr = format!("{}:{}", self.o.bind_ip, port).parse().map_err(e)?;
                let addr = hub.serve(bind, self.o.discovery)?;
                self.spawn_daily_backups(hub.clone());
                *self.hub.lock().unwrap() = Some(hub);
                let mut link = cfg.link.clone().ok_or("the host's own link is missing")?;
                link.address = format!("127.0.0.1:{}", addr.port());
                self.start_client(Some(link))?;
            }
            "client" => {
                self.start_client(cfg.link.clone())?;
            }
            _ => {}
        }
        Ok(())
    }

    fn start_client(&self, link: Option<Link>) -> Result<(), String> {
        let engine = Arc::new(Engine::open(&self.replica_dir())?);
        let c = Client::new(engine, self.o.secrets.clone(), self.o.att_dir.clone(), self.o.emit.clone());
        c.set_link(link);
        c.start();
        *self.client.lock().unwrap() = Some(c);
        Ok(())
    }

    fn spawn_daily_backups(&self, hub: Hub) {
        let _ = std::thread::Builder::new().name("shophub-backups".into()).spawn(move || {
            while !hub.stopped() {
                let latest = backup::list(hub.store()).into_iter().find(|b| b["reason"] == "daily");
                let stale = latest.and_then(|b| b["createdAt"].as_str().map(|s| s.to_string())).map(|t| t.get(..10) != Some(&now_iso()[..10])).unwrap_or(true);
                if stale && hub.store().initialized() {
                    let _ = backup::create(hub.store(), "daily");
                }
                for _ in 0..600 {
                    if hub.stopped() {
                        return;
                    }
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
        });
    }

    fn client(&self) -> Option<Client> {
        self.client.lock().unwrap().clone()
    }

    fn engine(&self) -> Result<Arc<Engine>, String> {
        self.client().map(|c| c.inner.engine.clone()).ok_or_else(|| "shop sync is not running".into())
    }

    // ---------------- the book

    /// The book this computer's screen should open, or None in local mode.
    pub fn load_book(&self) -> Result<Option<String>, String> {
        if self.mode() == "local" {
            return Ok(None);
        }
        let engine = self.engine()?;
        if !engine.initialized() {
            return Ok(Some(String::new()));
        }
        Ok(Some(engine.book()?.to_string()))
    }

    pub fn save_book(&self, text: &str) -> Result<Value, String> {
        let book: Value = serde_json::from_str(text).map_err(|e| format!("the book is not valid: {e}"))?;
        if !book.is_object() {
            return Err("refusing to save something that is not a shop book".into());
        }
        let engine = self.engine()?;
        if !engine.initialized() {
            return Err("this computer has not received the shop from the Shop Hub yet; nothing was saved".into());
        }
        let queued = engine.save_book(&book)?;
        Ok(json!({"queued": queued, "pending": engine.pending_count()}))
    }

    pub fn take_patches(&self) -> Result<Value, String> {
        Ok(json!(self.engine()?.take_patches()?))
    }

    pub fn confirm_patches(&self, ids: &[String]) -> Result<(), String> {
        self.engine()?.confirm_patches(ids)
    }

    pub fn resolve(&self, op_id: &str, keep_mine: bool) -> Result<(), String> {
        self.engine()?.resolve(op_id, keep_mine)
    }

    pub fn numbers(&self) -> Value {
        self.engine().map(|e| json!(e.numbers())).unwrap_or(json!({}))
    }

    pub fn use_number(&self, key: &str, n: u64) -> Result<(), String> {
        self.engine()?.use_number(key, n)
    }

    pub fn presence(&self, open: Option<String>) {
        if let Some(c) = self.client() {
            c.set_presence(open);
        }
    }

    // ---------------- status

    pub fn status(&self) -> Value {
        let cfg = self.cfg.lock().unwrap().clone();
        let mut out = json!({"mode": self.mode(), "port": if cfg.port == 0 { DEFAULT_PORT } else { cfg.port }, "initializedAt": cfg.initialized_at, "migration": cfg.migration});
        if let Some(c) = self.client() {
            out["client"] = c.status();
            out["numbers"] = json!(c.inner.engine.numbers());
        }
        if let Some(hub) = self.hub.lock().unwrap().clone() {
            let store = hub.store();
            let atts = store.att_all().unwrap_or_default();
            let backups = backup::list(store);
            out["hub"] = json!({
                "running": true, "address": hub.inner.addr.lock().unwrap().map(|a| a.to_string()), "addresses": local_addresses(),
                "shopId": store.shop_id(), "shopName": hub.shop_name(), "schema": crate::store::SCHEMA_VERSION, "seq": store.seq().unwrap_or(0),
                "fields": store.leaves().map(|l| l.len()).unwrap_or(0), "devices": hub.devices(), "connected": hub.connected_count(),
                "photosStored": atts.iter().filter(|a| a["state"] == "stored").count(), "lastBackup": backups.first().cloned(),
                "pairing": hub.pairing_code().map(|(c, exp)| json!({"code": format!("{} {}", &c[..3], &c[3..]), "expiresMs": exp})),
                "pairRequests": hub.pair_requests(), "backupsDir": backup::backups_dir(store).display().to_string()
            });
        }
        let j = self.join.lock().unwrap().clone();
        if !j.state.is_empty() {
            out["join"] = json!({"state": j.state, "verify": j.verify, "shopName": j.shop_name, "error": j.error});
        }
        out
    }

    // ---------------- becoming the host

    /// Turn this computer's local book into the Shop Hub. In order: back up
    /// the book and photos, validate, import, prove the import, and only then
    /// switch this computer over. The original shop.json is never touched.
    pub fn host_enable(self: &Arc<Self>, book_text: &str, shop_name: &str, device_name: &str, port: u16) -> Result<Value, String> {
        if self.mode() != "local" {
            return Err("this computer is already part of a Shop Hub".into());
        }
        let stamp = now_iso().replace(':', "").replace('-', "");
        // 1. automatic backup of the local book and photographs
        let pre = self.o.data_dir.join("shophub").join("pre-hub-backup").join(&stamp);
        std::fs::create_dir_all(pre.join("attachments")).map_err(e)?;
        std::fs::write(pre.join("shop.json"), book_text).map_err(e)?;
        let mut local_photos = Vec::new();
        if let Ok(rd) = std::fs::read_dir(&self.o.att_dir) {
            for f in rd.filter_map(|x| x.ok()) {
                let name = f.file_name().to_string_lossy().to_string();
                let Some((id, ext)) = name.rsplit_once('.') else { continue };
                if !crate::server::safe_id(id) || !["jpg", "jpeg", "png", "webp", "gif", "pdf", "txt"].contains(&ext) {
                    continue;
                }
                let bytes = std::fs::read(f.path()).map_err(e)?;
                std::fs::write(pre.join("attachments").join(&name), &bytes).map_err(e)?;
                local_photos.push((id.to_string(), ext.to_string(), bytes));
            }
        }
        // 2. validate
        let book: Value = serde_json::from_str(book_text).map_err(|x| format!("the local book is not valid, so nothing was changed: {x}"))?;
        if !book.is_object() || book.get("settings").is_none() {
            return Err("the local book does not look like a shop book, so nothing was changed".into());
        }
        // 3. import, proved
        if self.hub_dir().exists() {
            let aside = self.o.data_dir.join("shophub").join(format!("hub-unfinished-{stamp}"));
            std::fs::rename(self.hub_dir(), aside).map_err(e)?;
        }
        let hub = Hub::open(&self.hub_dir(), self.o.secrets.clone())?;
        let mut report = hub.store().import_book(&book, "host")?;
        // photographs into the hub, each checked
        for (id, ext, bytes) in &local_photos {
            let dest = hub.store().att_dir().join(format!("{id}.{ext}"));
            std::fs::write(&dest, bytes).map_err(e)?;
            let sha = crate::flat::sha256_hex(bytes);
            if crate::flat::sha256_hex(&std::fs::read(&dest).map_err(e)?) != sha {
                return Err(format!("photo {id} did not copy cleanly; the shop was not switched over"));
            }
            hub.store().put_att_meta(id, &json!({"id": id, "ext": ext, "sha": sha, "size": bytes.len(), "state": "stored", "by": "host", "at": now_iso()}))?;
            report.attachments += 1;
            report.attachments_bytes += bytes.len() as u64;
        }
        let shop_id = format!("shop-{}", util::rand_hex(8));
        hub.store().mark_initialized(&shop_id, shop_name, &report)?;
        let first_backup = backup::create(hub.store(), "pre-first-use")?;
        backup::verify(&PathBuf::from(first_backup["path"].as_str().unwrap_or("")))?;
        // 4. this computer's own connection
        let device_name = if device_name.trim().is_empty() { "Office Desktop" } else { device_name.trim() };
        let (dev_id, secret) = hub.register_local_device(device_name)?;
        self.o.secrets.put(&format!("shop/{shop_id}/{dev_id}"), &secret)?;
        let engine = Engine::open(&self.replica_dir())?;
        let (_, seq, snap) = hub.store().changes_since(0)?;
        engine.adopt_snapshot(&snap, seq, &hub.store().epoch())?;
        for (id, ext, bytes) in &local_photos {
            engine.att_queue(id, &json!({"id": id, "ext": ext, "sha": crate::flat::sha256_hex(bytes), "size": bytes.len(), "state": "synced"}))?;
        }
        if crate::flat::canonical(&engine.book()?) != crate::flat::canonical(&book) {
            return Err("this computer's copy does not match the imported shop; not switched over".into());
        }
        drop(engine);
        drop(hub);
        // 5. only now mark it initialised and switch over
        {
            let mut cfg = self.cfg.lock().unwrap();
            cfg.mode = "host".into();
            cfg.port = if port == 0 { DEFAULT_PORT } else { port };
            cfg.host_device_id = dev_id.clone();
            cfg.link = Some(Link { address: String::new(), device_id: dev_id, shop_id: shop_id.clone(), shop_name: shop_name.into(), device_name: device_name.into() });
            cfg.initialized_at = now_iso();
            cfg.migration = Some(json!({"report": report, "preBackup": pre.display().to_string(), "firstHubBackup": first_backup}));
        }
        self.save_cfg()?;
        self.start()?;
        Ok(json!({"shopId": shop_id, "report": report, "preBackup": pre.display().to_string(), "firstHubBackup": first_backup}))
    }

    // ---------------- pairing

    fn hub(&self) -> Result<Hub, String> {
        self.hub.lock().unwrap().clone().ok_or_else(|| "this computer is not the Shop Hub".into())
    }

    pub fn pairing_open(&self) -> Result<Value, String> {
        let hub = self.hub()?;
        let code = hub.open_pairing(10);
        Ok(json!({"code": format!("{} {}", &code[..3], &code[3..]), "raw": code, "minutes": 10}))
    }

    pub fn pairing_close(&self) -> Result<(), String> {
        self.hub()?.close_pairing();
        Ok(())
    }

    pub fn pairing_decide(&self, id: &str, approve: bool) -> Result<(), String> {
        self.hub()?.decide_pairing(id, approve)
    }

    pub fn revoke(&self, device_id: &str) -> Result<(), String> {
        self.hub()?.revoke(device_id)
    }

    pub fn discover(&self) -> Vec<Value> {
        client::discover(Duration::from_millis(1500))
    }

    /// Join another computer's Shop Hub. Returns at once; progress is in
    /// status().join.
    pub fn join_begin(self: &Arc<Self>, address: &str, code: &str, device_name: &str) -> Result<(), String> {
        if self.mode() != "local" {
            return Err("this computer is already part of a Shop Hub".into());
        }
        let address = if address.contains(':') { address.to_string() } else { format!("{address}:{DEFAULT_PORT}") };
        *self.join.lock().unwrap() = JoinState { state: "connecting".into(), ..Default::default() };
        let me = self.clone();
        let (code, name) = (code.to_string(), device_name.to_string());
        std::thread::spawn(move || {
            let join = me.join.clone();
            let on_verify = move |v: &str, shop: &str| {
                let mut j = join.lock().unwrap();
                j.state = "verify".into();
                j.verify = v.into();
                j.shop_name = shop.into();
            };
            match client::pair(&address, &code, &name, me.o.secrets.as_ref(), &on_verify) {
                Ok(link) => {
                    let replica = me.replica_dir();
                    if replica.exists() {
                        let aside = me.o.data_dir.join("shophub").join(format!("replica-old-{}", util::rand_hex(3)));
                        let _ = std::fs::rename(&replica, aside);
                    }
                    {
                        let mut cfg = me.cfg.lock().unwrap();
                        cfg.mode = "client".into();
                        cfg.link = Some(link);
                        cfg.initialized_at = now_iso();
                    }
                    let r = me.save_cfg().and_then(|_| me.start());
                    let mut j = me.join.lock().unwrap();
                    match r {
                        Ok(()) => j.state = "approved".into(),
                        Err(x) => {
                            j.state = "failed".into();
                            j.error = x;
                        }
                    }
                    drop(j);
                    (me.o.emit)("status", me.status());
                }
                Err(x) => {
                    let mut j = me.join.lock().unwrap();
                    j.state = "failed".into();
                    j.error = x;
                }
            }
        });
        Ok(())
    }

    // ---------------- backups

    pub fn backup_now(&self) -> Result<Value, String> {
        let hub = self.hub()?;
        let b = backup::create(hub.store(), "manual")?;
        let v = backup::verify(&PathBuf::from(b["path"].as_str().unwrap_or("")))?;
        Ok(json!({"backup": b, "verify": v}))
    }

    pub fn backups(&self) -> Result<Value, String> {
        Ok(json!(backup::list(self.hub()?.store())))
    }

    pub fn verify_backup(&self, name: &str) -> Result<Value, String> {
        let hub = self.hub()?;
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            return Err("bad backup name".into());
        }
        backup::verify(&backup::backups_dir(hub.store()).join(name))
    }

    pub fn backups_dir(&self) -> Result<String, String> {
        Ok(backup::backups_dir(self.hub()?.store()).display().to_string())
    }

    /// Replace the hub with a verified backup. A backup of the current hub is
    /// taken first, and the current store is kept aside, not deleted.
    pub fn restore_backup(self: &Arc<Self>, name: &str) -> Result<Value, String> {
        let hub = self.hub()?;
        if name.contains('/') || name.contains('\\') || name.contains("..") {
            return Err("bad backup name".into());
        }
        let src = backup::backups_dir(hub.store()).join(name);
        backup::verify(&src)?;
        backup::create(hub.store(), "pre-restore")?;
        let tmp = self.o.data_dir.join("shophub").join(format!("hub-restoring-{}", util::rand_hex(3)));
        let result = backup::restore_into(&src, &tmp)?;
        drop(hub);
        self.shutdown();
        let aside = self.o.data_dir.join("shophub").join(format!("hub-replaced-{}", now_iso().replace(':', "")));
        std::fs::rename(self.hub_dir(), &aside).map_err(|x| format!("could not move the current hub aside: {x}"))?;
        std::fs::rename(&tmp, self.hub_dir()).map_err(e)?;
        self.start()?;
        Ok(json!({"restore": result, "previousHubKeptAt": aside.display().to_string()}))
    }

    // ---------------- photographs

    pub fn att_saved(&self, id: &str, ext: &str) -> Result<(), String> {
        if self.mode() == "local" {
            return Ok(());
        }
        self.engine()?.att_queue(id, &json!({"id": id, "ext": ext, "state": "pending", "at": util::now_ms()}))
    }

    pub fn att_fetch(&self, id: &str) -> Result<Vec<u8>, String> {
        let c = self.client().ok_or("shop sync is not running")?;
        c.fetch_attachment(id, Duration::from_secs(60))
    }

    pub fn att_status(&self) -> Value {
        let Ok(engine) = self.engine() else { return json!({}) };
        let mut m = serde_json::Map::new();
        for a in engine.att_all() {
            m.insert(a["id"].as_str().unwrap_or("").to_string(), a["state"].clone());
        }
        Value::Object(m)
    }

    /// Stop the hub and the connection, and wait until every thread has let go
    /// of the databases, so they can be opened again straight away.
    /// Development harness only.
    pub fn debug_pause(&self, on: bool) {
        if let Some(c) = self.client() {
            c.set_paused(on);
        }
    }

    pub fn shutdown(&self) {
        let hub = self.hub.lock().unwrap().take();
        let client = self.client.lock().unwrap().take();
        if let Some(h) = &hub {
            h.stop();
        }
        if let Some(c) = &client {
            c.stop();
        }
        let until = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < until {
            let hub_free = hub.as_ref().map(|h| Arc::strong_count(&h.inner) <= 1).unwrap_or(true);
            let client_free = client.as_ref().map(|c| Arc::strong_count(&c.inner) <= 1 && Arc::strong_count(&c.inner.engine) <= 1).unwrap_or(true);
            if hub_free && client_free {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// This computer's addresses on private networks, for the host screen.
pub fn local_addresses() -> Vec<String> {
    let mut out = Vec::new();
    // the address the operating system would use to reach a private network
    for probe in ["192.168.0.1:9", "10.0.0.1:9", "172.16.0.1:9"] {
        if let Ok(s) = std::net::UdpSocket::bind("0.0.0.0:0") {
            if s.connect(probe).is_ok() {
                if let Ok(a) = s.local_addr() {
                    let ip = a.ip();
                    if util::private_peer(&ip) && !ip.is_loopback() && !out.contains(&ip.to_string()) {
                        out.push(ip.to_string());
                    }
                }
            }
        }
    }
    out
}
