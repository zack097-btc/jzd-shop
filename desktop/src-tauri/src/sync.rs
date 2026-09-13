// Shop Sync, in the installed app.
//
// The sync itself lives in the `shophub` crate (desktop/shophub), where it is
// tested on its own and across real processes. This file only connects it to
// the desktop shell: the Windows Credential Manager for pairing secrets, Tauri
// events for the page, the commands the page calls, and the Windows pieces a
// host computer needs (a firewall rule for this program only, starting with
// Windows, staying in the notification area when the window closes).

use serde_json::{json, Value};
use shophub::app::Options;
use shophub::secrets::SecretStore;
use shophub::shell::Shell;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;

/// Pairing secrets in Windows Credential Manager, under the same prefix as the
/// provider credentials. The credential's name is a hash of the device and
/// shop, so it never has to fit Credential Manager's naming rules.
pub struct CredSecrets;

fn cred_field(name: &str) -> String {
    let h = Sha256::digest(name.as_bytes());
    let hex: String = h.iter().map(|b| format!("{b:02x}")).collect();
    format!("k{}", &hex[..32])
}

impl SecretStore for CredSecrets {
    fn put(&self, name: &str, secret: &[u8]) -> Result<(), String> {
        crate::hub::secret_put("shophub", &cred_field(name), &shophub::crypto::b64(secret))
    }
    fn get(&self, name: &str) -> Result<Option<Vec<u8>>, String> {
        match crate::hub::secret_get("shophub", &cred_field(name))? {
            Some(v) => Ok(Some(shophub::crypto::unb64(&v)?)),
            None => Ok(None),
        }
    }
    fn delete(&self, name: &str) -> Result<(), String> {
        crate::hub::secret_delete("shophub", &cred_field(name)).map(|_| ())
    }
}

/// What the app keeps: the sync shell, or why it could not start. A computer
/// that has joined a Shop Hub must never quietly fall back to its old book.
pub struct SyncState {
    pub shell: Option<Arc<Shell>>,
    pub error: Option<String>,
}

impl SyncState {
    pub fn open(app: &tauri::AppHandle, data_dir: PathBuf, att_dir: PathBuf) -> SyncState {
        let handle = app.clone();
        let o = Options {
            data_dir,
            att_dir,
            secrets: Arc::new(CredSecrets),
            emit: Arc::new(move |kind: &str, data: Value| {
                let _ = handle.emit("shopsync", json!({"kind": kind, "data": data}));
            }),
            bind_ip: "0.0.0.0".into(),
            discovery: true,
        };
        match Shell::open(o) {
            Ok(s) => SyncState { shell: Some(Arc::new(s)), error: None },
            Err(e) => SyncState { shell: None, error: Some(e) },
        }
    }

    pub fn shell(&self) -> Result<Arc<Shell>, String> {
        self.shell.clone().ok_or_else(|| format!("Shop Sync could not start: {}", self.error.clone().unwrap_or_default()))
    }

