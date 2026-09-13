//! A computer's connection to the Shop Hub.
//!
//! One background thread per computer. It connects, proves who it is, sends
//! whatever is queued, receives what other computers change, moves photos in
//! both directions a piece at a time, and reconnects on its own when the
//! network drops. It never reports SYNCED for a change the hub has not
//! acknowledged.

use crate::crypto::{self, b64, unb64, Session};
use crate::engine::Engine;
use crate::secrets::SecretStore;
use crate::server::{ws_config, ATT_CHUNK, DISCOVER_PROBE, DISCOVERY_PORT};
use crate::store::{Change, OpResult};
use crate::util;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{TcpStream, ToSocketAddrs, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket};

pub type Emit = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Link {
    pub address: String,
    pub device_id: String,
    pub shop_id: String,
    pub shop_name: String,
    pub device_name: String,
}

#[derive(Default)]
struct St {
    online: bool,
    hub_name: String,
    last_error: String,
    last_ack_ms: u64,
    last_heard_ms: u64,
    connected_ms: u64,
    devices: Vec<Value>,
    presence: Option<String>,
    presence_dirty: bool,
    downloads: HashMap<String, (Vec<Sender<Result<Vec<u8>, String>>>, Vec<u8>)>,
    uploading: Option<String>,
    upload_error: String,
    latency_ms: u64,
}

pub struct ClientInner {
    pub engine: Arc<Engine>,
    secrets: Arc<dyn SecretStore>,
    link: Mutex<Option<Link>>,
    st: Mutex<St>,
    emit: Emit,
    stop: AtomicBool,
    /// Development harness only: behave as if the network cable were pulled.
    paused: AtomicBool,
    att_dir: PathBuf,
}

#[derive(Clone)]
pub struct Client {
    pub inner: Arc<ClientInner>,
}

type Ws = WebSocket<TcpStream>;

fn is_timeout(e: &tungstenite::Error) -> bool {
    matches!(e, tungstenite::Error::Io(io) if io.kind() == std::io::ErrorKind::WouldBlock || io.kind() == std::io::ErrorKind::TimedOut)
}

fn ws_connect(address: &str) -> Result<Ws, String> {
    let addr = address
        .to_socket_addrs()
        .map_err(|e| format!("cannot find the Shop Hub at {address}: {e}"))?
        .next()
        .ok_or_else(|| format!("cannot find the Shop Hub at {address}"))?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_secs(4)).map_err(|e| format!("SHOP HUB OFFLINE — cannot reach {address}: {e}"))?;
    let _ = stream.set_nodelay(true);
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let url = format!("ws://{address}/shophub");
    let (ws, _) = tungstenite::client::client_with_config(url, stream, Some(ws_config())).map_err(|e| format!("the Shop Hub did not answer properly: {e}"))?;
    Ok(ws)
}

/// Find Shop Hubs on this network. Returns what answered within `wait`.
pub fn discover(wait: Duration) -> Vec<Value> {
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0") else { return vec![] };
    let _ = sock.set_broadcast(true);
    let _ = sock.set_read_timeout(Some(Duration::from_millis(200)));
    let _ = sock.send_to(DISCOVER_PROBE, ("255.255.255.255", DISCOVERY_PORT));
    let _ = sock.send_to(DISCOVER_PROBE, ("127.0.0.1", DISCOVERY_PORT));
    let start = Instant::now();
    let mut out: Vec<Value> = Vec::new();
    let mut buf = [0u8; 512];
    while start.elapsed() < wait {
        if let Ok((n, from)) = sock.recv_from(&mut buf) {
            if let Ok(mut v) = serde_json::from_slice::<Value>(&buf[..n]) {
                if v["jzdShopHub"] == 1 {
                    let port = v["port"].as_u64().unwrap_or(0);
                    v["address"] = json!(format!("{}:{}", from.ip(), port));
                    if !out.iter().any(|o| o["address"] == v["address"]) {
                        out.push(v);
                    }
                }
            }
        }
    }
    out
}

