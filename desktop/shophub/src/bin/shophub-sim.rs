//! Development harness: one "computer" running JZD Shop Manager's desktop
//! shell, as its own process. A browser page loads index.html and reaches this
//! process through a small loopback HTTP control port in place of Tauri's IPC,
//! so the real page, the real sync code and the real network are tested
//! together across separate processes. Never shipped.
//!
//!   shophub-sim --dir <data folder> --ctl <control port>

use serde_json::{json, Value};
use shophub::app::Options;
use shophub::secrets::FileSecrets;
use shophub::shell::Shell;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

struct Events {
    list: Mutex<Vec<Value>>,
    cv: Condvar,
}

fn arg(name: &str) -> Option<String> {
    let a: Vec<String> = std::env::args().collect();
    a.iter().position(|x| x == name).and_then(|i| a.get(i + 1).cloned())
}

fn b64d(s: &str) -> Result<Vec<u8>, String> {
    shophub::crypto::unb64(s)
}

fn main() {
    let dir = PathBuf::from(arg("--dir").expect("--dir"));
    let ctl: u16 = arg("--ctl").expect("--ctl").parse().unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    let events = Arc::new(Events { list: Mutex::new(Vec::new()), cv: Condvar::new() });
    let ev = events.clone();
    let shell = Arc::new(
        Shell::open(Options {
            data_dir: dir.clone(),
            att_dir: dir.join("attachments"),
            secrets: Arc::new(FileSecrets::new(dir.join("secrets.json"))),
            emit: Arc::new(move |kind: &str, data: Value| {
                let mut l = ev.list.lock().unwrap();
                let n = l.len();
                l.push(json!({"n": n, "kind": kind, "data": data}));
                ev.cv.notify_all();
            }),
            bind_ip: arg("--bind").unwrap_or_else(|| "127.0.0.1".into()),
            discovery: false,
        })
        .unwrap(),
    );
    let listener = TcpListener::bind(("127.0.0.1", ctl)).unwrap();
    println!("READY {}", listener.local_addr().unwrap());
    for stream in listener.incoming().flatten() {
        let (shell, events) = (shell.clone(), events.clone());
        std::thread::spawn(move || {
            let _ = serve(stream, &shell, &events);
        });
    }
}

fn serve(mut stream: TcpStream, shell: &Shell, events: &Events) -> Result<(), String> {
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|e| e.to_string())?;
    let parts: Vec<&str> = line.split_whitespace().collect();
    let (method, path) = (parts.first().copied().unwrap_or(""), parts.get(1).copied().unwrap_or(""));
    let mut len = 0usize;
    loop {
        let mut h = String::new();
        reader.read_line(&mut h).map_err(|e| e.to_string())?;
        if h == "\r\n" || h.is_empty() {
            break;
        }
        if let Some(v) = h.to_ascii_lowercase().strip_prefix("content-length:") {
            len = v.trim().parse().unwrap_or(0);
        }
    }
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).map_err(|e| e.to_string())?;
    let reply = |stream: &mut TcpStream, status: u16, v: &Value| {
        let text = v.to_string();
        let _ = write!(stream, "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}", text.len(), text);
    };
    if method == "OPTIONS" {
        reply(&mut stream, 200, &json!({}));
        return Ok(());
    }
    if path.starts_with("/events-len") {
        let n = events.list.lock().unwrap().len();
        reply(&mut stream, 200, &json!({"n": n}));
        return Ok(());
    }
    if path.starts_with("/events") {
        let after: usize = path.split("after=").nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
        let mut l = events.list.lock().unwrap();
        if l.len() <= after {
            l = events.cv.wait_timeout(l, Duration::from_millis(1500)).unwrap().0;
        }
        let out: Vec<Value> = l.iter().skip(after).cloned().collect();
        drop(l);
        reply(&mut stream, 200, &json!(out));
        return Ok(());
    }
    let req: Value = serde_json::from_slice(&body).unwrap_or(json!({}));
    let cmd = req["cmd"].as_str().unwrap_or("");
    let a = &req["args"];
    let result = invoke(shell, cmd, a);
    match result {
        Ok(v) => reply(&mut stream, 200, &json!({"ok": v})),
        Err(e) => reply(&mut stream, 200, &json!({"err": e})),
    }
    Ok(())
}

