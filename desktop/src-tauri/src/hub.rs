// The native half of the Data Provider Hub.
//
// Three jobs live here because the page must never do them itself:
//
//   * SECRETS. A commercial API key is kept in Windows Credential Manager, under
//     this user, on this machine. The page can put a secret in, ask whether one
//     is there, and remove it. It can never read one back. That is what keeps
//     keys out of shop.json, out of backups and out of anything printed.
//
//   * NETWORK. Requests that carry a secret are built here. The page describes a
//     request with placeholders such as {{secret:apiKey}}; this side fills them
//     in, signs where a provider needs a signature, and refuses to send a secret
//     to any host that provider does not own.
//
//   * DATASETS. NHTSA publishes its manufacturer communications and defect
//     investigations as large public ZIP files. They are downloaded here, and
//     the index built from them is written to a staging folder and swapped into
//     place in one step, so a failed or half-finished refresh can never damage
//     the index the shop is already using.
//
// Nothing in this file depends on Tauri, so all of it is testable on its own.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

// ---------------------------------------------------------------- SHA-256

const K256: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/// SHA-256 by hand, for the same reason base64 is by hand: it is small, it is
/// fully specified, and the test vectors below prove it.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = data.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());
    for block in msg.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([block[i * 4], block[i * 4 + 1], block[i * 4 + 2], block[i * 4 + 3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16].wrapping_add(s0).wrapping_add(w[i - 7]).wrapping_add(s1);
        }
        let (mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh) =
            (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]);
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_left(23);
            let ch = (e & f) ^ (!e & g);
            let t1 = hh.wrapping_add(s1).wrapping_add(ch).wrapping_add(K256[i]).wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(7) ^ a.rotate_left(4);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let t2 = s0.wrapping_add(maj);
            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(t1);
            d = c;
            c = b;
            b = a;
            a = t1.wrapping_add(t2);
        }
        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }
    let mut out = [0u8; 32];
    for (i, v) in h.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&v.to_be_bytes());
    }
    out
}

/// HMAC-SHA-256 (RFC 2104).
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut k = [0u8; 64];
    if key.len() > 64 {
        let d = sha256(key);
        k[..32].copy_from_slice(&d);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    let mut inner = Vec::with_capacity(64 + msg.len());
    let mut outer = Vec::with_capacity(96);
    for b in k.iter() {
        inner.push(b ^ 0x36);
        outer.push(b ^ 0x5c);
    }
    inner.extend_from_slice(msg);
    let ih = sha256(&inner);
    outer.extend_from_slice(&ih);
    sha256(&outer)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------- names

/// Provider ids, field names, dataset names and shard names are all plain
/// tokens. None of them can ever become a path or reach another credential.
pub fn safe_token(s: &str, max: usize) -> bool {
    !s.is_empty()
        && s.len() <= max
        && s.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

pub fn secret_target(provider: &str, field: &str) -> Result<String, String> {
    if !safe_token(provider, 40) || !safe_token(field, 40) {
        return Err("bad provider or credential field name".into());
    }
    Ok(format!("JZDShopManager/{}/{}", provider, field))
}

// ---------------------------------------------------------------- credential store

/// The longest secret we accept. Windows allows 2560 bytes per credential.
pub const MAX_SECRET_BYTES: usize = 2048;

#[cfg(windows)]
mod credman {
    use std::ffi::c_void;

    #[repr(C)]
    #[allow(non_snake_case)]
    struct FILETIME {
        dwLowDateTime: u32,
        dwHighDateTime: u32,
    }

    #[repr(C)]
    #[allow(non_snake_case)]
    struct CREDENTIALW {
        Flags: u32,
        Type: u32,
        TargetName: *mut u16,
        Comment: *mut u16,
        LastWritten: FILETIME,
        CredentialBlobSize: u32,
        CredentialBlob: *mut u8,
        Persist: u32,
        AttributeCount: u32,
        Attributes: *mut c_void,
        TargetAlias: *mut u16,
        UserName: *mut u16,
    }

    #[link(name = "advapi32")]
    extern "system" {
        fn CredWriteW(credential: *const CREDENTIALW, flags: u32) -> i32;
        fn CredReadW(target: *const u16, typ: u32, flags: u32, credential: *mut *mut CREDENTIALW) -> i32;
        fn CredDeleteW(target: *const u16, typ: u32, flags: u32) -> i32;
        fn CredFree(buffer: *mut c_void);
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetLastError() -> u32;
    }

    const CRED_TYPE_GENERIC: u32 = 1;
    const CRED_PERSIST_LOCAL_MACHINE: u32 = 2;
    pub const ERROR_NOT_FOUND: u32 = 1168;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0u16)).collect()
    }

    pub fn put(target: &str, secret: &str) -> Result<(), (u32, String)> {
        let mut t = wide(target);
        let mut user = wide("JZD Shop Manager");
        let mut blob: Vec<u8> = secret.as_bytes().to_vec();
        let cred = CREDENTIALW {
            Flags: 0,
            Type: CRED_TYPE_GENERIC,
            TargetName: t.as_mut_ptr(),
            Comment: std::ptr::null_mut(),
            LastWritten: FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 },
            CredentialBlobSize: blob.len() as u32,
            CredentialBlob: blob.as_mut_ptr(),
            Persist: CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount: 0,
            Attributes: std::ptr::null_mut(),
            TargetAlias: std::ptr::null_mut(),
            UserName: user.as_mut_ptr(),
        };
        let ok = unsafe { CredWriteW(&cred, 0) };
        let err = if ok == 0 { unsafe { GetLastError() } } else { 0 };
        for b in blob.iter_mut() {
            *b = 0;
        }
        if ok == 0 {
            return Err((err, format!("Windows Credential Manager refused the write (error {})", err)));
        }
        Ok(())
    }

    pub fn get(target: &str) -> Result<Option<String>, (u32, String)> {
        let t = wide(target);
        let mut p: *mut CREDENTIALW = std::ptr::null_mut();
        let ok = unsafe { CredReadW(t.as_ptr(), CRED_TYPE_GENERIC, 0, &mut p) };
        if ok == 0 {
            let e = unsafe { GetLastError() };
            if e == ERROR_NOT_FOUND {
                return Ok(None);
            }
            return Err((e, format!("Windows Credential Manager could not be read (error {})", e)));
        }
        let value = unsafe {
            let c = &*p;
            let s = if c.CredentialBlob.is_null() || c.CredentialBlobSize == 0 {
                String::new()
            } else {
                let bytes = std::slice::from_raw_parts(c.CredentialBlob, c.CredentialBlobSize as usize);
                String::from_utf8_lossy(bytes).to_string()
            };
            CredFree(p as *mut c_void);
            s
        };
        Ok(Some(value))
    }

    pub fn delete(target: &str) -> Result<bool, (u32, String)> {
        let t = wide(target);
        let ok = unsafe { CredDeleteW(t.as_ptr(), CRED_TYPE_GENERIC, 0) };
        if ok == 0 {
            let e = unsafe { GetLastError() };
            if e == ERROR_NOT_FOUND {
                return Ok(false);
            }
            return Err((e, format!("Windows Credential Manager could not remove it (error {})", e)));
        }
        Ok(true)
    }
}