/// Pairing, from the new computer's side. `on_verify` is called with the six
/// digits the person must see on the host too; the call returns once the host
/// approves or refuses.
pub fn pair(address: &str, code: &str, device_name: &str, secrets: &dyn SecretStore, on_verify: &dyn Fn(&str, &str)) -> Result<Link, String> {
    let mut ws = ws_connect(address)?;
    let keys = crypto::pair_keys();
    let client_pub = keys.public.clone();
    ws.send(Message::Text(json!({"t": "pair1", "code": code.trim().replace(' ', ""), "pk": b64(&client_pub), "name": device_name}).to_string()))
        .map_err(|e| e.to_string())?;
    let msg = read_text(&mut ws, Duration::from_secs(10))?;
    if msg["t"] == "pair-refused" {
        return Err(msg["why"].as_str().unwrap_or("the Shop Hub refused").to_string());
    }
    if msg["t"] != "pair2" {
        return Err("the Shop Hub answered unexpectedly".into());
    }
    let host_pub = unb64(msg["pk"].as_str().unwrap_or(""))?;
    let shop = msg["shop"].as_str().unwrap_or("").to_string();
    let shop_name = msg["shopName"].as_str().unwrap_or("").to_string();
    let paired = crypto::pair_finish(keys, &host_pub, &client_pub, &host_pub)?;
    on_verify(&paired.verify, &shop_name);
    let msg = read_text(&mut ws, Duration::from_secs(310))?;
    match msg["t"].as_str() {
        Some("pair-ok") => {
            let device = msg["device"].as_str().unwrap_or("").to_string();
            let mac = unb64(msg["mac"].as_str().unwrap_or(""))?;
            if !crypto::mac_eq(&paired.device_secret, &[b"paired", device.as_bytes(), shop.as_bytes()], &mac) {
                return Err("the Shop Hub's approval could not be verified; nothing was saved".into());
            }
            secrets.put(&format!("shop/{shop}/{device}"), &paired.device_secret)?;
            Ok(Link { address: address.into(), device_id: device, shop_id: shop, shop_name, device_name: device_name.into() })
        }
        Some("pair-refused") => Err(msg["why"].as_str().unwrap_or("refused").to_string()),
        _ => Err("pairing did not finish".into()),
    }
}

fn read_text(ws: &mut Ws, wait: Duration) -> Result<Value, String> {
    let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(250)));
    let start = Instant::now();
    loop {
        match ws.read() {
            Ok(Message::Text(t)) => return serde_json::from_str(&t).map_err(|e| e.to_string()),
            Ok(Message::Close(_)) => return Err("the Shop Hub closed the connection".into()),
            Ok(_) => {}
            Err(ref e) if is_timeout(e) => {
                if start.elapsed() > wait {
                    return Err("the Shop Hub did not answer in time".into());
                }
            }
            Err(e) => return Err(format!("connection to the Shop Hub failed: {e}")),
        }
    }
}

impl Client {
    pub fn new(engine: Arc<Engine>, secrets: Arc<dyn SecretStore>, att_dir: PathBuf, emit: Emit) -> Client {
        Client { inner: Arc::new(ClientInner { engine, secrets, link: Mutex::new(None), st: Mutex::new(St::default()), emit, stop: AtomicBool::new(false), paused: AtomicBool::new(false), att_dir }) }
    }

    pub fn set_link(&self, link: Option<Link>) {
        *self.inner.link.lock().unwrap() = link;
    }

    pub fn link(&self) -> Option<Link> {
        self.inner.link.lock().unwrap().clone()
    }

    pub fn start(&self) {
        let me = self.clone();
        let _ = std::thread::Builder::new().name("shophub-client".into()).spawn(move || me.run());
    }

    pub fn stop(&self) {
        self.inner.stop.store(true, Ordering::Relaxed);
    }

    pub fn set_paused(&self, on: bool) {
        self.inner.paused.store(on, Ordering::Relaxed);
    }

    pub fn online(&self) -> bool {
        self.inner.st.lock().unwrap().online
    }

    pub fn set_presence(&self, open: Option<String>) {
        let mut st = self.inner.st.lock().unwrap();
        st.presence = open;
        st.presence_dirty = true;
    }

