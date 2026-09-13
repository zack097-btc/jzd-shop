//! The Shop Hub server.
//!
//! One TCP port on the shop's network. Each computer holds one WebSocket
//! connection. A connection from outside the private address ranges is closed
//! before a byte is read. A connection that is not a paired device can do one
//! thing only: ask to pair while the host has a pairing code showing, and then
//! only the person at the host can let it in.

use crate::crypto::{self, b64, unb64, Session};
use crate::secrets::SecretStore;
use crate::store::{now_iso, Change, Device, HubStore, Op};
use crate::util;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tungstenite::protocol::WebSocketConfig;
use tungstenite::{Message, WebSocket};

pub const DEFAULT_PORT: u16 = 47811;
pub const DISCOVERY_PORT: u16 = 47812;
pub const DISCOVER_PROBE: &[u8] = b"JZD-SHOPHUB-DISCOVER-1";
const CHUNK_LEAVES: usize = 4000;
pub const ATT_CHUNK: usize = 256 * 1024;
pub const MAX_ATT_BYTES: u64 = 25 * 1024 * 1024;

pub fn ws_config() -> WebSocketConfig {
    let mut c = WebSocketConfig::default();
    c.max_message_size = Some(64 << 20);
    c.max_frame_size = Some(64 << 20);
    c
}

struct Conn {
    device_id: String,
    name: String,
    tx: Sender<String>,
    open: Option<String>,
    addr: String,
}

#[derive(Clone)]
pub struct PairRequest {
    pub id: String,
    pub name: String,
    pub verify: String,
    pub peer: String,
    pub created_ms: u64,
    decision: Option<bool>,
    secret: [u8; 32],
}

struct PairWindow {
    code: String,
    expires_ms: u64,
    attempts: u32,
}

struct State {
    conns: HashMap<u64, Conn>,
    pairing: Option<PairWindow>,
    requests: HashMap<String, PairRequest>,
}

pub struct HubInner {
    pub store: HubStore,
    secrets: Arc<dyn SecretStore>,
    state: Mutex<State>,
    apply_lock: Mutex<()>,
    stop: AtomicBool,
    next_conn: AtomicU64,
    pub addr: Mutex<Option<SocketAddr>>,
}

#[derive(Clone)]
pub struct Hub {
    pub inner: Arc<HubInner>,
}

fn private_ok(stream: &TcpStream) -> bool {
    stream.peer_addr().map(|a| util::private_peer(&a.ip())).unwrap_or(false)
}

impl Hub {
    pub fn open(dir: &Path, secrets: Arc<dyn SecretStore>) -> Result<Hub, String> {
        let store = HubStore::open(dir)?;
        Ok(Hub {
            inner: Arc::new(HubInner {
                store,
                secrets,
                state: Mutex::new(State { conns: HashMap::new(), pairing: None, requests: HashMap::new() }),
                apply_lock: Mutex::new(()),
                stop: AtomicBool::new(false),
                next_conn: AtomicU64::new(1),
                addr: Mutex::new(None),
            }),
        })
    }

    pub fn store(&self) -> &HubStore {
        &self.inner.store
    }

    /// Listen on the shop network. `bind` is normally 0.0.0.0:47811; tests use
    /// 127.0.0.1:0.
    pub fn serve(&self, bind: SocketAddr, discovery: bool) -> Result<SocketAddr, String> {
        let listener = TcpListener::bind(bind).map_err(|e| format!("the Shop Hub could not open port {}: {e}", bind.port()))?;
        let addr = listener.local_addr().map_err(|e| e.to_string())?;
        *self.inner.addr.lock().unwrap() = Some(addr);
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let me = self.clone();
        std::thread::Builder::new()
            .name("shophub-accept".into())
            .spawn(move || {
                while !me.inner.stop.load(Ordering::Relaxed) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let me2 = me.clone();
                            let _ = std::thread::Builder::new().name("shophub-conn".into()).spawn(move || me2.handle(stream));
                        }
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(30)),
                        Err(_) => std::thread::sleep(Duration::from_millis(200)),
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        if discovery {
            let me = self.clone();
            let port = addr.port();
            let _ = std::thread::Builder::new().name("shophub-discovery".into()).spawn(move || me.discovery(port));
        }
        Ok(addr)
    }

