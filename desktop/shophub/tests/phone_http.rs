//! The hub hands a phone the app over the shop's own network, on the same port
//! the computers sync on. What matters here: the page comes back with the phone
//! shell in front of it, nothing else on that port is readable, and a request
//! cannot ask for a file the hub was not given.

use shophub::secrets::FileSecrets;
use shophub::server::Hub;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::Arc;
use std::time::Duration;

fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("shophub-http-{tag}-{}-{}", std::process::id(), shophub::util::rand_hex(4)));
    let _ = std::fs::remove_dir_all(&d);
    d
}

const PAGE: &str = "<!doctype html><html><head><title>JZD</title></head><body><script>const DESKTOP=1;</script></body></html>";

fn get(addr: SocketAddr, path: &str) -> String {
    let mut s = TcpStream::connect(addr).expect("connect");
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    write!(s, "GET {path} HTTP/1.1\r\nHost: shop\r\nConnection: close\r\n\r\n").expect("write");
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out
}

#[test]
fn a_phone_is_handed_the_app_and_nothing_else() {
    let dir = tmp("serve");
    let secrets = Arc::new(FileSecrets::new(dir.join("secrets.json")));
    let assets: shophub::server::Assets = Arc::new(|name: &str| if name == "index.html" { Some(PAGE.as_bytes().to_vec()) } else { None });
    let hub = Hub::open_with(&dir.join("hub"), secrets, Some(assets)).expect("hub");
    let addr = hub.serve("127.0.0.1:0".parse().unwrap(), false).expect("serve");

    let page = get(addr, "/phone");
    assert!(page.starts_with("HTTP/1.1 200 OK"), "{page}");
    assert!(page.contains("text/html"), "{page}");
    assert!(page.contains("<script src=\"/phone-shell.js\"></script>"), "the phone shell goes in front of the app: {page}");
    assert!(page.contains("const DESKTOP=1;"), "the app itself is served: {page}");
    assert!(page.find("/phone-shell.js").unwrap() < page.find("const DESKTOP=1;").unwrap(), "the shell must load before the app");

    let root = get(addr, "/");
    assert!(root.contains("<script src=\"/phone-shell.js\"></script>"), "the address on its own opens the app too");

    let shell = get(addr, "/phone-shell.js");
    assert!(shell.starts_with("HTTP/1.1 200 OK") && shell.contains("text/javascript"), "{shell}");

    let health = get(addr, "/health");
    assert!(health.contains("\"jzdShopHub\":1") && health.contains("\"app\":true"), "{health}");

    for path in ["/nope", "/../index.html", "/shop.json", "/index.html", "/phone-shell.js/../../secrets.json"] {
        let r = get(addr, path);
        assert!(r.starts_with("HTTP/1.1 404"), "{path} must not be served: {r}");
    }

    let mut s = TcpStream::connect(addr).unwrap();
    let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
    write!(s, "POST /phone HTTP/1.1\r\nHost: shop\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    assert!(out.starts_with("HTTP/1.1 405"), "{out}");

    hub.stop();
}

#[test]
fn a_hub_without_the_app_serves_no_page_but_still_syncs() {
    let dir = tmp("noapp");
    let secrets = Arc::new(FileSecrets::new(dir.join("secrets.json")));
    let hub = Hub::open(&dir.join("hub"), secrets).expect("hub");
    let addr = hub.serve("127.0.0.1:0".parse().unwrap(), false).expect("serve");
    let r = get(addr, "/phone");
    assert!(r.starts_with("HTTP/1.1 503"), "{r}");
    // the WebSocket side is untouched: an unpaired device is refused, not served
    let ws = tungstenite::connect(format!("ws://{addr}/shophub"));
    assert!(ws.is_ok(), "the sync port still accepts WebSocket connections");
    hub.stop();
}