    pub fn status(&self) -> Value {
        let st = self.inner.st.lock().unwrap();
        let link = self.link();
        let e = &self.inner.engine;
        let atts = e.att_all();
        let uploading = atts.iter().filter(|a| a["state"] != "synced").count();
        let conflicts = e.conflicts().unwrap_or_default();
        json!({
            "online": st.online, "hubName": st.hub_name, "lastError": st.last_error,
            "lastAckMs": st.last_ack_ms, "lastHeardMs": st.last_heard_ms, "connectedMs": st.connected_ms,
            "pending": e.pending_count(), "pendingOps": e.pending_ops(), "conflicts": conflicts, "devices": st.devices,
            "deviceId": link.as_ref().map(|l| l.device_id.clone()).unwrap_or_default(),
            "deviceName": link.as_ref().map(|l| l.device_name.clone()).unwrap_or_default(),
            "shopId": link.as_ref().map(|l| l.shop_id.clone()).unwrap_or_default(),
            "shopName": link.as_ref().map(|l| l.shop_name.clone()).unwrap_or_default(),
            "address": link.as_ref().map(|l| l.address.clone()).unwrap_or_default(),
            "photosWaiting": uploading, "uploading": st.uploading, "uploadError": st.upload_error,
            "lastSeq": e.last_seq(), "latencyMs": st.latency_ms
        })
    }

    /// Fetch a photograph this computer does not have from the hub.
    pub fn fetch_attachment(&self, id: &str, wait: Duration) -> Result<Vec<u8>, String> {
        if !self.online() {
            return Err("SHOP HUB OFFLINE — this photo is not on this computer yet".into());
        }
        let (tx, rx) = channel();
        {
            let mut st = self.inner.st.lock().unwrap();
            st.downloads.entry(id.to_string()).or_insert_with(|| (Vec::new(), Vec::new())).0.push(tx);
        }
        rx.recv_timeout(wait).map_err(|_| "the photo did not arrive from the Shop Hub in time".to_string())?
    }

    fn set_offline(&self, why: &str) {
        let changed;
        {
            let mut st = self.inner.st.lock().unwrap();
            changed = st.online || st.last_error != why;
            st.online = false;
            st.last_error = why.into();
            st.uploading = None;
            for (_, (waiters, _)) in st.downloads.drain() {
                for w in waiters {
                    let _ = w.send(Err("SHOP HUB OFFLINE".into()));
                }
            }
        }
        if changed {
            (self.inner.emit)("status", self.status());
        }
    }

