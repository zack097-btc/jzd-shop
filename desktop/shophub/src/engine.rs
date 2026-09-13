//! A computer's own replica of the shop.
//!
//! Three things are kept, durably, on every computer connected to the hub:
//!
//!   * the PAGE view - every field exactly as this computer's screen has it,
//!     with the hub revision it was based on;
//!   * the queue of changes made here that the hub has not yet acknowledged;
//!   * changes the hub has sent that the screen has not applied yet.
//!
//! A change typed here becomes a queued operation based on the revision the
//! screen saw. A change from another computer is applied to the screen only
//! where this computer has nothing waiting on the same field; where it does,
//! the hub decides and a real conflict is shown to the person. Nothing is
//! "synced" until the hub has acknowledged it.

use crate::flat::{self, Leaves};
use crate::store::{Change, Op, OpResult};
use crate::util;
use redb::{Database, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

const PAGE: TableDefinition<&str, &str> = TableDefinition::new("page");
const PENDING: TableDefinition<u64, &str> = TableDefinition::new("pending");
const META: TableDefinition<&str, &str> = TableDefinition::new("meta");
const NUMS: TableDefinition<&str, &str> = TableDefinition::new("nums");
const ATTUP: TableDefinition<&str, &str> = TableDefinition::new("attup");

fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct SrvVal {
    #[serde(default)]
    pub v: Option<Value>,
    pub r: u64,
    #[serde(default)]
    pub d: String,
    #[serde(default)]
    pub t: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct PageRec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    v: Option<Value>,
    #[serde(default)]
    r: u64,
    /// What the hub holds, when the screen has not caught up with it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    srv: Option<SrvVal>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum PendState {
    Queued,
    Sent,
    /// Another change to the same field is still in flight; this one waits for
    /// its acknowledgement so it can be based on the right revision.
    Waiting,
    Conflict,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Pend {
    op: Op,
    state: PendState,
    at: u64,
    #[serde(default)]
    theirs: Option<SrvVal>,
    /// Which save of the screen this belongs to (one save = one change).
    #[serde(default)]
    batch: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct ConflictInfo {
    pub op_id: String,
    pub path: Vec<String>,
    pub mine: Option<Value>,
    pub theirs: Option<Value>,
    pub their_device: String,
    pub their_time: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct Patch {
    /// The object path the page sets, as a path string; also the id used to
    /// confirm it was applied.
    pub id: String,
    pub path: Vec<String>,
    #[serde(default)]
    pub value: Option<Value>,
    /// True when the value was removed; `value` null with `del` false is a
    /// real JSON null.
    #[serde(default)]
    pub del: bool,
    pub device: String,
}

pub struct Engine {
    db: Database,
    dir: PathBuf,
}

fn load<T: for<'de> Deserialize<'de> + Default>(s: Option<redb::AccessGuard<&str>>) -> T {
    s.and_then(|g| serde_json::from_str(g.value()).ok()).unwrap_or_default()
}

impl Engine {
    pub fn open(dir: &Path) -> Result<Engine, String> {
        std::fs::create_dir_all(dir).map_err(e)?;
        let db = Database::create(dir.join("replica.redb")).map_err(e)?;
        {
            let w = db.begin_write().map_err(e)?;
            w.open_table(PAGE).map_err(e)?;
            w.open_table(PENDING).map_err(e)?;
            w.open_table(META).map_err(e)?;
            w.open_table(NUMS).map_err(e)?;
            w.open_table(ATTUP).map_err(e)?;
            w.commit().map_err(e)?;
        }
        Ok(Engine { db, dir: dir.to_path_buf() })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn meta(&self, key: &str) -> Option<Value> {
        let r = self.db.begin_read().ok()?;
        let t = r.open_table(META).ok()?;
        let g = t.get(key).ok()??;
        serde_json::from_str(g.value()).ok()
    }

    pub fn set_meta(&self, key: &str, v: &Value) -> Result<(), String> {
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut t = w.open_table(META).map_err(e)?;
            t.insert(key, v.to_string().as_str()).map_err(e)?;
        }
        w.commit().map_err(e)
    }

    pub fn last_seq(&self) -> u64 {
        self.meta("lastSeq").and_then(|v| v.as_u64()).unwrap_or(0)
    }

    pub fn initialized(&self) -> bool {
        self.meta("initialized").and_then(|v| v.as_bool()).unwrap_or(false)
    }

    /// Replace everything with the hub's shop. Used once, when a computer
    /// first joins, and never while it has changes waiting.
    pub fn adopt_snapshot(&self, changes: &[Change], seq: u64, epoch: &str) -> Result<(), String> {
        let w = self.db.begin_write().map_err(e)?;
        {
            if w.open_table(PENDING).map_err(e)?.iter().map_err(e)?.next().is_some() {
                return Err("this computer has changes waiting; it will not replace them with the hub's copy".into());
            }
            let mut pt = w.open_table(PAGE).map_err(e)?;
            let keys: Vec<String> = pt.iter().map_err(e)?.filter_map(|x| x.ok()).map(|(k, _)| k.value().to_string()).collect();
            for k in keys {
                pt.remove(k.as_str()).map_err(e)?;
            }
            for c in changes {
                let rec = PageRec { v: c.v.clone(), r: c.r, srv: None };
                pt.insert(c.p.as_str(), serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
            }
            let mut mt = w.open_table(META).map_err(e)?;
            mt.insert("lastSeq", json!(seq).to_string().as_str()).map_err(e)?;
            mt.insert("epoch", json!(epoch).to_string().as_str()).map_err(e)?;
            mt.insert("initialized", "true").map_err(e)?;
        }
        w.commit().map_err(e)
    }

    fn page_leaves(&self) -> Result<Leaves, String> {
        let r = self.db.begin_read().map_err(e)?;
        let t = r.open_table(PAGE).map_err(e)?;
        let mut out = Leaves::new();
        for item in t.iter().map_err(e)? {
            let (k, v) = item.map_err(e)?;
            let rec: PageRec = serde_json::from_str(v.value()).map_err(e)?;
            if let Some(val) = rec.v {
                out.insert(k.value().to_string(), val);
            }
        }
        Ok(out)
    }

    /// The book exactly as this computer's screen last had it.
    pub fn book(&self) -> Result<Value, String> {
        let l = self.page_leaves()?;
        Ok(flat::unflatten(l.iter()))
    }

    /// The screen saved. Queue a change for every field that differs from what
    /// the screen last had, based on the revision the screen saw.
    pub fn save_book(&self, book: &Value) -> Result<usize, String> {
        let new = flat::flatten(book);
        let old = self.page_leaves()?;
        let diff = flat::diff(&old, &new);
        if diff.is_empty() {
            return Ok(0);
        }
        let now = util::now_ms();
        let w = self.db.begin_write().map_err(e)?;
        let mut added = 0;
        {
            let mut pt = w.open_table(PAGE).map_err(e)?;
            let mut qt = w.open_table(PENDING).map_err(e)?;
            let mut by_path: BTreeMap<String, Vec<(u64, Pend)>> = BTreeMap::new();
            let mut max_key = 0u64;
            let mut batch = 0u64;
            for item in qt.iter().map_err(e)? {
                let (k, v) = item.map_err(e)?;
                max_key = max_key.max(k.value());
                let p: Pend = serde_json::from_str(v.value()).map_err(e)?;
                batch = batch.max(p.batch);
                by_path.entry(p.op.p.clone()).or_default().push((k.value(), p));
            }
            let batch = batch.max(max_key) + 1;
            for (path, value) in diff {
                let mut rec: PageRec = load(pt.get(path.as_str()).map_err(e)?);
                let existing = by_path.get(&path).cloned().unwrap_or_default();
                if let Some((k, mut q)) = existing.iter().find(|(_, p)| p.state == PendState::Queued || p.state == PendState::Waiting).cloned() {
                    q.op.v = value.clone();
                    q.at = now;
                    q.batch = batch;
                    qt.insert(k, serde_json::to_string(&q).map_err(e)?.as_str()).map_err(e)?;
                } else if !existing.is_empty() {
                    // in flight or in conflict: wait behind it
                    max_key += 1;
                    let op = Op { id: format!("{}-{}", util::rand_hex(6), max_key), p: path.clone(), b: 0, v: value.clone() };
                    let state = if existing.iter().any(|(_, p)| p.state == PendState::Conflict) { PendState::Waiting } else { PendState::Waiting };
                    qt.insert(max_key, serde_json::to_string(&Pend { op, state, at: now, theirs: None, batch }).map_err(e)?.as_str()).map_err(e)?;
                    added += 1;
                } else {
                    max_key += 1;
                    let op = Op { id: format!("{}-{}", util::rand_hex(6), max_key), p: path.clone(), b: rec.r, v: value.clone() };
                    qt.insert(max_key, serde_json::to_string(&Pend { op, state: PendState::Queued, at: now, theirs: None, batch }).map_err(e)?.as_str()).map_err(e)?;
                    added += 1;
                }
                rec.v = value;
                pt.insert(path.as_str(), serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
            }
        }
        w.commit().map_err(e)?;
        Ok(added)
    }

    fn pending(&self) -> Result<Vec<(u64, Pend)>, String> {
        let r = self.db.begin_read().map_err(e)?;
        let t = r.open_table(PENDING).map_err(e)?;
        let mut out = Vec::new();
        for item in t.iter().map_err(e)? {
            let (k, v) = item.map_err(e)?;
            out.push((k.value(), serde_json::from_str(v.value()).map_err(e)?));
        }
        Ok(out)
    }

    /// Changes ready to send, oldest first.
    pub fn outgoing(&self, max: usize) -> Result<Vec<Op>, String> {
        Ok(self.pending()?.into_iter().filter(|(_, p)| p.state == PendState::Queued).take(max).map(|(_, p)| p.op).collect())
    }

    pub fn mark_sent(&self, ids: &[String]) -> Result<(), String> {
        self.set_state(ids, PendState::Queued, PendState::Sent)
    }

    /// After a reconnect: anything sent but never acknowledged goes again. The
    /// hub answers a repeated change id exactly as it did the first time.
    pub fn requeue_sent(&self) -> Result<(), String> {
        let all: Vec<String> = self.pending()?.into_iter().filter(|(_, p)| p.state == PendState::Sent).map(|(_, p)| p.op.id).collect();
        self.set_state(&all, PendState::Sent, PendState::Queued)
    }

    fn set_state(&self, ids: &[String], from: PendState, to: PendState) -> Result<(), String> {
        if ids.is_empty() {
            return Ok(());
        }
        let want: BTreeSet<&String> = ids.iter().collect();
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut qt = w.open_table(PENDING).map_err(e)?;
            let rows: Vec<(u64, Pend)> = qt.iter().map_err(e)?.filter_map(|x| x.ok()).filter_map(|(k, v)| serde_json::from_str::<Pend>(v.value()).ok().map(|p| (k.value(), p))).collect();
            for (k, mut p) in rows {
                if want.contains(&p.op.id) && p.state == from {
                    p.state = to.clone();
                    qt.insert(k, serde_json::to_string(&p).map_err(e)?.as_str()).map_err(e)?;
                }
            }
        }
        w.commit().map_err(e)
    }

    /// The hub's answers to changes sent from here.
    pub fn on_results(&self, results: &[OpResult]) -> Result<Vec<ConflictInfo>, String> {
        let mut conflicts = Vec::new();
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut pt = w.open_table(PAGE).map_err(e)?;
            let mut qt = w.open_table(PENDING).map_err(e)?;
            let mut rows: Vec<(u64, Pend)> = qt.iter().map_err(e)?.filter_map(|x| x.ok()).filter_map(|(k, v)| serde_json::from_str::<Pend>(v.value()).ok().map(|p| (k.value(), p))).collect();
            for res in results {
                let id = match res {
                    OpResult::Ok { id, .. } | OpResult::Conflict { id, .. } | OpResult::Merged { id, .. } | OpResult::Rejected { id, .. } => id,
                };
                let Some(pos) = rows.iter().position(|(_, p)| &p.op.id == id) else { continue };
                let (key, pend) = rows[pos].clone();
                let path = pend.op.p.clone();
                let mut rec: PageRec = load(pt.get(path.as_str()).map_err(e)?);
                match res {
                    OpResult::Ok { r, .. } | OpResult::Merged { r, .. } => {
                        qt.remove(key).map_err(e)?;
                        rows.remove(pos);
                        rec.r = *r;
                        if let OpResult::Merged { v, .. } = res {
                            if Some(v) != rec.v.as_ref() {
                                rec.srv = Some(SrvVal { v: Some(v.clone()), r: *r, d: String::new(), t: String::new() });
                            }
                        }
                        if rec.srv.as_ref().map(|s| s.r <= *r && !matches!(res, OpResult::Merged { .. })).unwrap_or(false) {
                            rec.srv = None;
                        }
                        // the next change to this field was waiting on this revision
                        if let Some(wpos) = rows.iter().position(|(_, p)| p.op.p == path && p.state == PendState::Waiting) {
                            let (wk, mut wp) = rows[wpos].clone();
                            wp.op.b = *r;
                            wp.state = PendState::Queued;
                            qt.insert(wk, serde_json::to_string(&wp).map_err(e)?.as_str()).map_err(e)?;
                            rows[wpos] = (wk, wp);
                        }
                    }
                    OpResult::Conflict { r, v, d, t, .. } => {
                        let theirs = SrvVal { v: v.clone(), r: *r, d: d.clone(), t: t.clone() };
                        let mut p = pend.clone();
                        p.state = PendState::Conflict;
                        p.theirs = Some(theirs.clone());
                        // anything queued behind it carries the latest value the person typed
                        if let Some(wpos) = rows.iter().position(|(_, q)| q.op.p == path && q.state == PendState::Waiting) {
                            let (wk, wp) = rows[wpos].clone();
                            p.op.v = wp.op.v.clone();
                            qt.remove(wk).map_err(e)?;
                            rows.remove(wpos);
                        }
                        qt.insert(key, serde_json::to_string(&p).map_err(e)?.as_str()).map_err(e)?;
                        rec.srv = Some(theirs.clone());
                        conflicts.push(ConflictInfo {
                            op_id: p.op.id.clone(),
                            path: flat::parse_path(&path).unwrap_or_default(),
                            mine: p.op.v.clone(),
                            theirs: v.clone(),
                            their_device: d.clone(),
                            their_time: t.clone(),
                        });
                        if let Some(i) = rows.iter().position(|(k, _)| *k == key) {
                            rows[i].1 = p;
                        }
                    }
                    OpResult::Rejected { .. } => {
                        qt.remove(key).map_err(e)?;
                        rows.remove(pos);
                    }
                }
                pt.insert(path.as_str(), serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
            }
        }
        w.commit().map_err(e)?;
        Ok(conflicts)
    }

    /// Changes from other computers. Returns how many are waiting for the screen.
    pub fn on_changes(&self, full: bool, to: u64, changes: &[Change]) -> Result<usize, String> {
        let w = self.db.begin_write().map_err(e)?;
        let mut waiting = 0;
        {
            let mut pt = w.open_table(PAGE).map_err(e)?;
            let qt = w.open_table(PENDING).map_err(e)?;
            let pend_paths: BTreeSet<String> = qt.iter().map_err(e)?.filter_map(|x| x.ok()).filter_map(|(_, v)| serde_json::from_str::<Pend>(v.value()).ok()).map(|p| p.op.p).collect();
            if full {
                let present: BTreeSet<&str> = changes.iter().map(|c| c.p.as_str()).collect();
                let rows: Vec<(String, PageRec)> = pt.iter().map_err(e)?.filter_map(|x| x.ok()).filter_map(|(k, v)| serde_json::from_str::<PageRec>(v.value()).ok().map(|r| (k.value().to_string(), r))).collect();
                for (p, mut rec) in rows {
                    if rec.v.is_some() && !present.contains(p.as_str()) && !pend_paths.contains(&p) {
                        rec.srv = Some(SrvVal { v: None, r: to, d: String::new(), t: String::new() });
                        pt.insert(p.as_str(), serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
                    }
                }
            }
            for c in changes {
                let mut rec: PageRec = load(pt.get(c.p.as_str()).map_err(e)?);
                if c.r <= rec.r && !full {
                    continue;
                }
                if c.r <= rec.r && rec.v == c.v {
                    continue;
                }
                rec.srv = Some(SrvVal { v: c.v.clone(), r: c.r, d: c.d.clone(), t: c.t.clone() });
                pt.insert(c.p.as_str(), serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
            }
            let mut mt = w.open_table(META).map_err(e)?;
            let last: u64 = mt.get("lastSeq").map_err(e)?.and_then(|g| g.value().parse().ok()).unwrap_or(0);
            mt.insert("lastSeq", last.max(to).to_string().as_str()).map_err(e)?;
            for item in pt.iter().map_err(e)? {
                let (k, v) = item.map_err(e)?;
                if let Ok(rec) = serde_json::from_str::<PageRec>(v.value()) {
                    if rec.srv.is_some() && !pend_paths.contains(k.value()) {
                        waiting += 1;
                    }
                }
            }
        }
        w.commit().map_err(e)?;
        Ok(waiting)
    }

    /// What the screen needs to apply, as object paths and the whole value at
    /// each (arrays are delivered whole).
    pub fn take_patches(&self) -> Result<Vec<Patch>, String> {
        let pend_paths: BTreeSet<String> = self.pending()?.into_iter().map(|(_, p)| p.op.p).collect();
        let r = self.db.begin_read().map_err(e)?;
        let pt = r.open_table(PAGE).map_err(e)?;
        let mut next = Leaves::new();
        let mut prefixes: BTreeMap<Vec<String>, String> = BTreeMap::new();
        for item in pt.iter().map_err(e)? {
            let (k, v) = item.map_err(e)?;
            let rec: PageRec = serde_json::from_str(v.value()).map_err(e)?;
            let path = k.value().to_string();
            let deliverable = rec.srv.is_some() && !pend_paths.contains(&path);
            let val = if deliverable { rec.srv.as_ref().unwrap().v.clone() } else { rec.v.clone() };
            if let Some(val) = val {
                next.insert(path.clone(), val);
            }
            if deliverable {
                if let Some(segs) = flat::parse_path(&path) {
                    let pre = flat::delivery_prefix(&segs);
                    if !pre.is_empty() {
                        prefixes.entry(pre).or_insert_with(|| rec.srv.as_ref().unwrap().d.clone());
                    }
                }
            }
        }
        // a prefix inside another prefix is covered by the outer one
        let keys: Vec<Vec<String>> = prefixes.keys().cloned().collect();
        let mut out = Vec::new();
        for pre in &keys {
            if keys.iter().any(|o| o != pre && flat::starts_with(pre, o)) {
                continue;
            }
            let keys_only: Vec<String> = pre.iter().filter_map(|s| flat::object_key(s)).collect();
            let value = flat::subtree(&next, pre);
            out.push(Patch { id: flat::path_string(pre), path: keys_only, del: value.is_none(), value, device: prefixes[pre].clone() });
        }
        Ok(out)
    }

    /// The screen applied these patches: its view now matches the hub there.
    pub fn confirm_patches(&self, ids: &[String]) -> Result<(), String> {
        let pend_paths: BTreeSet<String> = self.pending()?.into_iter().map(|(_, p)| p.op.p).collect();
        let prefixes: Vec<Vec<String>> = ids.iter().filter_map(|i| flat::parse_path(i)).collect();
        if prefixes.is_empty() {
            return Ok(());
        }
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut pt = w.open_table(PAGE).map_err(e)?;
            let rows: Vec<(String, PageRec)> = pt.iter().map_err(e)?.filter_map(|x| x.ok()).filter_map(|(k, v)| serde_json::from_str::<PageRec>(v.value()).ok().map(|r| (k.value().to_string(), r))).collect();
            for (p, mut rec) in rows {
                let Some(srv) = rec.srv.clone() else { continue };
                if pend_paths.contains(&p) {
                    continue;
                }
                let Some(segs) = flat::parse_path(&p) else { continue };
                if prefixes.iter().any(|pre| flat::starts_with(&segs, pre)) {
                    rec.v = srv.v;
                    rec.r = srv.r;
                    rec.srv = None;
                    if rec.v.is_none() && rec.r == 0 {
                        pt.remove(p.as_str()).map_err(e)?;
                    } else {
                        pt.insert(p.as_str(), serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
                    }
                }
            }
        }
        w.commit().map_err(e)
    }

    pub fn conflicts(&self) -> Result<Vec<ConflictInfo>, String> {
        Ok(self
            .pending()?
            .into_iter()
            .filter(|(_, p)| p.state == PendState::Conflict)
            .map(|(_, p)| {
                let t = p.theirs.clone().unwrap_or_default();
                ConflictInfo { op_id: p.op.id.clone(), path: flat::parse_path(&p.op.p).unwrap_or_default(), mine: p.op.v.clone(), theirs: t.v, their_device: t.d, their_time: t.t }
            })
            .collect())
    }

    /// The person chose. Keeping this computer's value sends it again, now
    /// based on the other computer's revision; taking theirs drops the change
    /// and lets the screen take the hub's value.
    pub fn resolve(&self, op_id: &str, keep_mine: bool) -> Result<(), String> {
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut qt = w.open_table(PENDING).map_err(e)?;
            let mut pt = w.open_table(PAGE).map_err(e)?;
            let rows: Vec<(u64, Pend)> = qt.iter().map_err(e)?.filter_map(|x| x.ok()).filter_map(|(k, v)| serde_json::from_str::<Pend>(v.value()).ok().map(|p| (k.value(), p))).collect();
            let Some((k, mut p)) = rows.into_iter().find(|(_, p)| p.op.id == op_id && p.state == PendState::Conflict) else {
                return Err("that conflict is no longer open".into());
            };
            let theirs = p.theirs.clone().unwrap_or_default();
            let mut rec: PageRec = load(pt.get(p.op.p.as_str()).map_err(e)?);
            if keep_mine {
                // a new change, not a retry: the hub answers a known id as before
                p.op.id = format!("{}-{}", util::rand_hex(6), k);
                p.op.b = theirs.r;
                p.state = PendState::Queued;
                p.theirs = None;
                rec.srv = None;
                rec.r = theirs.r;
                rec.v = p.op.v.clone();
                qt.insert(k, serde_json::to_string(&p).map_err(e)?.as_str()).map_err(e)?;
            } else {
                qt.remove(k).map_err(e)?;
                rec.srv = Some(theirs);
            }
            pt.insert(p.op.p.as_str(), serde_json::to_string(&rec).map_err(e)?.as_str()).map_err(e)?;
        }
        w.commit().map_err(e)
    }

    /// Changes waiting, as a person counts them: one save of the screen is one
    /// change, however many fields it touched (a tread depth also stamps the
    /// item's time). A field saved again later moves to that later change.
    pub fn pending_count(&self) -> usize {
        self.pending()
            .map(|v| v.iter().filter(|(_, p)| p.state != PendState::Conflict).map(|(_, p)| p.batch).collect::<BTreeSet<u64>>().len())
            .unwrap_or(0)
    }

    /// Operations waiting (fields), for diagnostics.
    pub fn pending_ops(&self) -> usize {
        self.pending().map(|v| v.iter().filter(|(_, p)| p.state != PendState::Conflict).count()).unwrap_or(0)
    }

    // ---------------- numbers handed out by the hub

    pub fn add_number_block(&self, key: &str, start: u64, count: u64) -> Result<(), String> {
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut t = w.open_table(NUMS).map_err(e)?;
            let mut list: Vec<u64> = t.get(key).map_err(e)?.and_then(|g| serde_json::from_str(g.value()).ok()).unwrap_or_default();
            list.extend(start..start + count);
            t.insert(key, serde_json::to_string(&list).map_err(e)?.as_str()).map_err(e)?;
        }
        w.commit().map_err(e)
    }

    pub fn numbers(&self) -> BTreeMap<String, Vec<u64>> {
        let mut out = BTreeMap::new();
        if let Ok(r) = self.db.begin_read() {
            if let Ok(t) = r.open_table(NUMS) {
                if let Ok(it) = t.iter() {
                    for (k, v) in it.filter_map(|x| x.ok()) {
                        out.insert(k.value().to_string(), serde_json::from_str(v.value()).unwrap_or_default());
                    }
                }
            }
        }
        out
    }

    /// A number was used by the screen; it is never offered again.
    pub fn use_number(&self, key: &str, n: u64) -> Result<(), String> {
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut t = w.open_table(NUMS).map_err(e)?;
            let mut list: Vec<u64> = t.get(key).map_err(e)?.and_then(|g| serde_json::from_str(g.value()).ok()).unwrap_or_default();
            list.retain(|x| *x > n);
            t.insert(key, serde_json::to_string(&list).map_err(e)?.as_str()).map_err(e)?;
        }
        w.commit().map_err(e)
    }

    // ---------------- photographs waiting to reach the hub

    pub fn att_queue(&self, id: &str, meta: &Value) -> Result<(), String> {
        let w = self.db.begin_write().map_err(e)?;
        {
            let mut t = w.open_table(ATTUP).map_err(e)?;
            t.insert(id, meta.to_string().as_str()).map_err(e)?;
        }
        w.commit().map_err(e)
    }

    pub fn att_all(&self) -> Vec<Value> {
        let mut out = Vec::new();
        if let Ok(r) = self.db.begin_read() {
            if let Ok(t) = r.open_table(ATTUP) {
                if let Ok(it) = t.iter() {
                    for (_, v) in it.filter_map(|x| x.ok()) {
                        if let Ok(m) = serde_json::from_str(v.value()) {
                            out.push(m);
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::HubStore;
    use serde_json::json;

    fn tmp(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("shophub-engine-{tag}-{}-{}", std::process::id(), util::rand_hex(4)))
    }

    /// Two computers and a hub, wired directly, no network.
    struct Rig {
        hub: HubStore,
        a: Engine,
        b: Engine,
    }

    impl Rig {
        fn new(book: Value) -> Rig {
            let hub = HubStore::open(&tmp("hub")).unwrap();
            hub.import_book(&book, "host").unwrap();
            let (full, seq, snap) = hub.changes_since(0).unwrap();
            assert!(full);
            let a = Engine::open(&tmp("a")).unwrap();
            let b = Engine::open(&tmp("b")).unwrap();
            a.adopt_snapshot(&snap, seq, "e").unwrap();
            b.adopt_snapshot(&snap, seq, "e").unwrap();
            Rig { hub, a, b }
        }
        fn push(&self, who: &Engine, dev: &str) -> Vec<ConflictInfo> {
            let ops = who.outgoing(1000).unwrap();
            who.mark_sent(&ops.iter().map(|o| o.id.clone()).collect::<Vec<_>>()).unwrap();
            let (res, _) = self.hub.apply(dev, &ops).unwrap();
            who.on_results(&res).unwrap()
        }
        fn pull(&self, who: &Engine) -> Vec<Patch> {
            let (full, to, ch) = self.hub.changes_since(who.last_seq()).unwrap();
            who.on_changes(full, to, &ch).unwrap();
            who.take_patches().unwrap()
        }
    }

    fn set(book: &mut Value, path: &[&str], v: Value) {
        let mut cur = book;
        for k in &path[..path.len() - 1] {
            cur = cur.get_mut(*k).unwrap();
        }
        cur[path[path.len() - 1]] = v;
    }

    fn apply(book: &mut Value, patches: &[Patch]) {
        for p in patches {
            let mut cur = &mut *book;
            for k in &p.path[..p.path.len() - 1] {
                if cur.get(k).is_none() {
                    cur[k] = json!({});
                }
                cur = cur.get_mut(k).unwrap();
            }
            let last = &p.path[p.path.len() - 1];
            match &p.value {
                Some(v) => cur[last] = v.clone(),
                None => {
                    cur.as_object_mut().unwrap().remove(last);
                }
            }
        }
    }

    fn start() -> Value {
        json!({"inspections": {"i1": {"items": {
            "tires.tire.LF": {"state": "Not Inspected", "meas": {"tread": ""}, "flags": []},
            "battery.battery": {"state": "Not Inspected", "meas": {"volts": ""}, "flags": []}}}},
            "orders": {"o1": {"id": "o1", "status": "Estimate", "labor": [{"id": "l1", "desc": "Oil", "hours": 0.5}]}}})
    }

    #[test]
    fn a_status_change_reaches_the_other_computer_and_different_fields_both_survive() {
        let rig = Rig::new(start());
        let mut la = rig.a.book().unwrap();
        let mut lb = rig.b.book().unwrap();
        set(&mut la, &["inspections", "i1", "items", "tires.tire.LF", "state"], json!("Needs Attention"));
        set(&mut la, &["inspections", "i1", "items", "tires.tire.LF", "meas", "tread"], json!("4"));
        rig.a.save_book(&la).unwrap();
        assert_eq!(rig.a.pending_ops(), 2);
        assert_eq!(rig.a.pending_count(), 1, "one save is one change to a person");
        assert!(rig.push(&rig.a, "laptop").is_empty());
        assert_eq!(rig.a.pending_count(), 0, "synced means acknowledged");
        // the desktop changes the battery before it has heard about the tyre
        set(&mut lb, &["inspections", "i1", "items", "battery.battery", "meas", "volts"], json!("12.6"));
        rig.b.save_book(&lb).unwrap();
        assert!(rig.push(&rig.b, "desktop").is_empty());
        let pb = rig.pull(&rig.b);
        apply(&mut lb, &pb);
        rig.b.confirm_patches(&pb.iter().map(|p| p.id.clone()).collect::<Vec<_>>()).unwrap();
        let pa = rig.pull(&rig.a);
        apply(&mut la, &pa);
        rig.a.confirm_patches(&pa.iter().map(|p| p.id.clone()).collect::<Vec<_>>()).unwrap();
        for book in [&la, &lb, &rig.hub.book().unwrap()] {
            assert_eq!(book["inspections"]["i1"]["items"]["tires.tire.LF"]["state"], "Needs Attention");
            assert_eq!(book["inspections"]["i1"]["items"]["tires.tire.LF"]["meas"]["tread"], "4");
            assert_eq!(book["inspections"]["i1"]["items"]["battery.battery"]["meas"]["volts"], "12.6");
        }
        // the patch the desktop received is the one field, not the inspection
        assert!(pb.iter().all(|p| p.path.len() >= 5), "{pb:?}");
        // after both have caught up, saving again sends nothing
        assert_eq!(rig.a.save_book(&la).unwrap(), 0);
        assert_eq!(rig.b.save_book(&lb).unwrap(), 0);
    }

    #[test]
    fn the_same_field_changed_on_both_is_a_conflict_that_a_person_resolves() {
        let rig = Rig::new(start());
        let mut la = rig.a.book().unwrap();
        let mut lb = rig.b.book().unwrap();
        set(&mut la, &["inspections", "i1", "items", "tires.tire.LF", "meas", "tread"], json!("4"));
        set(&mut lb, &["inspections", "i1", "items", "tires.tire.LF", "meas", "tread"], json!("5"));
        rig.a.save_book(&la).unwrap();
        rig.b.save_book(&lb).unwrap();
        assert!(rig.push(&rig.a, "laptop").is_empty());
        let conflicts = rig.push(&rig.b, "desktop");
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].mine, Some(json!("5")));
        assert_eq!(conflicts[0].theirs, Some(json!("4")));
        assert_eq!(conflicts[0].their_device, "laptop");
        assert_eq!(rig.hub.book().unwrap()["inspections"]["i1"]["items"]["tires.tire.LF"]["meas"]["tread"], "4", "nothing overwritten");
        // the desktop's screen is not changed behind the person's back
        assert!(rig.pull(&rig.b).is_empty());
        // the person keeps 5/32
        rig.b.resolve(&conflicts[0].op_id, true).unwrap();
        let again = rig.push(&rig.b, "desktop");
        assert!(again.is_empty(), "{again:?} {:?}", rig.b.pending().unwrap().iter().map(|(_, p)| (p.op.clone(), p.state.clone())).collect::<Vec<_>>());
        assert_eq!(rig.hub.book().unwrap()["inspections"]["i1"]["items"]["tires.tire.LF"]["meas"]["tread"], "5");
        let pa = rig.pull(&rig.a);
        apply(&mut la, &pa);
        assert_eq!(la["inspections"]["i1"]["items"]["tires.tire.LF"]["meas"]["tread"], "5");
        // and the other way: taking theirs
        rig.a.confirm_patches(&pa.iter().map(|p| p.id.clone()).collect::<Vec<_>>()).unwrap();
        set(&mut la, &["orders", "o1", "status"], json!("Approved"));
        set(&mut lb, &["orders", "o1", "status"], json!("Declined"));
        rig.a.save_book(&la).unwrap();
        rig.b.save_book(&lb).unwrap();
        rig.push(&rig.a, "laptop");
        let c = rig.push(&rig.b, "desktop");
        rig.b.resolve(&c[0].op_id, false).unwrap();
        let pb = rig.pull(&rig.b);
        apply(&mut lb, &pb);
        assert_eq!(lb["orders"]["o1"]["status"], "Approved");
    }

    #[test]
    fn offline_changes_queue_durably_and_go_when_the_hub_returns() {
        let rig = Rig::new(start());
        let dir = rig.a.dir().to_path_buf();
        let mut la = rig.a.book().unwrap();
        for (i, v) in ["7", "6", "5"].iter().enumerate() {
            set(&mut la, &["inspections", "i1", "items", "tires.tire.LF", "meas", "tread"], json!(v));
            set(&mut la, &["orders", "o1", "labor"], json!([{"id": "l1", "desc": "Oil", "hours": 0.5}, {"id": format!("n{i}"), "desc": "Added offline", "hours": 1}]));
            rig.a.save_book(&la).unwrap();
        }
        let waiting = rig.a.pending_count();
        assert!(waiting >= 1 && rig.a.pending_ops() >= 3, "{waiting}");
        // the laptop is switched off and on again
        let a2 = Engine::open(&tmp("unused")).map(|_| Engine::open(&dir).err());
        drop(a2);
        let Rig { hub, a, b } = rig;
        drop(a);
        let a = Engine::open(&dir).unwrap();
        assert_eq!(a.pending_count(), waiting, "queued changes survive a restart");
        assert_eq!(a.book().unwrap()["inspections"]["i1"]["items"]["tires.tire.LF"]["meas"]["tread"], "5");
        let rig = Rig { hub, a, b };
        // a message was sent but the connection dropped before the answer
        let ops = rig.a.outgoing(1000).unwrap();
        rig.a.mark_sent(&ops.iter().map(|o| o.id.clone()).collect::<Vec<_>>()).unwrap();
        rig.hub.apply("laptop", &ops).unwrap();
        rig.a.requeue_sent().unwrap();
        assert!(rig.push(&rig.a, "laptop").is_empty(), "a resent change is not a conflict with itself");
        assert_eq!(rig.a.pending_count(), 0);
        let hub_book = rig.hub.book().unwrap();
        assert_eq!(hub_book["inspections"]["i1"]["items"]["tires.tire.LF"]["meas"]["tread"], "5");
        let lines = hub_book["orders"]["o1"]["labor"].as_array().unwrap();
        assert_eq!(lines.len(), 2, "{lines:?}");
    }

    #[test]
    fn numbers_from_the_hub_are_used_once() {
        let e = Engine::open(&tmp("nums")).unwrap();
        e.add_number_block("nextRO", 41, 3).unwrap();
        assert_eq!(e.numbers()["nextRO"], vec![41, 42, 43]);
        e.use_number("nextRO", 41).unwrap();
        assert_eq!(e.numbers()["nextRO"], vec![42, 43]);
    }
}