#[cfg(windows)]
pub fn secret_put(provider: &str, field: &str, value: &str) -> Result<(), String> {
    let target = secret_target(provider, field)?;
    if value.is_empty() {
        return Err("refusing to store an empty credential".into());
    }
    if value.len() > MAX_SECRET_BYTES {
        return Err("that credential is longer than this machine's credential store allows".into());
    }
    credman::put(&target, value).map_err(|e| e.1)
}

#[cfg(windows)]
pub fn secret_get(provider: &str, field: &str) -> Result<Option<String>, String> {
    let target = secret_target(provider, field)?;
    credman::get(&target).map_err(|e| e.1)
}

#[cfg(windows)]
pub fn secret_delete(provider: &str, field: &str) -> Result<bool, String> {
    let target = secret_target(provider, field)?;
    credman::delete(&target).map_err(|e| e.1)
}

#[cfg(not(windows))]
pub fn secret_put(_provider: &str, _field: &str, _value: &str) -> Result<(), String> {
    Err("no secure credential store is available on this platform".into())
}

#[cfg(not(windows))]
pub fn secret_get(_provider: &str, _field: &str) -> Result<Option<String>, String> {
    Err("no secure credential store is available on this platform".into())
}

#[cfg(not(windows))]
pub fn secret_delete(_provider: &str, _field: &str) -> Result<bool, String> {
    Err("no secure credential store is available on this platform".into())
}

// ---------------------------------------------------------------- hosts

/// Public data. No secret is ever sent to these, and nothing but these can be
/// fetched without a provider.
pub const PUBLIC_HOSTS: &[&str] = &["vpic.nhtsa.dot.gov", "api.nhtsa.gov", "static.nhtsa.gov"];

/// The only hosts each licensed provider's credentials may travel to. An entry
/// starting with a dot matches that domain and any subdomain of it.
pub fn provider_hosts(provider: &str) -> &'static [&'static str] {
    match provider {
        "motor_daas" => &["api.motor.com"],
        "dataone" => &[".dataonesoftware.com"],
        "tecrmi" => &[".tecalliance.net"],
        "autodata" => &[".autodata-group.com"],
        _ => &[],
    }
}