    fn run(&self) {
        let mut backoff = 500u64;
        while !self.inner.stop.load(Ordering::Relaxed) {
            let Some(link) = self.link() else {
                std::thread::sleep(Duration::from_millis(300));
                continue;
            };
            if self.inner.paused.load(Ordering::Relaxed) {
                self.set_offline("SHOP HUB OFFLINE — the network is unplugged");
                std::thread::sleep(Duration::from_millis(100));
                continue;
            }
            match self.session(&link) {
                Ok(()) => backoff = 500,
                Err(e) => {
                    self.set_offline(&e);
                    backoff = (backoff * 2).min(4000);
                }
            }
            let until = Instant::now() + Duration::from_millis(backoff);
            while Instant::now() < until && !self.inner.stop.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    fn session(&self, link: &Link) -> Result<(), String> {
        let secret = self
            .inner
            .secrets
            .get(&format!("shop/{}/{}", link.shop_id, link.device_id))?
            .ok_or("this computer's pairing credential is missing; pair it with the Shop Hub again")?;
        let mut ws = ws_connect(&link.address)?;
        let nonce_c = crypto::new_nonce();
        let mac = crypto::hmac(&secret, &[b"hello", link.device_id.as_bytes(), &nonce_c]);
        ws.send(Message::Text(json!({"t": "hello", "v": 1, "device": link.device_id, "nonce": b64(&nonce_c), "mac": b64(&mac)}).to_string())).map_err(|e| e.to_string())?;
        let w = read_text(&mut ws, Duration::from_secs(10))?;
        if w["t"] == "denied" {
            return Err(w["why"].as_str().unwrap_or("the Shop Hub refused this computer").to_string());
        }
        let nonce_s = unb64(w["nonce"].as_str().unwrap_or(""))?;
        let shop = w["shop"].as_str().unwrap_or("");
        let wmac = unb64(w["mac"].as_str().unwrap_or(""))?;
        if shop != link.shop_id || !crypto::mac_eq(&secret, &[b"welcome", &nonce_c, &nonce_s, shop.as_bytes()], &wmac) {
            return Err("that address answered, but it is not this shop's Shop Hub".into());
        }
        let epoch = w["epoch"].as_str().unwrap_or("").to_string();
        let mut sess = Session::new(&secret, &nonce_c, &nonce_s, true);
        let engine = self.inner.engine.clone();
        engine.requeue_sent()?;
        let mut since = engine.last_seq();
        let known_epoch = engine.meta("epoch").and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_default();
        if !engine.initialized() || known_epoch != epoch {
            since = 0;
        }
        let send = |ws: &mut Ws, sess: &mut Session, v: Value| -> Result<(), String> { ws.send(Message::Binary(sess.seal(v.to_string().as_bytes()))).map_err(|e| format!("lost the Shop Hub: {e}")) };
        send(&mut ws, &mut sess, json!({"t": "sync", "since": since}))?;
        send(&mut ws, &mut sess, json!({"t": "devices"}))?;
        {
            let mut st = self.inner.st.lock().unwrap();
            st.online = true;
            st.last_error.clear();
            st.hub_name = w["shopName"].as_str().unwrap_or("").to_string();
            st.connected_ms = util::now_ms();
            st.last_heard_ms = util::now_ms();
            st.presence_dirty = true;
        }
        (self.inner.emit)("status", self.status());
        let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(15)));
        let mut full_parts: Vec<Change> = Vec::new();
        let mut inflight_ops: Option<Instant> = None;
        let mut inflight_reserve: HashMap<String, Instant> = HashMap::new();
        let mut last_ping = Instant::now();
        let mut ping_sent_at: Option<Instant> = None;
        let mut upload: Option<(String, u64, Vec<u8>, String, String)> = None; // id, offset, bytes, ext, sha
        let mut downloading: Option<String> = None;
        let mut snapshot_done = false;
        loop {
            if self.inner.stop.load(Ordering::Relaxed) {
                let _ = ws.close(None);
                return Ok(());
            }
            if self.inner.paused.load(Ordering::Relaxed) {
                let _ = ws.get_ref().shutdown(std::net::Shutdown::Both);
                return Err("SHOP HUB OFFLINE — the network is unplugged".into());
            }
            // ---- read everything waiting
            loop {
                match ws.read() {
                    Ok(Message::Binary(frame)) => {
                        let plain = sess.open(&frame)?;
                        let msg: Value = serde_json::from_slice(&plain).map_err(|e| e.to_string())?;
                        {
                            let mut st = self.inner.st.lock().unwrap();
                            st.last_heard_ms = util::now_ms();
                        }
                        match msg["t"].as_str().unwrap_or("") {
                            "changes" => {
                                let full = msg["full"].as_bool().unwrap_or(false);
                                let to = msg["to"].as_u64().unwrap_or(0);
                                let part: Vec<Change> = serde_json::from_value(msg["c"].clone()).unwrap_or_default();
                                if full {
                                    full_parts.extend(part);
                                    if !msg["last"].as_bool().unwrap_or(true) {
                                        continue;
                                    }
                                    let all = std::mem::take(&mut full_parts);
                                    if !engine.initialized() {
                                        engine.adopt_snapshot(&all, to, &epoch)?;
                                        (self.inner.emit)("reload", json!({"reason": "joined"}));
                                    } else {
                                        engine.on_changes(true, to, &all)?;
                                        engine.set_meta("epoch", &json!(epoch))?;
                                        (self.inner.emit)("patches", json!({"full": true}));
                                    }
                                    snapshot_done = true;
                                } else {
                                    let n = engine.on_changes(false, to, &part)?;
                                    snapshot_done = true;
                                    if n > 0 {
                                        let devices: Vec<String> = part.iter().map(|c| c.d.clone()).collect();
                                        (self.inner.emit)("patches", json!({"waiting": n, "from": devices}));
                                    }
                                }
                            }
                            "acks" => {
                                let res: Vec<OpResult> = serde_json::from_value(msg["res"].clone()).unwrap_or_default();
                                let conflicts = engine.on_results(&res)?;
                                let merged = res.iter().any(|r| matches!(r, OpResult::Merged { .. }));
                                inflight_ops = None;
                                {
                                    let mut st = self.inner.st.lock().unwrap();
                                    st.last_ack_ms = util::now_ms();
                                }
                                if !conflicts.is_empty() {
                                    (self.inner.emit)("conflicts", json!(engine.conflicts()?));
                                }
                                if merged {
                                    (self.inner.emit)("patches", json!({"merged": true}));
                                }
                                (self.inner.emit)("status", self.status());
                            }
                            "reserved" => {
                                let key = msg["key"].as_str().unwrap_or("").to_string();
                                engine.add_number_block(&key, msg["start"].as_u64().unwrap_or(0), msg["count"].as_u64().unwrap_or(0))?;
                                inflight_reserve.remove(&key);
                                (self.inner.emit)("numbers", json!(engine.numbers()));
                            }
                            "presence" => {
                                let devices = msg["devices"].as_array().cloned().unwrap_or_default();
                                self.inner.st.lock().unwrap().devices = devices;
                                (self.inner.emit)("presence", self.status()["devices"].clone());
                            }
                            "pong" => {
                                if let Some(t) = ping_sent_at.take() {
                                    self.inner.st.lock().unwrap().latency_ms = t.elapsed().as_millis() as u64;
                                }
                            }
                            "attStat" | "attAck" => {
                                if let Some(u) = upload.as_mut() {
                                    if msg["id"] == u.0.as_str() {
                                        if msg["done"].as_bool().unwrap_or(false) {
                                            engine.att_queue(&u.0, &json!({"id": u.0, "ext": u.3, "sha": u.4, "size": u.2.len(), "state": "synced", "at": util::now_ms()}))?;
                                            let id = u.0.clone();
                                            upload = None;
                                            let mut st = self.inner.st.lock().unwrap();
                                            st.uploading = None;
                                            st.upload_error.clear();
                                            drop(st);
                                            (self.inner.emit)("photo", json!({"id": id, "state": "synced"}));
                                        } else {
                                            u.1 = msg["have"].as_u64().unwrap_or(0);
                                            let why = msg["why"].as_str().unwrap_or("");
                                            if !why.is_empty() && why != "resume" {
                                                self.inner.st.lock().unwrap().upload_error = why.to_string();
                                            }
                                            if msg["ok"] == false && msg["t"] == "attAck" && why != "resume" && why.contains("bad") {
                                                // a file the hub will never accept: stop retrying it
                                                engine.att_queue(&u.0, &json!({"id": u.0, "ext": u.3, "sha": u.4, "size": u.2.len(), "state": "refused", "why": why}))?;
                                                upload = None;
                                            } else {
                                                let off = u.1 as usize;
                                                let end = (off + ATT_CHUNK).min(u.2.len());
                                                send(&mut ws, &mut sess, json!({"t": "attPut", "id": u.0, "ext": u.3, "sha": u.4, "size": u.2.len(), "off": off, "data": b64(&u.2[off..end])}))?;
                                            }
                                        }
                                    }
                                }
                            }
                            "attData" => {
                                let id = msg["id"].as_str().unwrap_or("").to_string();
                                let mut st = self.inner.st.lock().unwrap();
                                if let Some(err) = msg["error"].as_str() {
                                    if let Some((waiters, _)) = st.downloads.remove(&id) {
                                        for w in waiters {
                                            let _ = w.send(Err(err.to_string()));
                                        }
                                    }
                                    downloading = None;
                                } else if let Some(entry) = st.downloads.get_mut(&id) {
                                    let data = unb64(msg["data"].as_str().unwrap_or("")).unwrap_or_default();
                                    entry.1.extend_from_slice(&data);
                                    if msg["last"].as_bool().unwrap_or(true) {
                                        let (waiters, bytes) = st.downloads.remove(&id).unwrap();
                                        drop(st);
                                        downloading = None;
                                        let result = if crate::flat::sha256_hex(&bytes) == msg["sha"].as_str().unwrap_or("") {
                                            let ext = msg["ext"].as_str().unwrap_or("bin");
                                            let _ = store_local(&self.inner.att_dir, &id, ext, &bytes);
                                            Ok(bytes)
                                        } else {
                                            Err("the photo arrived damaged (checksum mismatch)".to_string())
                                        };
                                        for w in waiters {
                                            let _ = w.send(result.clone());
                                        }
                                    } else {
                                        let off = entry.1.len();
                                        drop(st);
                                        send(&mut ws, &mut sess, json!({"t": "attGet", "id": id, "off": off}))?;
                                    }
                                }
                            }
                            "error" => {
                                self.inner.st.lock().unwrap().last_error = msg["why"].as_str().unwrap_or("").to_string();
                                inflight_ops = None;
                            }
                            _ => {}
                        }
                    }
                    Ok(Message::Close(_)) => return Err("SHOP HUB OFFLINE — the hub closed the connection".into()),
                    Ok(_) => {}
                    Err(ref e) if is_timeout(e) => break,
                    Err(e) => return Err(format!("SHOP HUB OFFLINE — {e}")),
                }
            }
            // ---- send what is waiting
            if snapshot_done && inflight_ops.map(|t| t.elapsed() > Duration::from_secs(30)).unwrap_or(true) {
                if inflight_ops.is_some() {
                    return Err("the Shop Hub stopped answering".into());
                }
                let ops = engine.outgoing(400)?;
                if !ops.is_empty() {
                    engine.mark_sent(&ops.iter().map(|o| o.id.clone()).collect::<Vec<_>>())?;
                    send(&mut ws, &mut sess, json!({"t": "ops", "ops": ops}))?;
                    inflight_ops = Some(Instant::now());
                }
            }
            let presence = {
                let mut st = self.inner.st.lock().unwrap();
                if st.presence_dirty {
                    st.presence_dirty = false;
                    Some(st.presence.clone())
                } else {
                    None
                }
            };
            if let Some(p) = presence {
                send(&mut ws, &mut sess, json!({"t": "presence", "open": p}))?;
            }
            if snapshot_done {
                let nums = engine.numbers();
                for key in ["nextEstimate", "nextRO", "nextInvoice", "nextInspection", "nextPO"] {
                    let left = nums.get(key).map(|v| v.len()).unwrap_or(0);
                    if left < 5 && inflight_reserve.get(key).map(|t| t.elapsed() > Duration::from_secs(10)).unwrap_or(true) {
                        send(&mut ws, &mut sess, json!({"t": "reserve", "key": key, "count": 25}))?;
                        inflight_reserve.insert(key.to_string(), Instant::now());
                    }
                }
            }
            if upload.is_none() {
                if let Some(next) = engine.att_all().into_iter().find(|a| a["state"] == "pending") {
                    let id = next["id"].as_str().unwrap_or("").to_string();
                    let ext = next["ext"].as_str().unwrap_or("").to_string();
                    match read_local(&self.inner.att_dir, &id, &ext) {
                        Some(bytes) => {
                            let sha = crate::flat::sha256_hex(&bytes);
                            self.inner.st.lock().unwrap().uploading = Some(id.clone());
                            (self.inner.emit)("photo", json!({"id": id, "state": "uploading"}));
                            send(&mut ws, &mut sess, json!({"t": "attStat", "id": id}))?;
                            upload = Some((id, 0, bytes, ext, sha));
                        }
                        None => {
                            engine.att_queue(&id, &json!({"id": id, "ext": ext, "state": "missing"}))?;
                        }
                    }
                }
            }
            if downloading.is_none() {
                let want = self.inner.st.lock().unwrap().downloads.iter().find(|(_, v)| v.1.is_empty()).map(|(k, _)| k.clone());
                if let Some(id) = want {
                    send(&mut ws, &mut sess, json!({"t": "attGet", "id": id, "off": 0}))?;
                    downloading = Some(id);
                }
            }
            if last_ping.elapsed() > Duration::from_secs(4) {
                send(&mut ws, &mut sess, json!({"t": "ping"}))?;
                ping_sent_at = Some(Instant::now());
                last_ping = Instant::now();
            }
            let heard = self.inner.st.lock().unwrap().last_heard_ms;
            if util::now_ms().saturating_sub(heard) > 12_000 {
                return Err("SHOP HUB OFFLINE — no answer for 12 seconds".into());
            }
        }
    }
}

fn read_local(dir: &std::path::Path, id: &str, ext: &str) -> Option<Vec<u8>> {
    std::fs::read(dir.join(format!("{id}.{ext}"))).ok()
}

/// Keep a photograph fetched from the hub, the same careful way the app keeps
/// its own: written aside, flushed, renamed.
pub fn store_local(dir: &std::path::Path, id: &str, ext: &str, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    if !crate::server::safe_id(id) {
        return Err("bad id".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let fin = dir.join(format!("{id}.{ext}"));
    if fin.exists() {
        return Ok(());
    }
    let tmp = dir.join(format!("{id}.fetching"));
    {
        let mut f = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &fin).map_err(|e| e.to_string())
}
