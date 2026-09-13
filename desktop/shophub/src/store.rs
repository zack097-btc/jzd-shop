//! The hub's store: the one authoritative copy of the shop.
//!
//! Only the hub process opens this file. Clients never touch it; they talk to
//! the hub. Every change is a transaction that either commits whole or not at
//! all, and is flushed to disk before anyone is told it happened.
//!
//! Each field of the book is a leaf with a revision. A change names the
//! revision it was based on. If that is still the current revision the change
//! applies; if the field already holds the same value it is acknowledged as it
//! stands; otherwise it is a conflict and nothing is overwritten.

use crate::flat::{self, Leaves};
use redb::{Database, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const LEAVES: TableDefinition<&str, &str> = TableDefinition::new("leaves");
const LOG: TableDefinition<u64, &str> = TableDefinition::new("log");
const OPS: TableDefinition<&str, &str> = TableDefinition::new("ops");
const DEVICES: TableDefinition<&str, &str> = TableDefinition::new("devices");
const META: TableDefinition<&str, &str> = TableDefinition::new("meta");
const ATTS: TableDefinition<&str, &str> = TableDefinition::new("atts");

pub const SCHEMA_VERSION: u64 = 1;
/// The largest single field value accepted, as JSON text.
pub const MAX_VALUE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Op {
    /// Unique per change, chosen by the device. A retried change with the same
    /// id is answered exactly as it was the first time.
    pub id: String,
    /// The field, as a path string.
    pub p: String,
    /// The revision this change was based on. 0 means "did not exist".
    pub b: u64,
    /// The new value; None removes the field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "k")]
pub enum OpResult {
    #[serde(rename = "ok")]
    Ok { id: String, r: u64 },
    /// The field changed elsewhere first. `v` is what it holds now.
    #[serde(rename = "conflict")]
    Conflict { id: String, r: u64, #[serde(default)] v: Option<Value>, d: String, t: String },
    /// Array order: both sides' elements kept, in the hub's order.
    #[serde(rename = "merged")]
    Merged { id: String, r: u64, v: Value },
    #[serde(rename = "rejected")]
    Rejected { id: String, why: String },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Change {
    pub p: String,
    pub r: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<Value>,
    pub d: String,
    pub t: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct LeafRec {
    r: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    v: Option<Value>,
    d: String,
    t: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub created: String,
    #[serde(default)]
    pub revoked: bool,
    #[serde(default)]
    pub last_seen: String,
    #[serde(default)]
    pub host: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct ImportReport {
    pub leaves: usize,
    pub counts: std::collections::BTreeMap<String, usize>,
    pub book_sha256: String,
    pub verified: bool,
    pub attachments: usize,
    pub attachments_bytes: u64,
}

pub struct HubStore {
    db: Database,
    dir: PathBuf,
}

fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

pub fn now_iso() -> String {
    // seconds are plenty for ordering revisions a person will read
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    iso_from_secs(secs)
}

pub fn iso_from_secs(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let s = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    if m <= 2 {
        y += 1;
    }
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z", s / 3600, (s / 60) % 60, s % 60)
}

/// Array order leaves end in `"#"]`.
fn is_order_path(p: &str) -> bool {
    p.ends_with(",\"#\"]")
}

fn merge_order(theirs: &Value, mine: &Value) -> Value {
    let mut out: Vec<Value> = theirs.as_array().cloned().unwrap_or_default();
    for m in mine.as_array().cloned().unwrap_or_default() {
        if !out.contains(&m) {
            out.push(m);
        }
    }
    Value::Array(out)
}

impl HubStore {
    pub fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir).map_err(e)?;
        std::fs::create_dir_all(dir.join("attachments")).map_err(e)?;
        let db = Database::create(dir.join("shop.redb")).map_err(e)?;
        {
            let w = db.begin_write().map_err(e)?;
            w.open_table(LEAVES).map_err(e)?;
            w.open_table(LOG).map_err(e)?;
            w.open_table(OPS).map_err(e)?;
            w.open_table(DEVICES).map_err(e)?;
            w.open_table(META).map_err(e)?;
            w.open_table(ATTS).map_err(e)?;
            w.commit().map_err(e)?;
        }
        Ok(HubStore { db, dir: dir.to_path_buf() })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn meta(&self, key: &str) -> Result<Option<Value>, String> {
        let r = self.db.begin_read().map_err(e)?;
        let t = r.open_table(META).map_err(e)?;
        Ok(match t.get(key).map_err(e)? {
            Some(v) => serde_json::from_str(v.value()).ok(),
            None => None,
        })
    }

    pub fn set_meta(&self, key: &str, value: &Value) -> Result<(), String> {
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut t = w.open_table(META).map_err(e)?;
            t.insert(key, value.to_string().as_str()).map_err(e)?;
        }
        w.commit().map_err(e)
    }

    pub fn seq(&self) -> Result<u64, String> {
        Ok(self.meta("seq")?.and_then(|v| v.as_u64()).unwrap_or(0))
    }

    pub fn initialized(&self) -> bool {
        self.meta("initializedAt").ok().flatten().is_some()
    }

    pub fn shop_id(&self) -> String {
        self.meta("shopId").ok().flatten().and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_default()
    }

    pub fn epoch(&self) -> String {
        self.meta("epoch").ok().flatten().and_then(|v| v.as_str().map(|s| s.to_string())).unwrap_or_default()
    }

    /// Load a whole book into an empty hub, then prove it went in exactly: the
    /// book rebuilt from the hub must be identical to the book given.
    pub fn import_book(&self, book: &Value, device: &str) -> Result<ImportReport, String> {
        if !book.is_object() {
            return Err("the book is not a shop book".into());
        }
        if self.seq()? > 0 || self.initialized() {
            return Err("this hub already holds a shop; nothing was imported".into());
        }
        let leaves = flat::flatten(book);
        let t = now_iso();
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut lt = w.open_table(LEAVES).map_err(e)?;
            let mut lg = w.open_table(LOG).map_err(e)?;
            let mut seq = 0u64;
            for (p, v) in &leaves {
                seq += 1;
                let rec = LeafRec { r: seq, v: Some(v.clone()), d: device.into(), t: t.clone() };
                lt.insert(p.as_str(), serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
                lg.insert(seq, p.as_str()).map_err(e)?;
            }
            let mut mt = w.open_table(META).map_err(e)?;
            mt.insert("seq", json!(seq).to_string().as_str()).map_err(e)?;
            mt.insert("schema", json!(SCHEMA_VERSION).to_string().as_str()).map_err(e)?;
        }
        w.commit().map_err(e)?;
        let back = self.book()?;
        let mut report = ImportReport { leaves: leaves.len(), ..Default::default() };
        if let Some(m) = book.as_object() {
            for (k, v) in m {
                let n = match v {
                    Value::Object(o) => o.len(),
                    Value::Array(a) => a.len(),
                    _ => 1,
                };
                report.counts.insert(k.clone(), n);
            }
        }
        report.book_sha256 = flat::sha256_hex(flat::canonical(book).as_bytes());
        report.verified = flat::canonical(&back) == flat::canonical(book);
        if !report.verified {
            return Err("the book read back from the hub does not match the book imported".into());
        }
        Ok(report)
    }

    pub fn mark_initialized(&self, shop_id: &str, shop_name: &str, report: &ImportReport) -> Result<(), String> {
        self.set_meta("shopId", &json!(shop_id))?;
        self.set_meta("shopName", &json!(shop_name))?;
        self.set_meta("epoch", &json!(shop_id))?;
        self.set_meta("importReport", &serde_json::to_value(report).map_err(e)?)?;
        self.set_meta("initializedAt", &json!(now_iso()))
    }

    /// Apply a batch of changes from one device, in one transaction.
    pub fn apply(&self, device: &str, ops: &[Op]) -> Result<(Vec<OpResult>, Vec<Change>), String> {
        let t = now_iso();
        let w = self.db.begin_write().map_err(e)?;
        let mut results = Vec::with_capacity(ops.len());
        let mut changes = Vec::new();
        {
            let mut lt = w.open_table(LEAVES).map_err(e)?;
            let mut lg = w.open_table(LOG).map_err(e)?;
            let mut ot = w.open_table(OPS).map_err(e)?;
            let mut mt = w.open_table(META).map_err(e)?;
            let mut seq: u64 = match mt.get("seq").map_err(e)? {
                Some(v) => v.value().parse().unwrap_or(0),
                None => 0,
            };
            for op in ops {
                if let Some(prev) = ot.get(op.id.as_str()).map_err(e)? {
                    if let Ok(r) = serde_json::from_str::<OpResult>(prev.value()) {
                        results.push(r);
                        continue;
                    }
                }
                if flat::parse_path(&op.p).is_none() || op.id.is_empty() || op.id.len() > 80 {
                    results.push(OpResult::Rejected { id: op.id.clone(), why: "bad change".into() });
                    continue;
                }
                if let Some(v) = &op.v {
                    if v.to_string().len() > MAX_VALUE_BYTES {
                        results.push(OpResult::Rejected { id: op.id.clone(), why: "value too large".into() });
                        continue;
                    }
                }
                let cur: Option<LeafRec> = match lt.get(op.p.as_str()).map_err(e)? {
                    Some(v) => serde_json::from_str(v.value()).ok(),
                    None => None,
                };
                let (cur_r, cur_v) = match &cur {
                    Some(c) => (c.r, c.v.clone()),
                    None => (0, None),
                };
                let result = if op.b == cur_r {
                    seq += 1;
                    let rec = LeafRec { r: seq, v: op.v.clone(), d: device.into(), t: t.clone() };
                    lt.insert(op.p.as_str(), serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
                    lg.insert(seq, op.p.as_str()).map_err(e)?;
                    changes.push(Change { p: op.p.clone(), r: seq, v: op.v.clone(), d: device.into(), t: t.clone() });
                    OpResult::Ok { id: op.id.clone(), r: seq }
                } else if cur_v == op.v {
                    OpResult::Ok { id: op.id.clone(), r: cur_r }
                } else if is_order_path(&op.p) && op.v.is_some() && cur_v.is_some() {
                    let merged = merge_order(cur_v.as_ref().unwrap(), op.v.as_ref().unwrap());
                    if Some(&merged) == cur_v.as_ref() {
                        OpResult::Merged { id: op.id.clone(), r: cur_r, v: merged }
                    } else {
                        seq += 1;
                        let rec = LeafRec { r: seq, v: Some(merged.clone()), d: device.into(), t: t.clone() };
                        lt.insert(op.p.as_str(), serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
                        lg.insert(seq, op.p.as_str()).map_err(e)?;
                        changes.push(Change { p: op.p.clone(), r: seq, v: Some(merged.clone()), d: device.into(), t: t.clone() });
                        OpResult::Merged { id: op.id.clone(), r: seq, v: merged }
                    }
                } else if is_order_path(&op.p) && op.v.is_none() {
                    // an array emptied on one side while the other still has order: keep theirs
                    OpResult::Merged { id: op.id.clone(), r: cur_r, v: cur_v.clone().unwrap_or(Value::Array(vec![])) }
                } else {
                    let c = cur.unwrap_or(LeafRec { r: 0, v: None, d: String::new(), t: String::new() });
                    OpResult::Conflict { id: op.id.clone(), r: c.r, v: c.v, d: c.d, t: c.t }
                };
                ot.insert(op.id.as_str(), serde_json::to_string(&result).map_err(e)?.as_str()).map_err(e)?;
                results.push(result);
            }
            mt.insert("seq", seq.to_string().as_str()).map_err(e)?;
        }
        w.commit().map_err(e)?;
        Ok((results, changes))
    }

    /// Everything changed after `since`. A device that has never synced, or is
    /// from a different epoch, gets the whole shop instead.
    pub fn changes_since(&self, since: u64) -> Result<(bool, u64, Vec<Change>), String> {
        let r = self.db.begin_read().map_err(e)?;
        let lt = r.open_table(LEAVES).map_err(e)?;
        let seq = self.seq()?;
        if since == 0 || since > seq {
            let mut out = Vec::new();
            for item in lt.iter().map_err(e)? {
                let (k, v) = item.map_err(e)?;
                if let Ok(rec) = serde_json::from_str::<LeafRec>(v.value()) {
                    if rec.v.is_some() {
                        out.push(Change { p: k.value().to_string(), r: rec.r, v: rec.v, d: rec.d, t: rec.t });
                    }
                }
            }
            return Ok((true, seq, out));
        }
        let lg = r.open_table(LOG).map_err(e)?;
        let mut paths = std::collections::BTreeSet::new();
        for item in lg.range((since + 1)..).map_err(e)? {
            let (_, p) = item.map_err(e)?;
            paths.insert(p.value().to_string());
        }
        let mut out = Vec::new();
        for p in paths {
            if let Some(v) = lt.get(p.as_str()).map_err(e)? {
                if let Ok(rec) = serde_json::from_str::<LeafRec>(v.value()) {
                    out.push(Change { p, r: rec.r, v: rec.v, d: rec.d, t: rec.t });
                }
            }
        }
        Ok((false, seq, out))
    }

    pub fn leaves(&self) -> Result<Leaves, String> {
        let r = self.db.begin_read().map_err(e)?;
        let lt = r.open_table(LEAVES).map_err(e)?;
        let mut out = Leaves::new();
        for item in lt.iter().map_err(e)? {
            let (k, v) = item.map_err(e)?;
            if let Ok(rec) = serde_json::from_str::<LeafRec>(v.value()) {
                if let Some(val) = rec.v {
                    out.insert(k.value().to_string(), val);
                }
            }
        }
        Ok(out)
    }

    /// Leaves with their revisions, including removed fields (tombstones).
    pub fn dump(&self) -> Result<Vec<Value>, String> {
        let r = self.db.begin_read().map_err(e)?;
        let lt = r.open_table(LEAVES).map_err(e)?;
        let mut out = Vec::new();
        for item in lt.iter().map_err(e)? {
            let (k, v) = item.map_err(e)?;
            let rec: Value = serde_json::from_str(v.value()).map_err(e)?;
            out.push(json!({"p": k.value(), "rec": rec}));
        }
        Ok(out)
    }

    /// Rebuild an empty store from a dump taken by `dump`.
    pub fn load_dump(&self, rows: &[Value], seq: u64) -> Result<(), String> {
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut lt = w.open_table(LEAVES).map_err(e)?;
            let mut lg = w.open_table(LOG).map_err(e)?;
            for row in rows {
                let p = row["p"].as_str().ok_or("bad dump row")?;
                let rec: LeafRec = serde_json::from_value(row["rec"].clone()).map_err(e)?;
                lg.insert(rec.r, p).map_err(e)?;
                lt.insert(p, serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
            }
            let mut mt = w.open_table(META).map_err(e)?;
            mt.insert("seq", seq.to_string().as_str()).map_err(e)?;
        }
        w.commit().map_err(e)
    }

    pub fn book(&self) -> Result<Value, String> {
        let leaves = self.leaves()?;
        Ok(flat::unflatten(leaves.iter()))
    }

    // ---------------- devices

    pub fn devices(&self) -> Result<Vec<Device>, String> {
        let r = self.db.begin_read().map_err(e)?;
        let t = r.open_table(DEVICES).map_err(e)?;
        let mut out = Vec::new();
        for item in t.iter().map_err(e)? {
            let (_, v) = item.map_err(e)?;
            if let Ok(d) = serde_json::from_str::<Device>(v.value()) {
                out.push(d);
            }
        }
        Ok(out)
    }

    pub fn device(&self, id: &str) -> Result<Option<Device>, String> {
        let r = self.db.begin_read().map_err(e)?;
        let t = r.open_table(DEVICES).map_err(e)?;
        Ok(match t.get(id).map_err(e)? {
            Some(v) => serde_json::from_str(v.value()).ok(),
            None => None,
        })
    }

    pub fn put_device(&self, d: &Device) -> Result<(), String> {
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut t = w.open_table(DEVICES).map_err(e)?;
            t.insert(d.id.as_str(), serde_json::to_string(d).map_err(e)?.as_str()).map_err(e)?;
        }
        w.commit().map_err(e)
    }

    // ---------------- numbers

    /// Hand a device a block of numbers of one kind (estimate, RO, invoice,
    /// inspection, PO). The shop's counter moves past the whole block in the
    /// same transaction, so two computers can never issue the same number.
    pub fn reserve_numbers(&self, device: &str, key: &str, count: u64) -> Result<(u64, Vec<Change>), String> {
        if !["nextEstimate", "nextRO", "nextInvoice", "nextInspection", "nextPO"].contains(&key) || count == 0 || count > 500 {
            return Err("bad number reservation".into());
        }
        let p = flat::path_string(&["settings".to_string(), key.to_string()]);
        let t = now_iso();
        let w = self.db.begin_write().map_err(e)?;
        let start;
        let mut changes = Vec::new();
        {
            let mut lt = w.open_table(LEAVES).map_err(e)?;
            let mut lg = w.open_table(LOG).map_err(e)?;
            let mut mt = w.open_table(META).map_err(e)?;
            let mut seq: u64 = match mt.get("seq").map_err(e)? {
                Some(v) => v.value().parse().unwrap_or(0),
                None => 0,
            };
            let cur: Option<LeafRec> = match lt.get(p.as_str()).map_err(e)? {
                Some(v) => serde_json::from_str(v.value()).ok(),
                None => None,
            };
            let n = cur
                .as_ref()
                .and_then(|c| c.v.as_ref())
                .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.trim().parse().ok())).or_else(|| v.as_f64().map(|f| f as u64)))
                .unwrap_or(1)
                .max(1);
            start = n;
            seq += 1;
            let nv = json!(n + count);
            let rec = LeafRec { r: seq, v: Some(nv.clone()), d: device.into(), t: t.clone() };
            lt.insert(p.as_str(), serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
            lg.insert(seq, p.as_str()).map_err(e)?;
            mt.insert("seq", seq.to_string().as_str()).map_err(e)?;
            changes.push(Change { p, r: seq, v: Some(nv), d: device.into(), t });
        }
        w.commit().map_err(e)?;
        Ok((start, changes))
    }

    // ---------------- attachments

    pub fn att_meta(&self, id: &str) -> Result<Option<Value>, String> {
        let r = self.db.begin_read().map_err(e)?;
        let t = r.open_table(ATTS).map_err(e)?;
        Ok(match t.get(id).map_err(e)? {
            Some(v) => serde_json::from_str(v.value()).ok(),
            None => None,
        })
    }

    pub fn put_att_meta(&self, id: &str, meta: &Value) -> Result<(), String> {
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut t = w.open_table(ATTS).map_err(e)?;
            t.insert(id, meta.to_string().as_str()).map_err(e)?;
        }
        w.commit().map_err(e)
    }

    pub fn att_all(&self) -> Result<Vec<Value>, String> {
        let r = self.db.begin_read().map_err(e)?;
        let t = r.open_table(ATTS).map_err(e)?;
        let mut out = Vec::new();
        for item in t.iter().map_err(e)? {
            let (_, v) = item.map_err(e)?;
            if let Ok(m) = serde_json::from_str::<Value>(v.value()) {
                out.push(m);
            }
        }
        Ok(out)
    }

    pub fn att_dir(&self) -> PathBuf {
        self.dir.join("attachments")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("shophub-store-{tag}-{}-{}", std::process::id(), crate::util::rand_hex(4)));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn p(segs: &[&str]) -> String {
        flat::path_string(&segs.iter().map(|s| s.to_string()).collect::<Vec<_>>())
    }

    #[test]
    fn a_null_is_kept_as_null_not_dropped() {
        // v2.8.2 books hold nulls (maintItems miles/months, completedAt, roNo)
        let s = HubStore::open(&tmp("null")).unwrap();
        let book = json!({"settings": {"maintItems": [{"id": "oil", "miles": null, "months": null}]}, "inspections": {"i1": {"completedAt": null, "roNo": "7"}}});
        let rep = s.import_book(&book, "host").unwrap();
        assert!(rep.verified);
        assert_eq!(flat::canonical(&s.book().unwrap()), flat::canonical(&book));
        let ro = p(&["inspections", "i1", "roNo"]);
        let r = s.changes_since(0).unwrap().2.iter().find(|c| c.p == ro).unwrap().r;
        let flat_null = flat::flatten(&json!({"inspections": {"i1": {"roNo": null}}}));
        let (res, _) = s.apply("laptop", &[Op { id: "n1".into(), p: ro.clone(), b: r, v: Some(flat_null[&ro].clone()) }]).unwrap();
        assert!(matches!(res[0], OpResult::Ok { .. }), "{res:?}");
        assert_eq!(s.book().unwrap()["inspections"]["i1"], json!({"completedAt": null, "roNo": null}));
    }

    #[test]
    fn different_fields_both_survive_and_the_same_field_conflicts() {
        let s = HubStore::open(&tmp("merge")).unwrap();
        let book = json!({"inspections": {"i1": {"items": {"tires.tire.LF": {"meas": {"tread": "6"}}, "battery.battery": {"meas": {"volts": "12.4"}}}}}});
        s.import_book(&book, "host").unwrap();
        let tread = p(&["inspections", "i1", "items", "tires.tire.LF", "meas", "tread"]);
        let volts = p(&["inspections", "i1", "items", "battery.battery", "meas", "volts"]);
        let changes = s.changes_since(0).unwrap().2;
        let rev = |path: &str| changes.iter().find(|c| c.p == path).unwrap().r;
        let (rt, rv) = (rev(&tread), rev(&volts));
        // laptop changes tread, desktop changes volts, from the same starting point
        let (a, _) = s.apply("laptop", &[Op { id: "a1".into(), p: tread.clone(), b: rt, v: Some(json!("4")) }]).unwrap();
        let (b, _) = s.apply("desktop", &[Op { id: "b1".into(), p: volts.clone(), b: rv, v: Some(json!("12.6")) }]).unwrap();
        assert!(matches!(a[0], OpResult::Ok { .. }) && matches!(b[0], OpResult::Ok { .. }));
        let now = s.book().unwrap();
        assert_eq!(now["inspections"]["i1"]["items"]["tires.tire.LF"]["meas"]["tread"], "4");
        assert_eq!(now["inspections"]["i1"]["items"]["battery.battery"]["meas"]["volts"], "12.6");
        // desktop now changes tread too, still based on the old revision
        let (c, ch) = s.apply("desktop", &[Op { id: "b2".into(), p: tread.clone(), b: rt, v: Some(json!("5")) }]).unwrap();
        match &c[0] {
            OpResult::Conflict { v, d, .. } => {
                assert_eq!(v.as_ref().unwrap(), &json!("4"));
                assert_eq!(d, "laptop");
            }
            other => panic!("expected a conflict, got {other:?}"),
        }
        assert!(ch.is_empty(), "a conflict changes nothing");
        assert_eq!(s.book().unwrap()["inspections"]["i1"]["items"]["tires.tire.LF"]["meas"]["tread"], "4");
        // a retried change is answered exactly as before and not applied twice
        let seq_before = s.seq().unwrap();
        let (again, _) = s.apply("laptop", &[Op { id: "a1".into(), p: tread.clone(), b: rt, v: Some(json!("4")) }]).unwrap();
        assert_eq!(again[0], a[0]);
        assert_eq!(s.seq().unwrap(), seq_before);
        // the same value arriving from both sides is not a conflict
        let (same, _) = s.apply("desktop", &[Op { id: "b3".into(), p: tread.clone(), b: rt, v: Some(json!("4")) }]).unwrap();
        assert!(matches!(same[0], OpResult::Ok { .. }));
    }

    #[test]
    fn two_new_labour_lines_added_at_once_both_stay_in_order() {
        let s = HubStore::open(&tmp("order")).unwrap();
        let book = json!({"orders": {"o1": {"labor": [{"id": "l1", "desc": "Oil"}]}}});
        s.import_book(&book, "host").unwrap();
        let before = flat::flatten(&book);
        let mut a = book.clone();
        a["orders"]["o1"]["labor"].as_array_mut().unwrap().push(json!({"id": "l2", "desc": "Brakes"}));
        let mut b = book.clone();
        b["orders"]["o1"]["labor"].as_array_mut().unwrap().push(json!({"id": "l3", "desc": "Wipers"}));
        let revs: std::collections::HashMap<String, u64> = s.changes_since(0).unwrap().2.into_iter().map(|c| (c.p, c.r)).collect();
        let to_ops = |dev: &str, book: &Value| -> Vec<Op> {
            flat::diff(&before, &flat::flatten(book))
                .into_iter()
                .enumerate()
                .map(|(i, (path, v))| Op { id: format!("{dev}{i}"), b: *revs.get(&path).unwrap_or(&0), p: path, v })
                .collect()
        };
        s.apply("laptop", &to_ops("a", &a)).unwrap();
        let (res, _) = s.apply("desktop", &to_ops("b", &b)).unwrap();
        assert!(res.iter().any(|r| matches!(r, OpResult::Merged { .. })), "{res:?}");
        let now = s.book().unwrap();
        let descs: Vec<_> = now["orders"]["o1"]["labor"].as_array().unwrap().iter().map(|l| l["desc"].as_str().unwrap().to_string()).collect();
        assert_eq!(descs, vec!["Oil", "Brakes", "Wipers"]);
    }

    #[test]
    fn an_import_is_proved_and_numbers_are_never_issued_twice() {
        let s = HubStore::open(&tmp("import")).unwrap();
        let book = json!({"settings": {"nextRO": 41, "shopName": "JZD"}, "orders": {"o1": {"id": "o1"}}, "movements": [{"q": 1}, {"q": 1}]});
        let rep = s.import_book(&book, "host").unwrap();
        assert!(rep.verified && rep.counts["orders"] == 1 && rep.counts["movements"] == 2);
        assert!(s.import_book(&book, "host").is_err(), "a hub never imports on top of a shop");
        let (a, _) = s.reserve_numbers("laptop", "nextRO", 25).unwrap();
        let (b, _) = s.reserve_numbers("desktop", "nextRO", 25).unwrap();
        assert_eq!((a, b), (41, 66));
        assert_eq!(s.book().unwrap()["settings"]["nextRO"], 91);
        assert!(s.reserve_numbers("x", "laborRate", 5).is_err());
    }
}