/// The host of an https URL, lower-cased, or None when the URL is not https or
/// has anything unusual in its authority (a user name, a bad character).
pub fn https_host(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let end = rest.find(|c: char| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
    let authority = &rest[..end];
    if authority.is_empty() || authority.contains('@') || authority.contains('\\') {
        return None;
    }
    let host = match authority.rfind(':') {
        Some(i) => {
            let port = &authority[i + 1..];
            if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            &authority[..i]
        }
        None => authority,
    };
    if host.is_empty() || !host.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return None;
    }
    if url.bytes().any(|b| b < 0x21 || b == b'"' || b == 0x7f) {
        return None;
    }
    Some(host.to_ascii_lowercase())
}

pub fn host_allowed(host: &str, rules: &[&str]) -> bool {
    let h = host.to_ascii_lowercase();
    rules.iter().any(|r| {
        if let Some(domain) = r.strip_prefix('.') {
            h == domain || h.ends_with(r)
        } else {
            h == *r
        }
    })
}

// ---------------------------------------------------------------- templates

/// Fill in placeholders:
///   {{secret:FIELD}}                  a credential from the credential store
///   {{session:NAME}}                  a token this side captured earlier
///   {{hmac_sha256_b64:FIELD:MESSAGE}} a signature keyed by a credential, where
///                                     MESSAGE may itself contain [[secret:FIELD]]
/// The lookups are asked for values; the page never is. Returns the expanded
/// text and whether anything secret was used.
pub fn expand_template(
    template: &str,
    lookup: &mut dyn FnMut(&str) -> Result<Option<String>, String>,
) -> Result<(String, bool), String> {
    let mut no_session = |_: &str| -> Option<String> { None };
    expand_template_with(template, lookup, &mut no_session)
}

