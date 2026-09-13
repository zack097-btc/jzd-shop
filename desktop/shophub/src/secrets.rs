//! Where pairing secrets live. The desktop app supplies a store backed by
//! Windows Credential Manager; tests and the development harness use a file.

use crate::crypto::{b64, unb64};
use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub trait SecretStore: Send + Sync {
    fn put(&self, name: &str, secret: &[u8]) -> Result<(), String>;
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String>;
    fn delete(&self, name: &str) -> Result<(), String>;
}

/// For tests and the development harness only. Never used by the installed app.
pub struct FileSecrets {
    path: PathBuf,
    lock: Mutex<()>,
}

impl FileSecrets {
    pub fn new(path: PathBuf) -> FileSecrets {
        FileSecrets { path, lock: Mutex::new(()) }
    }
    fn read(&self) -> BTreeMap<String, String> {
        std::fs::read_to_string(&self.path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
    }
    fn write(&self, m: &BTreeMap<String, String>) -> Result<(), String> {
        if let Some(d) = self.path.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        std::fs::write(&self.path, serde_json::to_string(m).unwrap()).map_err(|e| e.to_string())
    }
}

impl SecretStore for FileSecrets {
    fn put(&self, name: &str, secret: &[u8]) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let mut m = self.read();
        m.insert(name.into(), b64(secret));
        self.write(&m)
    }
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        let _g = self.lock.lock().unwrap();
        match self.read().get(name) {
            Some(s) => Ok(Some(unb64(s)?)),
            None => Ok(None),
        }
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        let _g = self.lock.lock().unwrap();
        let mut m = self.read();
        m.remove(name);
        self.write(&m)
    }
}