    /// "local", "host" or "client". When sync could not start, the sync
    /// configuration on disk decides, so a computer that belongs to a Shop Hub
    /// is never treated as local by accident.
    pub fn mode(&self, data_dir: &std::path::Path) -> String {
        if let Some(s) = &self.shell {
            return s.sync.mode();
        }
        std::fs::read_to_string(data_dir.join("shophub").join("sync.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .and_then(|v| v["mode"].as_str().map(|m| m.to_string()))
            .filter(|m| !m.is_empty())
            .unwrap_or_else(|| "local".into())
    }
}

fn body(request: &tauri::ipc::Request<'_>) -> Value {
    match request.body() {
        tauri::ipc::InvokeBody::Json(v) => v.clone(),
        _ => Value::Null,
    }
}

/// The page's sync commands, each run off the window's thread (hosting,
/// discovery and backups take a moment).
macro_rules! sync_commands {
    ($($name:ident),* $(,)?) => {
        $(
            #[tauri::command]
            pub async fn $name(state: tauri::State<'_, SyncState>, request: tauri::ipc::Request<'_>) -> Result<Value, String> {
                let shell = state.shell()?;
                let args = body(&request);
                tauri::async_runtime::spawn_blocking(move || {
                    shell.sync_command(stringify!($name), &args).unwrap_or_else(|| Err(format!("{} is not a sync command", stringify!($name))))
                })
                .await
                .map_err(|e| e.to_string())?
            }
        )*
    };
}

sync_commands!(
    sync_pair_open,
    sync_pair_close,
    sync_pair_decide,
    sync_discover,
    sync_join,
    sync_revoke,
    sync_take_patches,
    sync_confirm_patches,
    sync_resolve,
    sync_presence,
    sync_numbers,
    sync_use_number,
    sync_backup_now,
    sync_backups,
    sync_verify_backup,
    sync_restore_backup,
    sync_att_status,
    sync_host_enable,
);

/// Status answers even when sync could not start, and says why.
#[tauri::command]
pub async fn sync_status(state: tauri::State<'_, SyncState>) -> Result<Value, String> {
    match &state.shell {
        Some(s) => {
            let s = s.clone();
            tauri::async_runtime::spawn_blocking(move || s.sync.status()).await.map_err(|e| e.to_string())
        }
        None => Ok(json!({"mode": "local", "error": state.error})),
    }
}

#[tauri::command]
pub async fn sync_open_backup_dir(state: tauri::State<'_, SyncState>) -> Result<Value, String> {
    let shell = state.shell()?;
    let st = shell.sync.status();
    let dir = st["hub"]["backupsDir"].as_str().map(PathBuf::from).ok_or("this computer does not host the Shop Hub")?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        std::process::Command::new("explorer.exe").arg(&dir).spawn().map_err(|e| format!("could not open the folder: {e}"))?;
    }
    Ok(json!(dir.display().to_string()))
}

// ---------------------------------------------------------------- Windows Firewall

const FW_TCP: &str = "JZD Shop Manager - Shop Hub (TCP)";
const FW_UDP: &str = "JZD Shop Manager - Shop Hub discovery (UDP)";

#[cfg(windows)]
fn hidden(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000)
}

fn hub_port(state: &SyncState) -> u16 {
    state.shell.as_ref().and_then(|s| s.sync.status()["port"].as_u64()).unwrap_or(shophub::server::DEFAULT_PORT as u64) as u16
}

#[cfg(windows)]
fn rule_present(name: &str) -> bool {
    hidden(std::process::Command::new("netsh").args(["advfirewall", "firewall", "show", "rule", &format!("name={name}")]))
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Whether the two rules for this program exist. Nothing is changed.
#[tauri::command]
pub async fn sync_firewall_status(state: tauri::State<'_, SyncState>) -> Result<Value, String> {
    let port = hub_port(&state);
    #[cfg(windows)]
    {
        let present = tauri::async_runtime::spawn_blocking(|| rule_present(FW_TCP) && rule_present(FW_UDP)).await.map_err(|e| e.to_string())?;
        Ok(json!({"present": present, "port": port, "discoveryPort": shophub::server::DISCOVERY_PORT, "tcpRule": FW_TCP, "udpRule": FW_UDP}))
    }
    #[cfg(not(windows))]
    {
        Ok(json!({"present": false, "port": port, "discoveryPort": shophub::server::DISCOVERY_PORT}))
    }
}

/// Two inbound rules, for this program's own executable only, on its two
/// ports only, from the local subnet only, on Private networks only. Windows
/// asks the person for permission (UAC); nothing else about the firewall is
/// touched.
#[tauri::command]
pub async fn sync_firewall_enable(state: tauri::State<'_, SyncState>) -> Result<Value, String> {
    let port = hub_port(&state);
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let exe = exe.display().to_string();
        if exe.contains('"') {
            return Err("the program's path cannot be used in a firewall rule".into());
        }
        let script = format!(
            "@echo off\r\n\
             netsh advfirewall firewall delete rule name=\"{FW_TCP}\" >nul 2>&1\r\n\
             netsh advfirewall firewall delete rule name=\"{FW_UDP}\" >nul 2>&1\r\n\
             netsh advfirewall firewall add rule name=\"{FW_TCP}\" dir=in action=allow protocol=TCP localport={port} program=\"{exe}\" profile=private remoteip=localsubnet\r\n\
             netsh advfirewall firewall add rule name=\"{FW_UDP}\" dir=in action=allow protocol=UDP localport={dp} program=\"{exe}\" profile=private remoteip=localsubnet\r\n",
            dp = shophub::server::DISCOVERY_PORT
        );
        let path = std::env::temp_dir().join(format!("jzd-shophub-firewall-{}.cmd", shophub::util::rand_hex(4)));
        std::fs::write(&path, script).map_err(|e| e.to_string())?;
        let ps_path = path.display().to_string().replace('\'', "''");
        let result = tauri::async_runtime::spawn_blocking(move || {
            hidden(std::process::Command::new("powershell.exe").args([
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &format!("Start-Process -FilePath cmd.exe -ArgumentList '/c','\"{ps_path}\"' -Verb RunAs -Wait -WindowStyle Hidden"),
            ]))
            .output()
        })
        .await
        .map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&path);
        let declined = result.map(|o| !o.status.success()).unwrap_or(true);
        let present = tauri::async_runtime::spawn_blocking(|| rule_present(FW_TCP) && rule_present(FW_UDP)).await.map_err(|e| e.to_string())?;
        Ok(json!({"present": present, "declined": declined && !present, "port": port, "discoveryPort": shophub::server::DISCOVERY_PORT}))
    }
    #[cfg(not(windows))]
    {
        let _ = port;
        Err("firewall rules are only set up on Windows".into())
    }
}

