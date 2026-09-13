//! The commands the page calls, answered the same way whether the caller is
//! the installed desktop app or the development harness. Local-mode book and
//! photo storage here mirror the desktop shell; the installed app keeps using
//! its own long-standing implementations for those and routes only sync.

use crate::app::{Options, ShopSync};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

pub struct Shell {
    pub sync: Arc<ShopSync>,
    pub data_dir: PathBuf,
    pub att_dir: PathBuf,
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

impl Shell {
    pub fn open(o: Options) -> Result<Shell, String> {
        let data_dir = o.data_dir.clone();
        let att_dir = o.att_dir.clone();
        let sync = ShopSync::open(o)?;
        Ok(Shell { sync, data_dir, att_dir })
    }

    fn book_path(&self) -> PathBuf {
        self.data_dir.join("shop.json")
    }

    pub fn local_book_text(&self) -> Result<String, String> {
        std::fs::read_to_string(self.book_path()).map_err(|e| format!("cannot read the local book: {e}"))
    }

    /// Sync commands shared with the installed app. None when the command is
    /// not a sync command.
    pub fn sync_command(&self, cmd: &str, a: &Value) -> Option<Result<Value, String>> {
        let sy = &self.sync;
        Some(match cmd {
            "sync_status" => Ok(sy.status()),
            "sync_pair_open" => sy.pairing_open(),
            "sync_pair_close" => sy.pairing_close().map(|_| json!(true)),
            "sync_pair_decide" => sy.pairing_decide(&s(a, "id"), a["approve"].as_bool().unwrap_or(false)).map(|_| json!(true)),
            "sync_discover" => Ok(json!(sy.discover())),
            "sync_join" => sy.join_begin(&s(a, "address"), &s(a, "code"), &s(a, "deviceName")).map(|_| json!(true)),
            "sync_revoke" => sy.revoke(&s(a, "deviceId")).map(|_| json!(true)),
            "sync_take_patches" => sy.take_patches(),
            "sync_confirm_patches" => {
                let ids: Vec<String> = serde_json::from_value(a["ids"].clone()).unwrap_or_default();
                sy.confirm_patches(&ids).map(|_| json!(true))
            }
            "sync_resolve" => sy.resolve(&s(a, "opId"), a["keepMine"].as_bool().unwrap_or(false)).map(|_| json!(true)),
            "sync_presence" => {
                sy.presence(a.get("open").and_then(|x| x.as_str()).map(|x| x.to_string()));
                Ok(json!(true))
            }
            "sync_numbers" => Ok(sy.numbers()),
            "sync_use_number" => sy.use_number(&s(a, "key"), a["n"].as_u64().unwrap_or(0)).map(|_| json!(true)),
            "sync_backup_now" => sy.backup_now(),
            "sync_backups" => sy.backups(),
            "sync_verify_backup" => sy.verify_backup(&s(a, "name")),
            "sync_restore_backup" => sy.restore_backup(&s(a, "name")),
            "sync_att_status" => Ok(sy.att_status()),
            "sync_host_enable" => {
                let text = match self.local_book_text() {
                    Ok(t) => t,
                    Err(e) => return Some(Err(e)),
                };
                sy.host_enable(&text, &s(a, "shopName"), &s(a, "deviceName"), a["port"].as_u64().unwrap_or(0) as u16)
            }
            _ => return None,
        })
    }
}