/// Replace [[secret:FIELD]] inside a message that is about to be signed.
fn expand_inner(message: &str, lookup: &mut dyn FnMut(&str) -> Result<Option<String>, String>) -> Result<String, String> {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(start) = rest.find("[[") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find("]]").ok_or_else(|| "unterminated inner placeholder".to_string())?;
        let inner = &after[..end];
        let field = inner
            .strip_prefix("secret:")
            .ok_or_else(|| "only [[secret:FIELD]] may appear in a signed message".to_string())?;
        if !safe_token(field, 40) {
            return Err("bad credential field in signed message".into());
        }
        let v = lookup(field)?.ok_or_else(|| format!("MISSING_CREDENTIAL:{}", field))?;
        out.push_str(&v);
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

pub fn expand_template_with(
    template: &str,
    lookup: &mut dyn FnMut(&str) -> Result<Option<String>, String>,
    session: &mut dyn FnMut(&str) -> Option<String>,
) -> Result<(String, bool), String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    let mut used = false;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find("}}").ok_or_else(|| "unterminated placeholder".to_string())?;
        let inner = &after[..end];
        if let Some(field) = inner.strip_prefix("secret:") {
            if !safe_token(field, 40) {
                return Err("bad credential field in placeholder".into());
            }
            let v = lookup(field)?.ok_or_else(|| format!("MISSING_CREDENTIAL:{}", field))?;
            out.push_str(&v);
            used = true;
        } else if let Some(name) = inner.strip_prefix("session:") {
            if !safe_token(name, 60) {
                return Err("bad session placeholder".into());
            }
            let v = session(name).ok_or_else(|| format!("MISSING_SESSION:{}", name))?;
            out.push_str(&v);
            used = true;
        } else if let Some(spec) = inner.strip_prefix("hmac_sha256_b64:") {
            let colon = spec.find(':').ok_or_else(|| "bad signature placeholder".to_string())?;
            let field = &spec[..colon];
            let message = &spec[colon + 1..];
            if !safe_token(field, 40) {
                return Err("bad credential field in signature placeholder".into());
            }
            let key = lookup(field)?.ok_or_else(|| format!("MISSING_CREDENTIAL:{}", field))?;
            let message = expand_inner(message, lookup)?;
            let mac = hmac_sha256(key.as_bytes(), message.as_bytes());
            out.push_str(&crate::b64_encode(&mac));
            used = true;
        } else {
            return Err(format!("unknown placeholder {{{{{}}}}}", inner.split(':').next().unwrap_or("")));
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok((out, used))
}

// ---------------------------------------------------------------- sessions

/// Tokens a provider hands back after logging in (TecRMI's X-AuthToken, an
/// OAuth access token). Kept in memory for this run only and never returned to
/// the page; a restart simply logs in again.
fn sessions() -> &'static std::sync::Mutex<std::collections::HashMap<String, String>> {
    static S: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, String>>> =
        std::sync::OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub fn session_put(provider: &str, name: &str, value: &str) {
    if let Ok(mut m) = sessions().lock() {
        m.insert(format!("{}/{}", provider, name), value.to_string());
    }
}

pub fn session_get(provider: &str, name: &str) -> Option<String> {
    sessions().lock().ok().and_then(|m| m.get(&format!("{}/{}", provider, name)).cloned())
}

pub fn session_clear(provider: &str) {
    if let Ok(mut m) = sessions().lock() {
        let prefix = format!("{}/", provider);
        m.retain(|k, _| !k.starts_with(&prefix));
    }
}

/// Find one header's value in a curl header dump. The last response wins, so a
/// redirect's headers are never mistaken for the final answer's.
pub fn header_value(dump: &str, name: &str) -> Option<String> {
    let mut found = None;
    for line in dump.lines() {
        if line.starts_with("HTTP/") {
            found = None;
            continue;
        }
        if let Some(i) = line.find(':') {
            if line[..i].trim().eq_ignore_ascii_case(name) {
                found = Some(line[i + 1..].trim().to_string());
            }
        }
    }
    found
}

// ---------------------------------------------------------------- curl

/// One HTTPS request, described by the page.
#[derive(Clone, Debug)]
pub struct Request {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_secs: u64,
    pub max_bytes: u64,
    pub follow_redirects: bool,
    pub header_file: Option<PathBuf>,
}

/// Quote a value for a curl config file.
pub fn curl_quote(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    o.push('"');
    for c in s.chars() {
        match c {
            '\\' => o.push_str("\\\\"),
            '"' => o.push_str("\\\""),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            _ => o.push(c),
        }
    }
    o.push('"');
    o
}

/// The request as a curl config, handed over on stdin so nothing in it —
/// least of all a credential — appears in the process list.
pub fn curl_config(req: &Request, out: &Path, body_file: Option<&Path>) -> Result<String, String> {
    let method = req.method.to_ascii_uppercase();
    if !["GET", "POST", "PUT"].contains(&method.as_str()) {
        return Err("unsupported request method".into());
    }
    if https_host(&req.url).is_none() {
        return Err("only plain https addresses can be requested".into());
    }
    let mut c = String::new();
    c.push_str(&format!("url = {}\n", curl_quote(&req.url)));
    c.push_str(&format!("request = {}\n", curl_quote(&method)));
    for (name, value) in &req.headers {
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err("bad header name".into());
        }
        if value.contains('\r') || value.contains('\n') {
            return Err("a header value cannot contain a line break".into());
        }
        c.push_str(&format!("header = {}\n", curl_quote(&format!("{}: {}", name, value))));
    }
    if let Some(bf) = body_file {
        c.push_str(&format!("data-binary = {}\n", curl_quote(&format!("@{}", bf.display()))));
    }
    c.push_str(&format!("output = {}\n", curl_quote(&out.display().to_string())));
    if let Some(hf) = &req.header_file {
        c.push_str(&format!("dump-header = {}\n", curl_quote(&hf.display().to_string())));
    }
    c.push_str(&format!("max-time = {}\n", req.timeout_secs.clamp(3, 900)));
    c.push_str("connect-timeout = 15\n");
    c.push_str(&format!("max-filesize = {}\n", req.max_bytes.max(1024)));
    c.push_str("proto = \"=https\"\n");
    c.push_str("proto-redir = \"=https\"\n");
    if req.follow_redirects {
        c.push_str("location\n");
        c.push_str("max-redirs = 5\n");
    }
    c.push_str("silent\nshow-error\n");
    c.push_str("user-agent = \"JZD-Shop-Manager\"\n");
    c.push_str("write-out = \"%{http_code}\"\n");
    Ok(c)
}