// ---------------------------------------------------------------- start with Windows

const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "JZD Shop Manager";

#[tauri::command]
pub async fn sync_autostart_status() -> Result<Value, String> {
    #[cfg(windows)]
    {
        let enabled = tauri::async_runtime::spawn_blocking(|| {
            hidden(std::process::Command::new("reg").args(["query", RUN_KEY, "/v", RUN_VALUE])).output().map(|o| o.status.success()).unwrap_or(false)
        })
        .await
        .map_err(|e| e.to_string())?;
        Ok(json!({"enabled": enabled}))
    }
    #[cfg(not(windows))]
    {
        Ok(json!({"enabled": false}))
    }
}

/// For this Windows user only; starts in the notification area, no window.
#[tauri::command]
pub async fn sync_autostart_set(enabled: bool) -> Result<Value, String> {
    #[cfg(windows)]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?.display().to_string();
        let ok = tauri::async_runtime::spawn_blocking(move || {
            let mut c = std::process::Command::new("reg");
            if enabled {
                c.args(["add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &format!("\"{exe}\" --background"), "/f"]);
            } else {
                c.args(["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
            }
            hidden(&mut c).output().map(|o| o.status.success()).unwrap_or(false)
        })
        .await
        .map_err(|e| e.to_string())?;
        if !ok && enabled {
            return Err("Windows did not accept the start-up setting".into());
        }
        Ok(json!({"enabled": enabled}))
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("starting with Windows is only available on Windows".into())
    }
}

// ---------------------------------------------------------------- one copy at a time

/// Only one copy of the program may own the shop's databases and the hub's
/// port. A second start (a double-click while the hub runs in the
/// notification area) asks the first to show its window and exits.
pub const INSTANCE_PORT: u16 = 47813;

pub fn another_copy_is_running() -> bool {
    use std::io::{Read, Write};
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], INSTANCE_PORT));
    if let Ok(mut s) = std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)) {
        let _ = s.set_read_timeout(Some(std::time::Duration::from_millis(800)));
        let _ = s.write_all(b"JZD-SHOW\n");
        let mut buf = [0u8; 16];
        if let Ok(n) = s.read(&mut buf) {
            return &buf[..n] == b"JZD-OK\n";
        }
    }
    false
}

pub fn listen_for_second_copy(app: tauri::AppHandle) {
    use std::io::{BufRead, BufReader, Write};
    let Ok(listener) = std::net::TcpListener::bind(("127.0.0.1", INSTANCE_PORT)) else { return };
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let mut line = String::new();
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(500)));
            if BufReader::new(&stream).read_line(&mut line).is_ok() && line == "JZD-SHOW\n" {
                let _ = stream.write_all(b"JZD-OK\n");
                crate::show_main_window(&app);
            }
        }
    });
}