    pub fn stop(&self) {
        self.inner.stop.store(true, Ordering::Relaxed);
    }

    pub fn stopped(&self) -> bool {
        self.inner.stop.load(Ordering::Relaxed)
    }

    fn discovery(&self, port: u16) {
        let Ok(sock) = UdpSocket::bind(("0.0.0.0", DISCOVERY_PORT)) else { return };
        let _ = sock.set_read_timeout(Some(Duration::from_millis(500)));
        let mut buf = [0u8; 256];
        while !self.inner.stop.load(Ordering::Relaxed) {
            if let Ok((n, from)) = sock.recv_from(&mut buf) {
                if &buf[..n] == DISCOVER_PROBE && util::private_peer(&from.ip()) && self.inner.store.initialized() {
                    let reply = json!({"jzdShopHub": 1, "shop": self.inner.store.shop_id(), "name": self.shop_name(), "port": port});
                    let _ = sock.send_to(reply.to_string().as_bytes(), from);
                }
            }
        }
    }

    pub fn shop_name(&self) -> String {
        self.inner.store.meta("shopName").ok().flatten().and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_default()
    }

    // ---------------- pairing, from the host's screen

    pub fn open_pairing(&self, minutes: u64) -> String {
        let code = util::rand_digits6();
        self.inner.state.lock().unwrap().pairing = Some(PairWindow { code: code.clone(), expires_ms: util::now_ms() + minutes * 60_000, attempts: 0 });
        code
    }

    pub fn close_pairing(&self) {
        self.inner.state.lock().unwrap().pairing = None;
    }

    pub fn pairing_code(&self) -> Option<(String, u64)> {
        let st = self.inner.state.lock().unwrap();
        st.pairing.as_ref().filter(|w| w.expires_ms > util::now_ms()).map(|w| (w.code.clone(), w.expires_ms))
    }

    pub fn pair_requests(&self) -> Vec<Value> {
        let st = self.inner.state.lock().unwrap();
        st.requests
            .values()
            .filter(|r| r.decision.is_none())
            .map(|r| json!({"id": r.id, "name": r.name, "verify": r.verify, "peer": r.peer, "created": r.created_ms}))
            .collect()
    }

    pub fn decide_pairing(&self, id: &str, approve: bool) -> Result<(), String> {
        let mut st = self.inner.state.lock().unwrap();
        let r = st.requests.get_mut(id).ok_or("that pairing request is gone")?;
        r.decision = Some(approve);
        Ok(())
    }

    /// Register a device directly, without the network - used once for the
    /// host computer's own connection to its own hub.
    pub fn register_local_device(&self, name: &str) -> Result<(String, [u8; 32]), String> {
        let id = format!("dev-{}", util::rand_hex(8));
        let secret: [u8; 32] = util::rand_bytes(32).try_into().unwrap();
        self.inner.secrets.put(&format!("device/{id}"), &secret)?;
        self.inner.store.put_device(&Device { id: id.clone(), name: name.into(), created: now_iso(), revoked: false, last_seen: String::new(), host: true })?;
        Ok((id, secret))
    }

    pub fn revoke(&self, device_id: &str) -> Result<(), String> {
        let mut d = self.inner.store.device(device_id)?.ok_or("no such device")?;
        if d.host {
            return Err("the host computer's own connection cannot be revoked".into());
        }
        d.revoked = true;
        self.inner.store.put_device(&d)?;
        self.inner.secrets.delete(&format!("device/{device_id}"))?;
        let mut st = self.inner.state.lock().unwrap();
        // closing its channel ends its connection thread
        st.conns.retain(|_, c| c.device_id != device_id);
        drop(st);
        self.broadcast_presence();
        Ok(())
    }