fn curl_exe() -> PathBuf {
    if let Ok(root) = std::env::var("SystemRoot") {
        let p = PathBuf::from(root).join("System32").join("curl.exe");
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("curl")
}

/// Run a request to a file. Returns the HTTP status.
pub fn run_request(req: &Request, out: &Path, scratch: &Path) -> Result<u16, String> {
    fs::create_dir_all(scratch).map_err(|e| format!("cannot create {}: {e}", scratch.display()))?;
    let body_file = match &req.body {
        Some(b) => {
            let bf = scratch.join(format!("body-{}.tmp", crate::next_seq()));
            fs::write(&bf, b.as_bytes()).map_err(|e| format!("cannot stage request body: {e}"))?;
            Some(bf)
        }
        None => None,
    };
    let config = curl_config(req, out, body_file.as_deref());
    let config = match config {
        Ok(c) => c,
        Err(e) => {
            if let Some(bf) = &body_file {
                let _ = fs::remove_file(bf);
            }
            return Err(e);
        }
    };
    let mut cmd = Command::new(curl_exe());
    cmd.arg("-K").arg("-").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // no console window
    }
    let result = (|| -> Result<u16, String> {
        let mut child = cmd.spawn().map_err(|e| format!("could not start the network helper: {e}"))?;
        {
            let stdin = child.stdin.as_mut().ok_or_else(|| "network helper has no input".to_string())?;
            stdin.write_all(config.as_bytes()).map_err(|e| format!("network helper input failed: {e}"))?;
        }
        drop(child.stdin.take());
        let mut so = String::new();
        let mut se = String::new();
        if let Some(mut s) = child.stdout.take() {
            let _ = s.read_to_string(&mut so);
        }
        if let Some(mut s) = child.stderr.take() {
            let _ = s.read_to_string(&mut se);
        }
        let status = child.wait().map_err(|e| format!("network helper failed: {e}"))?;
        let code: u16 = so.trim().parse().unwrap_or(0);
        if code == 0 {
            let msg = se.trim();
            let exit = status.code().unwrap_or(-1);
            return Err(if msg.is_empty() {
                format!("no response (network helper exit {})", exit)
            } else {
                format!("no response: {}", msg.lines().last().unwrap_or(msg))
            });
        }
        Ok(code)
    })();
    if let Some(bf) = &body_file {
        let _ = fs::remove_file(bf);
    }
    result
}

// ---------------------------------------------------------------- datasets

pub fn ds_root(base: &Path) -> PathBuf {
    base.join("datasets")
}

fn check_ds(name: &str) -> Result<(), String> {
    if safe_token(name, 40) {
        Ok(())
    } else {
        Err("bad dataset name".into())
    }
}

pub fn ds_incoming(base: &Path, name: &str) -> Result<PathBuf, String> {
    check_ds(name)?;
    let dir = ds_root(base).join("_incoming");
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir.join(format!("{}.zip", name)))
}

pub fn ds_begin(base: &Path, name: &str) -> Result<(), String> {
    check_ds(name)?;
    let building = ds_root(base).join(format!("{}.building", name));
    if building.exists() {
        fs::remove_dir_all(&building).map_err(|e| format!("cannot clear an unfinished refresh: {e}"))?;
    }
    fs::create_dir_all(&building).map_err(|e| format!("cannot start a refresh: {e}"))
}

pub fn ds_write(base: &Path, name: &str, shard: &str, text: &str, append: bool) -> Result<(), String> {
    check_ds(name)?;
    if !safe_token(shard, 60) {
        return Err("bad shard name".into());
    }
    let building = ds_root(base).join(format!("{}.building", name));
    if !building.is_dir() {
        return Err("no refresh is in progress for this dataset".into());
    }
    let p = building.join(format!("{}.ndjson", shard));
    let mut f = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(append)
        .truncate(!append)
        .open(&p)
        .map_err(|e| format!("cannot open {}: {e}", p.display()))?;
    f.write_all(text.as_bytes()).map_err(|e| format!("cannot write {}: {e}", p.display()))?;
    f.flush().map_err(|e| format!("cannot flush {}: {e}", p.display()))
}

