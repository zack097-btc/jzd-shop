//! The shop book as individual fields.
//!
//! Two computers editing the same book must be able to change different parts
//! of it at the same time without one overwriting the other. So the book is not
//! synchronised as a document: it is taken apart into leaves, one per field,
//! each with its own path and its own revision on the hub.
//!
//! A path is a list of segments:
//!   * an object key, as written (escaped with `~` if it happens to start with
//!     `@`, `#` or `~`);
//!   * `@key` for an element of an array, where the key is `i:<id>` for an
//!     object carrying a unique `id`, or `h:<hash>:<n>` for anything else;
//!   * `#` for the order of an array's elements.
//!
//! A leaf is a value that is not taken apart further: a string, number, bool,
//! null, an empty object or array, or an array element with no id of its own.
//! Because elements are keyed, adding a labour line on one computer and a
//! different one on another both survive, and so do two different findings
//! added to the same tyre.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};

pub type Leaves = BTreeMap<String, Value>;

/// The segments of a path, as the canonical string used everywhere a path is
/// stored or sent: a JSON array of strings.
pub fn path_string(segs: &[String]) -> String {
    serde_json::to_string(segs).expect("strings serialise")
}

pub fn parse_path(p: &str) -> Option<Vec<String>> {
    let v: Vec<String> = serde_json::from_str(p).ok()?;
    if v.is_empty() || v.len() > 64 || v.iter().any(|s| s.is_empty() || s.len() > 512) {
        return None;
    }
    Some(v)
}

pub fn key_seg(k: &str) -> String {
    if k.starts_with('@') || k.starts_with('#') || k.starts_with('~') {
        format!("~{k}")
    } else {
        k.to_string()
    }
}

/// An object key segment decoded back to the real key; None for an array
/// segment.
pub fn object_key(seg: &str) -> Option<String> {
    if seg == "#" || seg.starts_with('@') {
        None
    } else if let Some(rest) = seg.strip_prefix('~') {
        Some(rest.to_string())
    } else {
        Some(seg.to_string())
    }
}