    pub fn devices(&self) -> Vec<Value> {
        let st = self.inner.state.lock().unwrap();
        let online: HashMap<String, (String, Option<String>)> = st.conns.values().map(|c| (c.device_id.clone(), (c.addr.clone(), c.open.clone()))).collect();
        drop(st);
        let mut out: Vec<Value> = self
            .inner
            .store
            .devices()
            .unwrap_or_default()
            .into_iter()
            .map(|d| {
                let on = online.get(&d.id);
                json!({"id": d.id, "name": d.name, "host": d.host, "revoked": d.revoked, "online": on.is_some(),
                       "lastSeen": if on.is_some() { now_iso() } else { d.last_seen.clone() },
                       "address": on.map(|x| x.0.clone()).unwrap_or_default(), "open": on.and_then(|x| x.1.clone())})
            })
            .collect();
        out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        out
    }

    fn broadcast_presence(&self) {
        let msg = json!({"t": "presence", "devices": self.devices()}).to_string();
        let st = self.inner.state.lock().unwrap();
        for c in st.conns.values() {
            let _ = c.tx.send(msg.clone());
        }
    }

    fn broadcast_changes(&self, changes: &[Change], except: Option<u64>) {
        if changes.is_empty() {
            return;
        }
        let to = changes.iter().map(|c| c.r).max().unwrap_or(0);
        let msg = json!({"t": "changes", "full": false, "to": to, "last": true, "c": changes}).to_string();
        let st = self.inner.state.lock().unwrap();
        for (id, c) in st.conns.iter() {
            if Some(*id) != except {
                let _ = c.tx.send(msg.clone());
            }
        }
    }

    pub fn connected_count(&self) -> usize {
        self.inner.state.lock().unwrap().conns.len()
    }

    // ---------------- a connection

    fn handle(&self, stream: TcpStream) {
        if !private_ok(&stream) {
            return;
        }
        let peer = stream.peer_addr().map(|a| a.to_string()).unwrap_or_default();
        // a socket accepted from a non-blocking listener is non-blocking on Windows
        let _ = stream.set_nonblocking(false);
        let _ = stream.set_nodelay(true);
        let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
        let Ok(mut ws) = tungstenite::accept_with_config(stream, Some(ws_config())) else { return };
        let first = match ws.read() {
            Ok(Message::Text(t)) => serde_json::from_str::<Value>(&t).unwrap_or(Value::Null),
            _ => return,
        };
        match first["t"].as_str() {
            Some("hello") => self.session(ws, first, peer),
            Some("pair1") => self.pairing(ws, first, peer),
            _ => {}
        }
    }