/// Swap a finished refresh into place. The old index is moved aside first and
/// only removed once the new one is in; if anything fails the old one is put
/// back exactly as it was.
pub fn ds_commit(base: &Path, name: &str, meta: &str) -> Result<(), String> {
    check_ds(name)?;
    let root = ds_root(base);
    let live = root.join(name);
    let building = root.join(format!("{}.building", name));
    let previous = root.join(format!("{}.previous", name));
    if !building.is_dir() {
        return Err("no refresh is in progress for this dataset".into());
    }
    let shards = fs::read_dir(&building)
        .map_err(|e| format!("cannot read the new index: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".ndjson"))
        .count();
    if shards == 0 {
        return Err("the new index is empty; the existing index was left in place".into());
    }
    if meta.trim().is_empty() {
        return Err("the new index has no description; the existing index was left in place".into());
    }
    {
        let mp = building.join("meta.json");
        let mut f = fs::File::create(&mp).map_err(|e| format!("cannot write index description: {e}"))?;
        f.write_all(meta.as_bytes()).map_err(|e| format!("cannot write index description: {e}"))?;
        f.sync_all().map_err(|e| format!("cannot commit index description: {e}"))?;
    }
    if previous.exists() {
        fs::remove_dir_all(&previous).map_err(|e| format!("cannot clear an old copy: {e}"))?;
    }
    let had_live = live.exists();
    if had_live {
        fs::rename(&live, &previous).map_err(|e| format!("cannot move the current index aside: {e}"))?;
    }
    if let Err(e) = fs::rename(&building, &live) {
        if had_live {
            let _ = fs::rename(&previous, &live);
        }
        return Err(format!("cannot put the new index in place (the existing index was restored): {e}"));
    }
    if had_live {
        let _ = fs::remove_dir_all(&previous);
    }
    Ok(())
}

pub fn ds_abort(base: &Path, name: &str) -> Result<(), String> {
    check_ds(name)?;
    let building = ds_root(base).join(format!("{}.building", name));
    if building.exists() {
        fs::remove_dir_all(&building).map_err(|e| format!("cannot discard the unfinished refresh: {e}"))?;
    }
    Ok(())
}

pub fn ds_read(base: &Path, name: &str, shard: &str) -> Result<Option<String>, String> {
    check_ds(name)?;
    if !safe_token(shard, 60) {
        return Err("bad shard name".into());
    }
    let p = ds_root(base).join(name).join(format!("{}.ndjson", shard));
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(&p).map(Some).map_err(|e| format!("cannot read {}: {e}", p.display()))
}

pub fn ds_meta(base: &Path, name: &str) -> Result<Option<String>, String> {
    check_ds(name)?;
    let p = ds_root(base).join(name).join("meta.json");
    if !p.exists() {
        return Ok(None);
    }
    fs::read_to_string(&p).map(Some).map_err(|e| format!("cannot read {}: {e}", p.display()))
}

// ---------------------------------------------------------------- opening a portal

/// A portal opens in the shop's own browser. Only a plain https address with no
/// characters that could be read as anything other than a URL is accepted.
pub fn safe_external_url(url: &str) -> bool {
    https_host(url).is_some()
        && url.len() <= 2000
        && url.bytes().all(|b| b > 0x20 && b < 0x7f && !matches!(b, b'"' | b'<' | b'>' | b'`' | b'|' | b'^' | b'\\'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha256_matches_the_published_vectors() {
        assert_eq!(hex(&sha256(b"")), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
        assert_eq!(hex(&sha256(b"abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert_eq!(
            hex(&sha256(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        let million = vec![b'a'; 1_000_000];
        assert_eq!(hex(&sha256(&million)), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
    }

    #[test]
    fn hmac_matches_rfc_4231() {
        let key = [0x0bu8; 20];
        assert_eq!(
            hex(&hmac_sha256(&key, b"Hi There")),
            "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"
        );
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
        let long_key = [0xaau8; 131];
        assert_eq!(
            hex(&hmac_sha256(&long_key, b"Test Using Larger Than Block-Size Key - Hash Key First")),
            "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"
        );
    }

    #[test]
    fn credential_names_cannot_be_forged() {
        assert_eq!(secret_target("motor_daas", "privateKey").unwrap(), "JZDShopManager/motor_daas/privateKey");
        for (p, f) in [("motor/../x", "k"), ("motor", "a b"), ("", "k"), ("motor", ""), ("mo\\tor", "k"), ("motor", "k:1")] {
            assert!(secret_target(p, f).is_err(), "{p}/{f} must be refused");
        }
    }

    #[test]
    fn a_secret_goes_in_and_can_be_checked_and_removed() {
        // The build machine may run without an interactive logon session, in
        // which case Windows has no credential store to offer. That is reported,
        // not hidden, and the rest of the checks still run.
        let field = format!("test{}", std::process::id());
        match secret_put("jzdtest", &field, "s3cret-value") {
            Ok(()) => {
                assert_eq!(secret_get("jzdtest", &field).unwrap().as_deref(), Some("s3cret-value"));
                assert!(secret_delete("jzdtest", &field).unwrap());
                assert_eq!(secret_get("jzdtest", &field).unwrap(), None);
                assert!(!secret_delete("jzdtest", &field).unwrap());
            }
            Err(e) => eprintln!("credential store unavailable on this machine, round trip skipped: {e}"),
        }
        assert!(secret_put("jzdtest", "empty", "").is_err());
        assert!(secret_put("jzdtest", "huge", &"x".repeat(MAX_SECRET_BYTES + 1)).is_err());
    }

    #[test]
    fn only_https_hosts_are_understood() {
        assert_eq!(https_host("https://api.motor.com/v1/HelloWorld").as_deref(), Some("api.motor.com"));
        assert_eq!(https_host("https://API.Motor.com:443/x?y=1").as_deref(), Some("api.motor.com"));
        for bad in [
            "http://api.motor.com/",
            "https://api.motor.com@evil.example/",
            "https:///nohost",
            "https://api.motor.com:abc/",
            "https://api motor.com/",
            "https://api.motor.com/a b",
            "ftp://api.motor.com/",
            "https://evil.example\\@api.motor.com/",
        ] {
            assert!(https_host(bad).is_none(), "{bad} must be refused");
        }
    }

    #[test]
    fn a_secret_only_goes_to_its_own_provider() {
        assert!(host_allowed("api.motor.com", provider_hosts("motor_daas")));
        assert!(!host_allowed("api.motor.com.evil.example", provider_hosts("motor_daas")));
        assert!(!host_allowed("evilapi.motor.com", provider_hosts("motor_daas")));
        assert!(host_allowed("rmi-services.tecalliance.net", provider_hosts("tecrmi")));
        assert!(!host_allowed("tecalliance.net.evil.example", provider_hosts("tecrmi")));
        assert!(!host_allowed("eviltecalliance.net", provider_hosts("tecrmi")));
        assert!(host_allowed("api.dataonesoftware.com", provider_hosts("dataone")));
        assert!(provider_hosts("alldata").is_empty(), "a portal has no API host to send a credential to");
        assert!(host_allowed("api.nhtsa.gov", PUBLIC_HOSTS));
        assert!(!host_allowed("api.motor.com", PUBLIC_HOSTS));
    }

    #[test]
    fn placeholders_expand_without_the_page_seeing_the_value() {
        let mut lookup = |f: &str| -> Result<Option<String>, String> {
            Ok(match f {
                "apiKey" => Some("KEY123".to_string()),
                "privateKey" => Some("key".to_string()),
                _ => None,
            })
        };
        let (s, used) = expand_template("Bearer {{secret:apiKey}}", &mut lookup).unwrap();
        assert_eq!(s, "Bearer KEY123");
        assert!(used);
        let (s, used) = expand_template("no secrets here", &mut lookup).unwrap();
        assert_eq!(s, "no secrets here");
        assert!(!used);
        // HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog"), base64
        let (s, _) = expand_template(
            "Shared PUB:{{hmac_sha256_b64:privateKey:The quick brown fox jumps over the lazy dog}}",
            &mut lookup,
        )
        .unwrap();
        assert_eq!(s, "Shared PUB:97yD9DBThCSxMpjmqm+xQ+9NWaFJRhdZl0edvC0aPNg=");
        let missing = expand_template("{{secret:nope}}", &mut lookup).unwrap_err();
        assert!(missing.starts_with("MISSING_CREDENTIAL:nope"), "{missing}");
        assert!(expand_template("{{secret:../x}}", &mut lookup).is_err());
        assert!(expand_template("{{file:C:/x}}", &mut lookup).is_err());
        assert!(expand_template("{{secret:apiKey", &mut lookup).is_err());
    }

    #[test]
    fn a_signed_message_can_include_a_credential_it_does_not_reveal() {
        let mut lookup = |f: &str| -> Result<Option<String>, String> {
            Ok(match f {
                "publicKey" => Some("PUB".to_string()),
                "privateKey" => Some("key".to_string()),
                _ => None,
            })
        };
        let (a, _) = expand_template("{{hmac_sha256_b64:privateKey:[[secret:publicKey]]:message}}", &mut lookup).unwrap();
        let expected = crate::b64_encode(&hmac_sha256(b"key", b"PUB:message"));
        assert_eq!(a, expected);
        assert!(expand_template("{{hmac_sha256_b64:privateKey:[[session:x]]}}", &mut lookup).is_err());
        let mut sess = |n: &str| if n == "X-AuthToken" { Some("TOK".to_string()) } else { None };
        let (b, used) = expand_template_with("TecRMI {{session:X-AuthToken}}", &mut lookup, &mut sess).unwrap();
        assert_eq!(b, "TecRMI TOK");
        assert!(used);
        assert!(expand_template_with("{{session:Other}}", &mut lookup, &mut sess)
            .unwrap_err()
            .starts_with("MISSING_SESSION"));
        session_put("tecrmitest", "X-AuthToken", "abc");
        assert_eq!(session_get("tecrmitest", "X-AuthToken").as_deref(), Some("abc"));
        session_clear("tecrmitest");
        assert_eq!(session_get("tecrmitest", "X-AuthToken"), None);
    }

    #[test]
    fn the_final_response_header_is_the_one_captured() {
        let dump = "HTTP/1.1 302 Found\r\nX-AuthToken: wrong\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\nx-authtoken:  right \r\n\r\n";
        assert_eq!(header_value(dump, "X-AuthToken").as_deref(), Some("right"));
        assert_eq!(header_value("HTTP/1.1 200 OK\r\n\r\n", "X-AuthToken"), None);
    }

    #[test]
    fn curl_config_is_quoted_and_refuses_injection() {
        let req = Request {
            method: "GET".into(),
            url: "https://api.nhtsa.gov/recalls/recallsByVehicle?make=BMW&model=M3&modelYear=2018".into(),
            headers: vec![("Accept".into(), "application/json".into())],
            body: None,
            timeout_secs: 20,
            max_bytes: 1_000_000,
            follow_redirects: false,
            header_file: None,
        };
        let cfg = curl_config(&req, Path::new("C:\\out\\x.tmp"), None).unwrap();
        assert!(cfg.contains("url = \"https://api.nhtsa.gov/recalls/recallsByVehicle?make=BMW&model=M3&modelYear=2018\""));
        assert!(cfg.contains("header = \"Accept: application/json\""));
        assert!(cfg.contains("output = \"C:\\\\out\\\\x.tmp\""));
        assert!(cfg.contains("proto = \"=https\""));
        assert!(!cfg.contains("location"), "redirects are off unless asked for");
        let mut bad = req.clone();
        bad.headers = vec![("X-A".into(), "a\r\nurl = \"https://evil.example\"".into())];
        assert!(curl_config(&bad, Path::new("o"), None).is_err());
        let mut bad = req.clone();
        bad.headers = vec![("X A".into(), "v".into())];
        assert!(curl_config(&bad, Path::new("o"), None).is_err());
        let mut bad = req.clone();
        bad.method = "DELETE".into();
        assert!(curl_config(&bad, Path::new("o"), None).is_err());
        let mut bad = req.clone();
        bad.url = "http://api.nhtsa.gov/".into();
        assert!(curl_config(&bad, Path::new("o"), None).is_err());
        assert_eq!(curl_quote("a\"b\\c"), "\"a\\\"b\\\\c\"");
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("jzdhub-{}-{}-{}", tag, std::process::id(), crate::next_seq()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_refresh_replaces_the_index_in_one_step() {
        let base = scratch("commit");
        ds_begin(&base, "mfrcomms").unwrap();
        ds_write(&base, "mfrcomms", "BMW", "{\"id\":1}\n", false).unwrap();
        ds_write(&base, "mfrcomms", "BMW", "{\"id\":2}\n", true).unwrap();
        ds_commit(&base, "mfrcomms", "{\"records\":2}").unwrap();
        assert_eq!(ds_read(&base, "mfrcomms", "BMW").unwrap().unwrap(), "{\"id\":1}\n{\"id\":2}\n");
        assert_eq!(ds_meta(&base, "mfrcomms").unwrap().unwrap(), "{\"records\":2}");

        // a second, successful refresh replaces it entirely
        ds_begin(&base, "mfrcomms").unwrap();
        ds_write(&base, "mfrcomms", "FORD", "{\"id\":9}\n", false).unwrap();
        ds_commit(&base, "mfrcomms", "{\"records\":1}").unwrap();
        assert!(ds_read(&base, "mfrcomms", "BMW").unwrap().is_none());
        assert_eq!(ds_read(&base, "mfrcomms", "FORD").unwrap().unwrap(), "{\"id\":9}\n");
        assert!(!ds_root(&base).join("mfrcomms.previous").exists());
        assert!(!ds_root(&base).join("mfrcomms.building").exists());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_failed_refresh_leaves_the_working_index_alone() {
        let base = scratch("fail");
        ds_begin(&base, "inv").unwrap();
        ds_write(&base, "inv", "BMW", "good\n", false).unwrap();
        ds_commit(&base, "inv", "{\"records\":1}").unwrap();

        // an empty refresh is refused
        ds_begin(&base, "inv").unwrap();
        assert!(ds_commit(&base, "inv", "{\"records\":0}").is_err());
        assert_eq!(ds_read(&base, "inv", "BMW").unwrap().unwrap(), "good\n");

        // an abandoned refresh is discarded without touching the index
        ds_write(&base, "inv", "BMW", "half written", false).unwrap();
        ds_abort(&base, "inv").unwrap();
        assert_eq!(ds_read(&base, "inv", "BMW").unwrap().unwrap(), "good\n");
        assert_eq!(ds_meta(&base, "inv").unwrap().unwrap(), "{\"records\":1}");

        // nothing can be committed or written without a refresh in progress
        assert!(ds_commit(&base, "inv", "{}").is_err());
        assert!(ds_write(&base, "inv", "BMW", "x", false).is_err());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn dataset_and_shard_names_cannot_escape() {
        let base = scratch("names");
        for bad in ["../x", "a/b", "a.b", "", "a b"] {
            assert!(ds_begin(&base, bad).is_err(), "{bad}");
            assert!(ds_read(&base, "ok", bad).is_err(), "{bad}");
        }
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn only_plain_https_portals_can_be_opened() {
        assert!(safe_external_url("https://bmwtechinfo.bmwgroup.com/"));
        assert!(safe_external_url("https://app.partstech.com/?vin=WBS8M9C55J5J78069"));
        for bad in [
            "http://bmwtechinfo.bmwgroup.com/",
            "file:///C:/Windows/System32/calc.exe",
            "https://x.com/\"&calc",
            "https://x.com/a|b",
            "javascript:alert(1)",
            "https://x.com/a b",
        ] {
            assert!(!safe_external_url(bad), "{bad} must be refused");
        }
    }
}