fn invoke(shell: &Shell, cmd: &str, a: &Value) -> Result<Value, String> {
    if cmd == "sync_debug_pause" {
        shell.sync.debug_pause(a["on"].as_bool().unwrap_or(false));
        return Ok(json!(true));
    }
    if cmd == "sync_host_enable" {
        let mut a = a.clone();
        if a["port"].as_u64().unwrap_or(0) == 0 {
            a["port"] = json!(arg("--hub-port").and_then(|p| p.parse::<u16>().ok()).unwrap_or(0));
        }
        return shell.sync_command(cmd, &a).unwrap();
    }
    if let Some(r) = shell.sync_command(cmd, a) {
        return r;
    }
    let book = shell.data_dir.join("shop.json");
    match cmd {
        "db_load" => {
            if let Some(text) = shell.sync.load_book()? {
                return Ok(json!({"text": text, "existed": !text.is_empty(), "error": null, "path": "Shop Hub", "sync": shell.sync.mode()}));
            }
            let text = std::fs::read_to_string(&book).unwrap_or_default();
            Ok(json!({"text": text, "existed": !text.is_empty(), "error": null, "path": book.display().to_string(), "sync": "local"}))
        }
        "db_save" => {
            let text = a["text"].as_str().unwrap_or("");
            if text.trim().is_empty() {
                return Err("refusing to write an empty book".into());
            }
            if shell.sync.mode() != "local" {
                let r = shell.sync.save_book(text)?;
                return Ok(json!({"bytes": text.len(), "path": "Shop Hub", "backup": null, "sync": r}));
            }
            let tmp = book.with_extension("json.writing");
            std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &book).map_err(|e| e.to_string())?;
            Ok(json!({"bytes": text.len(), "path": book.display().to_string(), "backup": null}))
        }
        "db_where" => Ok(json!(shell.data_dir.display().to_string())),
        "att_save" => {
            let ext = a["ext"].as_str().unwrap_or("jpg").to_ascii_lowercase();
            let bytes = b64d(a["dataB64"].as_str().unwrap_or(""))?;
            std::fs::create_dir_all(&shell.att_dir).map_err(|e| e.to_string())?;
            let id = format!("att-{}-{}", shophub::util::now_ms(), shophub::util::rand_hex(3));
            std::fs::write(shell.att_dir.join(format!("{id}.{ext}")), &bytes).map_err(|e| e.to_string())?;
            shell.sync.att_saved(&id, &ext)?;
            Ok(json!({"id": id, "file": format!("{id}.{ext}"), "bytes": bytes.len(), "sha256": shophub::flat::sha256_hex(&bytes)}))
        }
        "att_read" | "att_exists" => {
            let id = a["id"].as_str().unwrap_or("");
            let found = std::fs::read_dir(&shell.att_dir).ok().and_then(|rd| rd.filter_map(|x| x.ok()).find(|f| f.file_name().to_string_lossy().starts_with(&format!("{id}."))));
            if cmd == "att_exists" {
                return Ok(json!(found.is_some()));
            }
            let bytes = match found {
                Some(f) => std::fs::read(f.path()).map_err(|e| e.to_string())?,
                None if shell.sync.mode() != "local" => shell.sync.att_fetch(id)?,
                None => return Err("attachment file missing".into()),
            };
            Ok(json!(shophub::crypto::b64(&bytes)))
        }
        "att_delete" => Ok(json!(null)),
        "sync_firewall_status" => Ok(json!({"present": true, "port": 47811, "discoveryPort": 47812, "harness": true})),
        "sync_autostart_status" => Ok(json!({"enabled": false, "harness": true})),
        _ => Err(format!("{cmd} is not available in the development harness")),
    }
}