    fn pairing(&self, mut ws: WebSocket<TcpStream>, msg: Value, peer: String) {
        let refuse = |ws: &mut WebSocket<TcpStream>, why: &str| {
            let _ = ws.send(Message::Text(json!({"t": "pair-refused", "why": why}).to_string()));
            graceful_close(ws);
        };
        let code = msg["code"].as_str().unwrap_or("").to_string();
        let name: String = msg["name"].as_str().unwrap_or("").chars().filter(|c| !c.is_control()).take(60).collect();
        {
            let mut st = self.inner.state.lock().unwrap();
            let Some(w) = st.pairing.as_mut() else {
                drop(st);
                return refuse(&mut ws, "The Shop Hub is not accepting new computers right now. Press PAIR DEVICE on the host first.");
            };
            if w.expires_ms < util::now_ms() {
                st.pairing = None;
                drop(st);
                return refuse(&mut ws, "That pairing code has expired. Press PAIR DEVICE on the host for a new one.");
            }
            if w.attempts >= 5 {
                st.pairing = None;
                drop(st);
                return refuse(&mut ws, "Too many wrong codes. Press PAIR DEVICE on the host for a new one.");
            }
            if !crypto::ct_eq(code.as_bytes(), w.code.as_bytes()) {
                w.attempts += 1;
                drop(st);
                return refuse(&mut ws, "That pairing code is not the one showing on the host.");
            }
        }
        let Ok(client_pub) = unb64(msg["pk"].as_str().unwrap_or("")) else { return refuse(&mut ws, "bad pairing request") };
        let keys = crypto::pair_keys();
        let host_pub = keys.public.clone();
        let Ok(paired) = crypto::pair_finish(keys, &client_pub, &client_pub, &host_pub) else { return refuse(&mut ws, "bad pairing key") };
        let req_id = util::rand_hex(6);
        self.inner.state.lock().unwrap().requests.insert(
            req_id.clone(),
            PairRequest { id: req_id.clone(), name: if name.is_empty() { "Unnamed computer".into() } else { name.clone() }, verify: paired.verify.clone(), peer: peer.clone(), created_ms: util::now_ms(), decision: None, secret: paired.device_secret },
        );
        let shop = self.inner.store.shop_id();
        if ws.send(Message::Text(json!({"t": "pair2", "pk": b64(&host_pub), "shop": shop, "shopName": self.shop_name(), "request": req_id}).to_string())).is_err() {
            self.inner.state.lock().unwrap().requests.remove(&req_id);
            return;
        }
        let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(200)));
        let started = Instant::now();
        loop {
            let decision = self.inner.state.lock().unwrap().requests.get(&req_id).and_then(|r| r.decision);
            if let Some(approve) = decision {
                let req = self.inner.state.lock().unwrap().requests.remove(&req_id).unwrap();
                if approve {
                    let id = format!("dev-{}", util::rand_hex(8));
                    let ok = self.inner.secrets.put(&format!("device/{id}"), &req.secret).is_ok()
                        && self.inner.store.put_device(&Device { id: id.clone(), name: req.name.clone(), created: now_iso(), revoked: false, last_seen: String::new(), host: false }).is_ok();
                    if ok {
                        let mac = crypto::hmac(&req.secret, &[b"paired", id.as_bytes(), shop.as_bytes()]);
                        let _ = ws.send(Message::Text(json!({"t": "pair-ok", "device": id, "mac": b64(&mac)}).to_string()));
                        self.close_pairing();
                    } else {
                        let _ = ws.send(Message::Text(json!({"t": "pair-refused", "why": "the host could not store the new device"}).to_string()));
                    }
                } else {
                    let _ = ws.send(Message::Text(json!({"t": "pair-refused", "why": "The person at the host did not approve this computer."}).to_string()));
                }
                graceful_close(&mut ws);
                return;
            }
            if started.elapsed() > Duration::from_secs(300) || self.stopped() {
                self.inner.state.lock().unwrap().requests.remove(&req_id);
                return refuse(&mut ws, "Nobody approved this computer at the host in time.");
            }
            match ws.read() {
                Ok(Message::Close(_)) | Err(tungstenite::Error::ConnectionClosed) | Err(tungstenite::Error::AlreadyClosed) => {
                    self.inner.state.lock().unwrap().requests.remove(&req_id);
                    return;
                }
                Err(tungstenite::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => {
                    self.inner.state.lock().unwrap().requests.remove(&req_id);
                    return;
                }
                _ => {}
            }
        }
    }

    fn session(&self, mut ws: WebSocket<TcpStream>, hello: Value, peer: String) {
        let device_id = hello["device"].as_str().unwrap_or("").to_string();
        let nonce_c = unb64(hello["nonce"].as_str().unwrap_or("")).unwrap_or_default();
        let mac = unb64(hello["mac"].as_str().unwrap_or("")).unwrap_or_default();
        let deny = |ws: &mut WebSocket<TcpStream>, why: &str| {
            let _ = ws.send(Message::Text(json!({"t": "denied", "why": why}).to_string()));
            graceful_close(ws);
        };
        let device = match self.inner.store.device(&device_id) {
            Ok(Some(d)) if !d.revoked => d,
            Ok(Some(_)) => return deny(&mut ws, "This computer's access to the Shop Hub has been revoked. Pair it again from the host."),
            _ => return deny(&mut ws, "This computer is not paired with this Shop Hub."),
        };
        let Ok(Some(secret)) = self.inner.secrets.get(&format!("device/{device_id}")) else {
            return deny(&mut ws, "This computer is not paired with this Shop Hub.");
        };
        if nonce_c.len() < 16 || !crypto::mac_eq(&secret, &[b"hello", device_id.as_bytes(), &nonce_c], &mac) {
            return deny(&mut ws, "This computer could not prove it is paired.");
        }
        let nonce_s = crypto::new_nonce();
        let shop = self.inner.store.shop_id();
        let welcome_mac = crypto::hmac(&secret, &[b"welcome", &nonce_c, &nonce_s, shop.as_bytes()]);
        let welcome = json!({"t": "welcome", "shop": shop, "shopName": self.shop_name(), "epoch": self.inner.store.epoch(),
                             "nonce": b64(&nonce_s), "mac": b64(&welcome_mac), "seq": self.inner.store.seq().unwrap_or(0), "device": device.name});
        if ws.send(Message::Text(welcome.to_string())).is_err() {
            return;
        }
        let mut sess = Session::new(&secret, &nonce_c, &nonce_s, false);
        let (tx, rx): (Sender<String>, Receiver<String>) = channel();
        let conn_id = self.inner.next_conn.fetch_add(1, Ordering::Relaxed);
        self.inner.state.lock().unwrap().conns.insert(conn_id, Conn { device_id: device_id.clone(), name: device.name.clone(), tx, open: None, addr: peer });
        self.broadcast_presence();
        let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(20)));
        let mut last_heard = Instant::now();
        let mut uploads: HashMap<String, (std::fs::File, u64)> = HashMap::new();
        'outer: loop {
            if self.inner.stop.load(Ordering::Relaxed) {
                break;
            }
            // what other connections want this computer to know
            loop {
                match rx.try_recv() {
                    Ok(msg) => {
                        if ws.send(Message::Binary(sess.seal(msg.as_bytes()))).is_err() {
                            break 'outer;
                        }
                    }
                    Err(std::sync::mpsc::TryRecvError::Empty) => break,
                    Err(std::sync::mpsc::TryRecvError::Disconnected) => break 'outer, // revoked
                }
            }
            match ws.read() {
                Ok(Message::Binary(frame)) => {
                    last_heard = Instant::now();
                    let Ok(plain) = sess.open(&frame) else { break };
                    let Ok(msg) = serde_json::from_slice::<Value>(&plain) else { break };
                    let replies = self.dispatch(conn_id, &device_id, &msg, &mut uploads);
                    for r in replies {
                        if ws.send(Message::Binary(sess.seal(r.to_string().as_bytes()))).is_err() {
                            break 'outer;
                        }
                    }
                }
                Ok(Message::Close(_)) => break,
                Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => last_heard = Instant::now(),
                Ok(_) => break, // plaintext after the handshake is not allowed
                Err(tungstenite::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
                Err(_) => break,
            }
            if last_heard.elapsed() > Duration::from_secs(20) {
                break;
            }
        }
        let removed = self.inner.state.lock().unwrap().conns.remove(&conn_id).is_some();
        if let Ok(Some(mut d)) = self.inner.store.device(&device_id) {
            d.last_seen = now_iso();
            let _ = self.inner.store.put_device(&d);
        }
        let _ = removed;
        self.broadcast_presence();
    }

    fn dispatch(&self, conn_id: u64, device_id: &str, msg: &Value, uploads: &mut HashMap<String, (std::fs::File, u64)>) -> Vec<Value> {
        let store = &self.inner.store;
        match msg["t"].as_str().unwrap_or("") {
            "ping" => vec![json!({"t": "pong", "seq": store.seq().unwrap_or(0)})],
            "sync" => {
                let since = msg["since"].as_u64().unwrap_or(0);
                match store.changes_since(since) {
                    Ok((full, to, changes)) => {
                        if changes.is_empty() {
                            return vec![json!({"t": "changes", "full": full, "to": to, "last": true, "c": []})];
                        }
                        let n = changes.len();
                        changes
                            .chunks(CHUNK_LEAVES)
                            .enumerate()
                            .map(|(i, part)| json!({"t": "changes", "full": full, "to": to, "last": (i + 1) * CHUNK_LEAVES >= n, "c": part}))
                            .collect()
                    }
                    Err(e) => vec![json!({"t": "error", "why": e})],
                }
            }
            "ops" => {
                let ops: Vec<Op> = serde_json::from_value(msg["ops"].clone()).unwrap_or_default();
                let _g = self.inner.apply_lock.lock().unwrap();
                match store.apply(device_id, &ops) {
                    Ok((results, changes)) => {
                        self.broadcast_changes(&changes, Some(conn_id));
                        vec![json!({"t": "acks", "res": results, "to": store.seq().unwrap_or(0)})]
                    }
                    Err(e) => vec![json!({"t": "error", "why": e, "batch": msg["batch"]})],
                }
            }
            "reserve" => {
                let key = msg["key"].as_str().unwrap_or("");
                let count = msg["count"].as_u64().unwrap_or(25);
                let _g = self.inner.apply_lock.lock().unwrap();
                match store.reserve_numbers(device_id, key, count) {
                    Ok((start, changes)) => {
                        self.broadcast_changes(&changes, None);
                        vec![json!({"t": "reserved", "key": key, "start": start, "count": count})]
                    }
                    Err(e) => vec![json!({"t": "error", "why": e})],
                }
            }
            "presence" => {
                let open = msg["open"].as_str().map(|s| s.chars().take(120).collect::<String>());
                if let Some(c) = self.inner.state.lock().unwrap().conns.get_mut(&conn_id) {
                    c.open = open;
                }
                self.broadcast_presence();
                vec![]
            }
            "devices" => vec![json!({"t": "presence", "devices": self.devices()})],
            "attStat" => {
                let id = msg["id"].as_str().unwrap_or("");
                if !safe_id(id) {
                    return vec![json!({"t": "attStat", "id": id, "error": "bad id"})];
                }
                match store.att_meta(id) {
                    Ok(Some(m)) if m["state"] == "stored" => vec![json!({"t": "attStat", "id": id, "done": true, "have": m["size"], "sha": m["sha"], "ext": m["ext"]})],
                    _ => {
                        let have = std::fs::metadata(store.att_dir().join(format!("{id}.part"))).map(|m| m.len()).unwrap_or(0);
                        vec![json!({"t": "attStat", "id": id, "done": false, "have": have})]
                    }
                }
            }
            "attPut" => vec![self.att_put(msg, device_id, uploads)],
            "attGet" => vec![self.att_get(msg)],
            _ => vec![],
        }
    }

    fn att_put(&self, msg: &Value, device_id: &str, uploads: &mut HashMap<String, (std::fs::File, u64)>) -> Value {
        let store = &self.inner.store;
        let id = msg["id"].as_str().unwrap_or("").to_string();
        let ext = msg["ext"].as_str().unwrap_or("").to_ascii_lowercase();
        let sha = msg["sha"].as_str().unwrap_or("").to_string();
        let size = msg["size"].as_u64().unwrap_or(0);
        let off = msg["off"].as_u64().unwrap_or(0);
        let reply = |ok: bool, have: u64, done: bool, why: &str| json!({"t": "attAck", "id": id, "ok": ok, "have": have, "done": done, "why": why});
        if !safe_id(&id) || !["jpg", "jpeg", "png", "webp", "gif", "pdf", "txt"].contains(&ext.as_str()) || sha.len() != 64 || size == 0 || size > MAX_ATT_BYTES {
            return reply(false, 0, false, "bad attachment");
        }
        if let Ok(Some(m)) = store.att_meta(&id) {
            if m["state"] == "stored" {
                return if m["sha"] == sha { reply(true, size, true, "") } else { reply(false, 0, false, "an attachment with that id already exists with different contents") };
            }
        }
        let dir = store.att_dir();
        let part = dir.join(format!("{id}.part"));
        let have = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        if off != have {
            uploads.remove(&id);
            return reply(false, have, false, "resume");
        }
        let Ok(data) = unb64(msg["data"].as_str().unwrap_or("")) else { return reply(false, have, false, "bad data") };
        if have + data.len() as u64 > size {
            let _ = std::fs::remove_file(&part);
            uploads.remove(&id);
            return reply(false, 0, false, "too much data; restarting");
        }
        let entry = uploads.entry(id.clone()).or_insert_with(|| {
            let f = std::fs::OpenOptions::new().create(true).append(true).open(&part).expect("attachment part file");
            (f, have)
        });
        if entry.0.write_all(&data).is_err() {
            uploads.remove(&id);
            return reply(false, have, false, "write failed");
        }
        entry.1 = have + data.len() as u64;
        let now_have = entry.1;
        if now_have < size {
            return reply(true, now_have, false, "");
        }
        let (f, _) = uploads.remove(&id).unwrap();
        let _ = f.sync_all();
        drop(f);
        let bytes = std::fs::read(&part).unwrap_or_default();
        let got = crate::flat::sha256_hex(&bytes);
        if got != sha || bytes.len() as u64 != size {
            let _ = std::fs::remove_file(&part);
            return reply(false, 0, false, "the photo arrived damaged (checksum mismatch); sending again");
        }
        let fin = dir.join(format!("{id}.{ext}"));
        if std::fs::rename(&part, &fin).is_err() {
            return reply(false, 0, false, "could not store the photo");
        }
        let _ = store.put_att_meta(&id, &json!({"id": id, "ext": ext, "sha": sha, "size": size, "state": "stored", "by": device_id, "at": now_iso()}));
        reply(true, size, true, "")
    }

    fn att_get(&self, msg: &Value) -> Value {
        let store = &self.inner.store;
        let id = msg["id"].as_str().unwrap_or("").to_string();
        let off = msg["off"].as_u64().unwrap_or(0);
        if !safe_id(&id) {
            return json!({"t": "attData", "id": id, "error": "bad id"});
        }
        let Ok(Some(m)) = store.att_meta(&id) else { return json!({"t": "attData", "id": id, "error": "The Shop Hub does not have this photo yet."}) };
        if m["state"] != "stored" {
            return json!({"t": "attData", "id": id, "error": "The Shop Hub is still receiving this photo."});
        }
        let ext = m["ext"].as_str().unwrap_or("");
        let path = store.att_dir().join(format!("{id}.{ext}"));
        let Ok(mut f) = std::fs::File::open(&path) else { return json!({"t": "attData", "id": id, "error": "The photo file is missing on the Shop Hub."}) };
        use std::io::Seek;
        let size = m["size"].as_u64().unwrap_or(0);
        if f.seek(std::io::SeekFrom::Start(off)).is_err() {
            return json!({"t": "attData", "id": id, "error": "bad offset"});
        }
        let mut buf = vec![0u8; ATT_CHUNK];
        let n = f.read(&mut buf).unwrap_or(0);
        buf.truncate(n);
        json!({"t": "attData", "id": id, "off": off, "data": b64(&buf), "size": size, "sha": m["sha"], "ext": ext, "last": off + n as u64 >= size})
    }
}

/// Close so that a last message is actually delivered. Dropping a socket with
/// unread data makes Windows send a reset, which throws that message away.
pub fn graceful_close(ws: &mut WebSocket<TcpStream>) {
    let _ = ws.close(None);
    let _ = ws.get_ref().set_read_timeout(Some(Duration::from_millis(100)));
    let until = Instant::now() + Duration::from_secs(2);
    while Instant::now() < until {
        match ws.read() {
            Ok(_) => {}
            Err(tungstenite::Error::Io(ref e)) if e.kind() == std::io::ErrorKind::WouldBlock || e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(_) => break,
        }
    }
    let _ = ws.get_ref().shutdown(std::net::Shutdown::Both);
}

pub fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}
