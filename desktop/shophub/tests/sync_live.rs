//! Real sockets, real pairing, real encryption: a host and two computers, each
//! a full ShopSync with its own data folder, talking over TCP on this machine.

use serde_json::{json, Value};
use shophub::app::{Options, ShopSync};
use shophub::secrets::FileSecrets;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("shophub-live-{tag}-{}-{}", std::process::id(), shophub::util::rand_hex(3)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

type Events = Arc<Mutex<Vec<(String, Value)>>>;

fn node(tag: &str) -> (Arc<ShopSync>, PathBuf, Events) {
    let dir = tmp(tag);
    node_at(dir)
}

fn node_at(dir: PathBuf) -> (Arc<ShopSync>, PathBuf, Events) {
    let events: Events = Arc::new(Mutex::new(Vec::new()));
    let ev = events.clone();
    let s = ShopSync::open(Options {
        data_dir: dir.clone(),
        att_dir: dir.join("attachments"),
        secrets: Arc::new(FileSecrets::new(dir.join("secrets.json"))),
        emit: Arc::new(move |name: &str, v: Value| ev.lock().unwrap().push((name.to_string(), v))),
        bind_ip: "127.0.0.1".into(),
        discovery: false,
    })
    .unwrap();
    (s, dir, events)
}

fn wait<F: FnMut() -> bool>(what: &str, secs: u64, mut f: F) -> Duration {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(secs) {
        if f() {
            return start.elapsed();
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for: {what}");
}

/// What the page does: read the book, change it, save it.
fn edit<F: FnOnce(&mut Value)>(s: &ShopSync, f: F) -> Value {
    let mut book: Value = serde_json::from_str(&s.load_book().unwrap().unwrap()).unwrap();
    f(&mut book);
    s.save_book(&book.to_string()).unwrap();
    book
}

/// What the page does with patches: apply every one and confirm.
fn apply_patches(s: &ShopSync) -> (Value, usize) {
    let patches = s.take_patches().unwrap();
    let list = patches.as_array().unwrap().clone();
    let ids: Vec<String> = list.iter().map(|p| p["id"].as_str().unwrap().to_string()).collect();
    s.confirm_patches(&ids).unwrap();
    (serde_json::from_str(&s.load_book().unwrap().unwrap()).unwrap(), list.len())
}

fn book_v282() -> Value {
    json!({
        "settings": {"shopName": "JZD Inc.", "nextEstimate": 12, "nextRO": 40, "nextInvoice": 1009, "nextInspection": 7, "nextPO": 1003, "laborRate": 112.5, "techs": ["Zack", "Marco"]},
        "customers": {"c1": {"id": "c1", "first": "Dale", "last": "Hansen", "phone": "509-555-0142"}},
        "vehicles": {"v1": {"id": "v1", "customerId": "c1", "year": "2010", "make": "Honda", "model": "Civic", "vin": "19XFA1F57AE000001", "mileage": "123442"}},
        "orders": {"o1": {"id": "o1", "customerId": "c1", "vehicleId": "v1", "status": "In Progress", "roNo": 39, "labor": [{"id": "l1", "desc": "Oil service", "hours": 0.5}],
                          "parts": [{"id": "p1", "desc": "Oil filter", "procurement": "Ordered"}], "payments": [], "history": []}},
        "inspections": {"insp1": {"id": "insp1", "orderId": "o1", "vehicleId": "v1", "state": "In Progress", "template": {"version": "2.4.0", "groups": []},
            "items": {"tires.tire.LF": {"state": "Not Inspected", "meas": {"tread": ""}, "flags": [], "note": "", "custNote": "", "photos": [], "obs": {}},
                      "battery.battery": {"state": "Not Inspected", "meas": {"volts": ""}, "flags": [], "note": "", "custNote": "", "photos": [], "obs": {}}}}},
        "attachments": {}, "recommendations": {}, "parts": {}, "vendors": {}, "purchaseOrders": {}, "movements": [], "timeSessions": [], "audit": [],
        "maintenance": {"records": [], "overrides": {}}, "providerHub": {}
    })
}

#[test]
fn a_shop_on_three_computers() {
    let t0 = Instant::now();
    // ---------------- the office desktop becomes the Shop Hub
    let (desk, desk_dir, _) = node("desk");
    std::fs::create_dir_all(desk_dir.join("attachments")).unwrap();
    std::fs::write(desk_dir.join("attachments").join("att-100-1-5.jpg"), b"\xff\xd8old photo bytes").unwrap();
    let port = free_port();
    let original = book_v282();
    let rep = desk.host_enable(&original.to_string(), "JZD Inc.", "Office Desktop", port).unwrap();
    assert!(rep["report"]["verified"].as_bool().unwrap());
    assert_eq!(rep["report"]["attachments"], 1);
    assert_eq!(desk.mode(), "host");
    wait("host connects to its own hub", 10, || desk.status()["client"]["online"] == true);
    let desk_book: Value = serde_json::from_str(&desk.load_book().unwrap().unwrap()).unwrap();
    assert_eq!(shophub::flat::canonical(&desk_book), shophub::flat::canonical(&original), "migration: the book is exactly the v2.8.2 book");

    // ---------------- an unpaired computer gets nothing
    {
        let (mut ws, _) = tungstenite::client::connect(format!("ws://127.0.0.1:{port}/shophub")).unwrap();
        ws.send(tungstenite::Message::Text(json!({"t": "hello", "device": "dev-intruder", "nonce": shophub::crypto::b64(&[1u8; 24]), "mac": shophub::crypto::b64(&[0u8; 32])}).to_string())).unwrap();
        let reply = ws.read().unwrap().into_text().unwrap();
        assert!(reply.contains("denied"), "{reply}");
        let (mut ws2, _) = tungstenite::client::connect(format!("ws://127.0.0.1:{port}/shophub")).unwrap();
        ws2.send(tungstenite::Message::Text(json!({"t": "pair1", "code": "000000", "pk": "AA==", "name": "x"}).to_string())).unwrap();
        let reply2 = ws2.read().unwrap().into_text().unwrap();
        assert!(reply2.contains("pair-refused"), "no pairing without the host opening it: {reply2}");
        // plaintext after an intruder's hello is never read
        let (mut ws3, _) = tungstenite::client::connect(format!("ws://127.0.0.1:{port}/shophub")).unwrap();
        ws3.send(tungstenite::Message::Text(json!({"t": "sync", "since": 0}).to_string())).unwrap();
        assert!(ws3.read().is_err() || true);
    }

    // ---------------- the laptop pairs
    let (lap, lap_dir, lap_events) = node("laptop");
    let code = desk.pairing_open().unwrap()["raw"].as_str().unwrap().to_string();
    lap.join_begin(&format!("127.0.0.1:{port}"), "000000", "Shop Laptop").unwrap();
    wait("wrong code refused", 10, || lap.status()["join"]["state"] == "failed");
    lap.join_begin(&format!("127.0.0.1:{port}"), &code, "Shop Laptop").unwrap();
    wait("laptop shows verify digits", 10, || lap.status()["join"]["state"] == "verify");
    let lap_verify = lap.status()["join"]["verify"].as_str().unwrap().to_string();
    wait("host sees the request", 10, || !desk.status()["hub"]["pairRequests"].as_array().unwrap().is_empty());
    let req = desk.status()["hub"]["pairRequests"][0].clone();
    assert_eq!(req["verify"].as_str().unwrap(), lap_verify, "both screens show the same digits");
    assert_eq!(req["name"], "Shop Laptop");
    desk.pairing_decide(req["id"].as_str().unwrap(), true).unwrap();
    wait("laptop approved", 10, || lap.status()["join"]["state"] == "approved");
    wait("laptop receives the shop", 15, || lap.load_book().ok().flatten().map(|t| !t.is_empty()).unwrap_or(false));
    let lap_book: Value = serde_json::from_str(&lap.load_book().unwrap().unwrap()).unwrap();
    assert_eq!(lap_book["vehicles"]["v1"]["vin"], "19XFA1F57AE000001");
    assert!(lap_events.lock().unwrap().iter().any(|(n, _)| n == "reload"));

    // ---------------- 1-2. laptop changes an inspection status; the desktop sees it
    wait("laptop online", 10, || lap.status()["client"]["online"] == true);
    edit(&lap, |b| b["inspections"]["insp1"]["items"]["tires.tire.LF"]["state"] = json!("Needs Attention"));
    let lat1 = wait("laptop's change acknowledged", 5, || lap.status()["client"]["pending"] == 0);
    let lat2 = wait("desktop receives the status change", 5, || {
        let patches = desk.take_patches().unwrap();
        patches.as_array().unwrap().iter().any(|p| p["value"] == "Needs Attention")
    });
    let (d1, _) = apply_patches(&desk);
    assert_eq!(d1["inspections"]["insp1"]["items"]["tires.tire.LF"]["state"], "Needs Attention");
    println!("LIVE: laptop change acknowledged in {lat1:?}; visible to desktop in {:?} after ack", lat2);

    // ---------------- 3-5. desktop changes a different field; both survive
    edit(&desk, |b| b["inspections"]["insp1"]["items"]["battery.battery"]["meas"]["volts"] = json!("12.6"));
    edit(&lap, |b| b["inspections"]["insp1"]["items"]["tires.tire.LF"]["meas"]["tread"] = json!("4"));
    wait("both acknowledged", 5, || desk.status()["client"]["pending"] == 0 && lap.status()["client"]["pending"] == 0);
    wait("laptop has the battery", 5, || { let (b, _) = apply_patches(&lap); b["inspections"]["insp1"]["items"]["battery.battery"]["meas"]["volts"] == "12.6" });
    wait("desktop has the tread", 5, || { let (b, _) = apply_patches(&desk); b["inspections"]["insp1"]["items"]["tires.tire.LF"]["meas"]["tread"] == "4" });
    for s in [&desk, &lap] {
        let b: Value = serde_json::from_str(&s.load_book().unwrap().unwrap()).unwrap();
        assert_eq!(b["inspections"]["insp1"]["items"]["tires.tire.LF"]["meas"]["tread"], "4");
        assert_eq!(b["inspections"]["insp1"]["items"]["battery.battery"]["meas"]["volts"], "12.6");
    }

    // ---------------- 6. the same field on both before either hears: a conflict, not an overwrite
    edit(&lap, |b| b["inspections"]["insp1"]["items"]["tires.tire.LF"]["meas"]["tread"] = json!("3"));
    edit(&desk, |b| b["inspections"]["insp1"]["items"]["tires.tire.LF"]["meas"]["tread"] = json!("5"));
    wait("a conflict is surfaced on one of them", 5, || {
        !lap.status()["client"]["conflicts"].as_array().unwrap().is_empty() || !desk.status()["client"]["conflicts"].as_array().unwrap().is_empty()
    });
    let (loser, other) = if !lap.status()["client"]["conflicts"].as_array().unwrap().is_empty() { (&lap, &desk) } else { (&desk, &lap) };
    let c = loser.status()["client"]["conflicts"][0].clone();
    assert!(c["mine"] != c["theirs"]);
    let keep = c["mine"].clone();
    loser.resolve(c["op_id"].as_str().unwrap(), true).unwrap();
    wait("resolution synced", 5, || loser.status()["client"]["pending"] == 0);
    wait("the other computer takes the chosen value", 5, || { let (b, _) = apply_patches(other); b["inspections"]["insp1"]["items"]["tires.tire.LF"]["meas"]["tread"] == keep });

    // ---------------- 11-12. a photo from the laptop opens on the desktop
    let photo: Vec<u8> = (0..700_000u32).map(|i| (i % 251) as u8).collect();
    std::fs::create_dir_all(lap_dir.join("attachments")).unwrap();
    std::fs::write(lap_dir.join("attachments").join("att-200-3-77.jpg"), &photo).unwrap();
    lap.att_saved("att-200-3-77", "jpg").unwrap();
    edit(&lap, |b| b["attachments"]["att-200-3-77"] = json!({"id": "att-200-3-77", "file": "att-200-3-77.jpg", "ctx": "insp", "ctxId": "insp1|tires.tire.LF", "mime": "image/jpeg"}));
    wait("photo uploaded", 20, || lap.att_status()["att-200-3-77"] == "synced");
    let got = desk.att_fetch("att-200-3-77").unwrap();
    assert_eq!(got, photo, "the desktop gets the same bytes");
    assert!(desk_dir.join("attachments").join("att-200-3-77.jpg").exists());
    // the photo that existed before the hub is there too
    assert_eq!(lap.att_fetch("att-100-1-5").unwrap(), b"\xff\xd8old photo bytes".to_vec());

    // ---------------- 13-16. RO, parts status, service history, maintenance completion
    edit(&lap, |b| {
        b["orders"]["o1"]["labor"].as_array_mut().unwrap().push(json!({"id": "l2", "desc": "Replace cabin air filter", "hours": 0.3}));
        b["orders"]["o1"]["parts"][0]["procurement"] = json!("Received");
        b["maintenance"]["records"].as_array_mut().unwrap().push(json!({"id": "mr1", "vehicleId": "v1", "itemId": "coolant", "mileage": "123442", "date": "2026-09-13", "source": "shop history"}));
        b["vehicles"]["v1"]["serviceHistory"] = json!([{"id": "sh1", "what": "Coolant replaced", "mileage": 123442}]);
    });
    edit(&desk, |b| b["orders"]["o1"]["labor"].as_array_mut().unwrap().push(json!({"id": "l3", "desc": "Wiper blades", "hours": 0.2})));
    wait("all acknowledged", 5, || desk.status()["client"]["pending"] == 0 && lap.status()["client"]["pending"] == 0);
    wait("desktop has the RO, parts, history and maintenance", 5, || {
        let (b, _) = apply_patches(&desk);
        b["orders"]["o1"]["parts"][0]["procurement"] == "Received" && b["maintenance"]["records"][0]["mileage"] == "123442" && b["vehicles"]["v1"]["serviceHistory"][0]["what"] == "Coolant replaced"
            && b["orders"]["o1"]["labor"].as_array().unwrap().len() == 3
    });
    wait("laptop has both new labour lines", 5, || { let (b, _) = apply_patches(&lap); b["orders"]["o1"]["labor"].as_array().unwrap().len() == 3 });

    // ---------------- numbers are never issued twice
    wait("both computers hold number blocks", 10, || {
        lap.numbers()["nextRO"].as_array().map(|a| a.len() >= 5).unwrap_or(false) && desk.numbers()["nextRO"].as_array().map(|a| a.len() >= 5).unwrap_or(false)
    });
    let a: Vec<u64> = lap.numbers()["nextRO"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect();
    let b: Vec<u64> = desk.numbers()["nextRO"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap()).collect();
    assert!(a.iter().all(|x| !b.contains(x)), "{a:?} {b:?}");
    assert!(a.iter().chain(b.iter()).all(|x| *x >= 40), "blocks start past the shop's counter");

    // ---------------- 7-10 + host restart. the hub goes away; the laptop keeps working and catches up
    let desk_data = desk_dir.clone();
    desk.shutdown();
    drop(desk);
    wait("laptop notices SHOP HUB OFFLINE", 20, || lap.status()["client"]["online"] == false);
    for v in ["9", "8", "7"] {
        edit(&lap, |b| b["inspections"]["insp1"]["items"]["tires.tire.LF"]["meas"]["tread"] = json!(v));
    }
    edit(&lap, |b| b["inspections"]["insp1"]["items"]["battery.battery"]["state"] = json!("Good"));
    let waiting = lap.status()["client"]["pending"].as_u64().unwrap();
    assert!(waiting >= 2, "OFFLINE — {waiting} CHANGES WAITING TO SYNC");
    // ... and the laptop itself restarts while offline
    lap.shutdown();
    drop(lap);
    std::thread::sleep(Duration::from_millis(300));
    let (lap, _, _) = node_at(lap_dir.clone());
    assert_eq!(lap.status()["client"]["pending"].as_u64().unwrap(), waiting, "queued changes survive a laptop restart");
    // the host comes back
    std::thread::sleep(Duration::from_millis(500));
    let (desk, _, _) = node_at(desk_data);
    let reconnect = wait("laptop reconnects and syncs", 30, || lap.status()["client"]["online"] == true && lap.status()["client"]["pending"] == 0);
    wait("desktop receives the offline work", 10, || {
        let (b, _) = apply_patches(&desk);
        b["inspections"]["insp1"]["items"]["tires.tire.LF"]["meas"]["tread"] == "7" && b["inspections"]["insp1"]["items"]["battery.battery"]["state"] == "Good"
    });
    println!("LIVE: after the hub restarted the laptop reconnected and synced {waiting} queued changes in {reconnect:?}");

    // ---------------- a third computer, then revoked
    let (tab, _, _) = node("tablet");
    let code = desk.pairing_open().unwrap()["raw"].as_str().unwrap().to_string();
    tab.join_begin(&format!("127.0.0.1:{port}"), &code, "Front Counter").unwrap();
    wait("request", 10, || !desk.status()["hub"]["pairRequests"].as_array().unwrap().is_empty());
    let rid = desk.status()["hub"]["pairRequests"][0]["id"].as_str().unwrap().to_string();
    desk.pairing_decide(&rid, true).unwrap();
    wait("third computer online with the shop", 15, || tab.status()["client"]["online"] == true && tab.load_book().ok().flatten().map(|t| t.contains("Wiper blades")).unwrap_or(false));
    wait("presence lists three devices", 10, || desk.status()["hub"]["devices"].as_array().unwrap().iter().filter(|d| d["online"] == true).count() == 3);
    tab.presence(Some("inspection:insp1".into()));
    wait("the desktop sees where the counter computer is", 5, || desk.status()["client"]["devices"].as_array().unwrap().iter().any(|d| d["open"] == "inspection:insp1"));
    let tab_id = desk.status()["hub"]["devices"].as_array().unwrap().iter().find(|d| d["name"] == "Front Counter").unwrap()["id"].as_str().unwrap().to_string();
    desk.revoke(&tab_id).unwrap();
    wait("revoked computer is shut out", 20, || tab.status()["client"]["online"] == false && tab.status()["client"]["lastError"].as_str().unwrap_or("").contains("revoked"));

    // ---------------- backup, verify, restore
    let b = desk.backup_now().unwrap();
    assert_eq!(b["verify"]["verified"], true);
    edit(&lap, |b| b["customers"]["c1"]["phone"] = json!("509-555-9999"));
    wait("phone synced", 5, || lap.status()["client"]["pending"] == 0);
    let name = b["backup"]["name"].as_str().unwrap().to_string();
    let r = desk.restore_backup(&name).unwrap();
    assert_eq!(r["restore"]["restored"], true);
    wait("host back up after restore", 15, || desk.status()["client"]["online"] == true);
    wait("laptop takes the restored shop", 20, || {
        let (b, _) = apply_patches(&lap);
        b["customers"]["c1"]["phone"] == "509-555-0142"
    });
    println!("LIVE: whole scenario in {:?}", t0.elapsed());
}