fn short_hash(v: &Value) -> String {
    let text = serde_json::to_string(v).expect("values serialise");
    let d = Sha256::digest(text.as_bytes());
    d.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

/// Stable keys for the elements of an array.
pub fn element_keys(a: &[Value]) -> Vec<String> {
    let mut id_count: HashMap<&str, usize> = HashMap::new();
    for el in a {
        if let Some(id) = el.get("id").and_then(|x| x.as_str()) {
            if !id.is_empty() {
                *id_count.entry(id).or_insert(0) += 1;
            }
        }
    }
    let mut seen: HashMap<String, usize> = HashMap::new();
    a.iter()
        .map(|el| {
            if let (Some(id), true) = (el.get("id").and_then(|x| x.as_str()), el.is_object()) {
                if !id.is_empty() && id_count.get(id) == Some(&1) {
                    return format!("i:{id}");
                }
            }
            let h = short_hash(el);
            let n = seen.entry(h.clone()).or_insert(0);
            *n += 1;
            format!("h:{h}:{}", *n)
        })
        .collect()
}

/// A JSON null stored as a leaf. Absent (deleted) and null are different
/// things in a shop book, and everywhere below a missing value means deleted,
/// so a null travels as this marker. Nothing else is ever a non-empty object
/// leaf, so it cannot be confused with data.
pub const NULL_KEY: &str = "~null";

pub fn null_leaf() -> Value {
    serde_json::json!({ NULL_KEY: true })
}

pub fn is_null_leaf(v: &Value) -> bool {
    matches!(v, Value::Object(m) if m.len() == 1 && m.get(NULL_KEY) == Some(&Value::Bool(true)))
}

/// A leaf value as the book holds it.
pub fn book_value(v: &Value) -> Value {
    if is_null_leaf(v) { Value::Null } else { v.clone() }
}

pub fn flatten(v: &Value) -> Leaves {
    let mut out = Leaves::new();
    let mut path = Vec::new();
    walk(v, &mut path, &mut out);
    out
}

fn walk(v: &Value, path: &mut Vec<String>, out: &mut Leaves) {
    match v {
        Value::Object(m) if !m.is_empty() => {
            for (k, val) in m {
                path.push(key_seg(k));
                walk(val, path, out);
                path.pop();
            }
        }
        Value::Array(a) if !a.is_empty() => {
            let keys = element_keys(a);
            path.push("#".into());
            out.insert(path_string(path), Value::Array(keys.iter().map(|k| Value::String(k.clone())).collect()));
            path.pop();
            for (el, k) in a.iter().zip(keys.iter()) {
                path.push(format!("@{k}"));
                if k.starts_with("i:") {
                    walk(el, path, out);
                } else if el.is_null() {
                    out.insert(path_string(path), null_leaf());
                } else {
                    out.insert(path_string(path), el.clone());
                }
                path.pop();
            }
        }
        Value::Null => {
            if !path.is_empty() {
                out.insert(path_string(path), null_leaf());
            }
        }
        _ => {
            if !path.is_empty() {
                out.insert(path_string(path), v.clone());
            }
        }
    }
}

enum Node {
    Leaf(Value),
    Obj(BTreeMap<String, Node>),
    Arr { order: Option<Vec<String>>, elems: Vec<(String, Node)> },
}

impl Node {
    fn child_obj(&mut self) -> &mut BTreeMap<String, Node> {
        if !matches!(self, Node::Obj(_)) {
            *self = Node::Obj(BTreeMap::new());
        }
        match self {
            Node::Obj(m) => m,
            _ => unreachable!(),
        }
    }
    fn arr(&mut self) -> (&mut Option<Vec<String>>, &mut Vec<(String, Node)>) {
        if !matches!(self, Node::Arr { .. }) {
            *self = Node::Arr { order: None, elems: Vec::new() };
        }
        match self {
            Node::Arr { order, elems } => (order, elems),
            _ => unreachable!(),
        }
    }
    fn is_container(&self) -> bool {
        match self {
            Node::Obj(m) => !m.is_empty(),
            Node::Arr { elems, .. } => !elems.is_empty(),
            Node::Leaf(_) => false,
        }
    }
    fn into_value(self) -> Value {
        match self {
            Node::Leaf(v) => v,
            Node::Obj(m) => Value::Object(m.into_iter().map(|(k, n)| (k, n.into_value())).collect::<Map<_, _>>()),
            Node::Arr { order, mut elems } => {
                let mut out = Vec::with_capacity(elems.len());
                if let Some(order) = order {
                    for k in order {
                        if let Some(i) = elems.iter().position(|(ek, _)| *ek == k) {
                            out.push(elems.remove(i).1.into_value());
                        }
                    }
                }
                for (_, n) in elems {
                    out.push(n.into_value());
                }
                Value::Array(out)
            }
        }
    }
}

fn insert(root: &mut Node, segs: &[String], value: Value) {
    if segs.is_empty() {
        // a leaf never replaces a structure that already has content
        if !root.is_container() {
            *root = Node::Leaf(value);
        }
        return;
    }
    let seg = &segs[0];
    if seg == "#" {
        let (order, _) = root.arr();
        if let Value::Array(a) = value {
            *order = Some(a.into_iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect());
        }
        return;
    }
    if let Some(k) = seg.strip_prefix('@') {
        let (_, elems) = root.arr();
        let i = match elems.iter().position(|(ek, _)| ek == k) {
            Some(i) => i,
            None => {
                elems.push((k.to_string(), Node::Leaf(Value::Null)));
                elems.len() - 1
            }
        };
        insert(&mut elems[i].1, &segs[1..], value);
        return;
    }
    let key = object_key(seg).unwrap_or_else(|| seg.clone());
    let m = root.child_obj();
    let child = m.entry(key).or_insert(Node::Leaf(Value::Null));
    insert(child, &segs[1..], value);
}

/// Put leaves back together. Robust to what a merge can leave behind: a
/// structure with content always wins over an empty `{}` / `[]` leaf at the
/// same place, and array order follows the order leaf, then first appearance.
pub fn unflatten<'a, I>(leaves: I) -> Value
where
    I: IntoIterator<Item = (&'a String, &'a Value)>,
{
    let mut root = Node::Obj(BTreeMap::new());
    // containers first would be ideal; inserting in path order is enough
    // because `insert` refuses to let a leaf overwrite content.
    let mut deferred: Vec<(Vec<String>, Value)> = Vec::new();
    for (p, v) in leaves {
        let Some(segs) = parse_path(p) else { continue };
        let empty = matches!(v, Value::Object(m) if m.is_empty()) || matches!(v, Value::Array(a) if a.is_empty());
        if empty {
            deferred.push((segs, v.clone()));
        } else {
            insert(&mut root, &segs, book_value(v));
        }
    }
    for (segs, v) in deferred {
        insert(&mut root, &segs, v);
    }
    root.into_value()
}

/// Leaves that differ between two flattenings: Some(new) for set, None for
/// removed.
pub fn diff(old: &Leaves, new: &Leaves) -> Vec<(String, Option<Value>)> {
    let mut out = Vec::new();
    for (p, v) in new {
        if old.get(p) != Some(v) {
            out.push((p.clone(), Some(v.clone())));
        }
    }
    for p in old.keys() {
        if !new.contains_key(p) {
            out.push((p.clone(), None));
        }
    }
    out
}

/// The part of a path the page can address directly: every object key up to
/// the first array segment. A change inside an array is delivered as the whole
/// array, so the page never needs to know how elements are keyed.
pub fn delivery_prefix(segs: &[String]) -> Vec<String> {
    segs.iter().take_while(|s| object_key(s).is_some()).cloned().collect()
}

pub fn starts_with(segs: &[String], prefix: &[String]) -> bool {
    segs.len() >= prefix.len() && segs[..prefix.len()] == prefix[..]
}

/// The value at an object-key prefix, rebuilt from leaves. None if nothing is
/// there.
pub fn subtree(leaves: &Leaves, prefix: &[String]) -> Option<Value> {
    let exact = path_string(prefix);
    let mut sub = Leaves::new();
    let start = {
        // every path under the prefix starts with the prefix's JSON minus its
        // closing bracket
        let mut s = exact.clone();
        s.pop();
        s
    };
    for (p, v) in leaves.range(start.clone()..) {
        if !p.starts_with(&start) {
            break;
        }
        if *p == exact {
            sub.insert(path_string(&["__".to_string()]), v.clone());
            continue;
        }
        if let Some(segs) = parse_path(p) {
            if starts_with(&segs, prefix) {
                let rest = &segs[prefix.len()..];
                let mut np = vec!["__".to_string()];
                np.extend_from_slice(rest);
                sub.insert(path_string(&np), v.clone());
            }
        }
    }
    if sub.is_empty() {
        return None;
    }
    let v = unflatten(sub.iter());
    v.get("__").cloned()
}

/// Canonical text of a value (sorted keys), used to compare books.
pub fn canonical(v: &Value) -> String {
    serde_json::to_string(v).expect("values serialise")
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_book_comes_apart_and_goes_back_together_exactly() {
        let book = json!({
            "settings": {"shopName": "JZD", "fees": [], "techs": ["Zack", "Marco", "Zack"], "~odd": 1, "@weird": {"#x": true}},
            "orders": {"o1": {"id": "o1", "labor": [{"id": "l1", "desc": "Oil", "hours": 0.5}, {"id": "l2", "desc": "Filter", "hours": null}],
                              "parts": [], "payments": [{"amount": 10}, {"amount": 10}], "history": [{"id": "dup"}, {"id": "dup", "x": 1}]}},
            "inspections": {"insp_1": {"items": {"tires.tire.LF": {"state": "Good", "meas": {"tread": "7"}, "flags": ["Low Tread", "Inside Edge Wear"], "obs": {}}}}},
            "audit": [], "empty": {}, "n": null
        });
        let leaves = flatten(&book);
        assert!(leaves.keys().any(|k| k.contains("tires.tire.LF")));
        let back = unflatten(leaves.iter());
        assert_eq!(canonical(&back), canonical(&book));
    }

    #[test]
    fn different_labour_lines_and_different_findings_are_different_leaves() {
        let a = json!({"o": {"labor": [{"id": "l1", "desc": "Oil"}], "flags": ["Low Tread"]}});
        let mut b = a.clone();
        b["o"]["labor"].as_array_mut().unwrap().push(json!({"id": "l2", "desc": "Brakes"}));
        b["o"]["flags"].as_array_mut().unwrap().push(json!("Bulge"));
        let d = diff(&flatten(&a), &flatten(&b));
        let paths: Vec<_> = d.iter().map(|x| x.0.clone()).collect();
        assert!(paths.iter().any(|p| p.contains("@i:l2")), "{paths:?}");
        assert!(paths.iter().any(|p| p.contains("@h:")), "{paths:?}");
        assert!(!paths.iter().any(|p| p.contains("@i:l1")), "an untouched line is not a change");
    }

    #[test]
    fn delivery_is_the_object_part_of_a_path() {
        let segs = parse_path(r#"["orders","o1","labor","@i:l1","desc"]"#).unwrap();
        assert_eq!(delivery_prefix(&segs), vec!["orders", "o1", "labor"]);
        let leaves = flatten(&json!({"orders": {"o1": {"labor": [{"id": "l1", "desc": "Oil"}], "status": "Estimate"}}}));
        let arr = subtree(&leaves, &["orders".into(), "o1".into(), "labor".into()]).unwrap();
        assert_eq!(arr, json!([{"id": "l1", "desc": "Oil"}]));
        assert_eq!(subtree(&leaves, &["orders".into(), "o1".into(), "status".into()]).unwrap(), json!("Estimate"));
        assert!(subtree(&leaves, &["orders".into(), "o2".into()]).is_none());
        // a key that merely starts like another is not under it
        let l2 = flatten(&json!({"a": {"b": 1}, "ab": 2}));
        assert_eq!(subtree(&l2, &["a".into()]).unwrap(), json!({"b": 1}));
    }

    #[test]
    fn a_leftover_empty_marker_never_hides_content() {
        let mut leaves = Leaves::new();
        leaves.insert(path_string(&["o".into()]), json!({}));
        leaves.insert(path_string(&["o".into(), "x".into()]), json!(1));
        leaves.insert(path_string(&["a".into()]), json!([]));
        leaves.insert(path_string(&["a".into(), "@i:k".into(), "id".into()]), json!("k"));
        assert_eq!(unflatten(leaves.iter()), json!({"o": {"x": 1}, "a": [{"id": "k"}]}));
    }
}
