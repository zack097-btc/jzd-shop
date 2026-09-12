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
//     in, signs the request itself where a provider needs a signature (the page
//     can never ask for a signature over text of its own choosing), and refuses
//     to send a secret to any host that provider does not own.
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

// ---------------------------------------------------------------- signing

use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;

/// HMAC-SHA-256 from the RustCrypto crates. No cryptography is written here.
pub fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("HMAC accepts a key of any length");
    mac.update(msg);
    mac.finalize().into_bytes().into()
}

pub fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

// ---------------------------------------------------------------- MOTOR "Shared" signing
//
// From MOTOR's DaaS Development Handbook, "Signing a Request":
//
//   Authorization = "Shared" + " " + PublicKey + ":" + Signature
//   Signature     = Base64(HMAC-SHA256(PrivateKey, SignatureData))
//   SignatureData = PublicKey + "\n" + HTTP verb + "\n" + UNIX epoch + "\n" + URI path
//
// The URI path starts with "/", keeps its case and leaves out the query string.
// The time stamp travels in the X-Date header and must be the same second that
// was signed; MOTOR refuses anything more than 15 minutes from its own clock.
// The retired "MWS" scheme is not implemented.

/// The path part of an https URL: from the first "/" after the host up to, and
/// not including, any "?" or "#". An address with no path signs as "/".
pub fn uri_path(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let start = rest.find(|c: char| c == '/' || c == '?' || c == '#').unwrap_or(rest.len());
    let tail = &rest[start..];
    let end = tail.find(|c: char| c == '?' || c == '#').unwrap_or(tail.len());
    let path = &tail[..end];
    Some(if path.is_empty() { "/".to_string() } else { path.to_string() })
}

pub fn motor_signature_data(public_key: &str, verb: &str, epoch: u64, path: &str) -> String {
    format!("{}\n{}\n{}\n{}", public_key, verb, epoch, path)
}

pub fn motor_authorization(public_key: &str, private_key: &str, verb: &str, epoch: u64, path: &str) -> String {
    let data = motor_signature_data(public_key, verb, epoch, path);
    format!("Shared {}:{}", public_key, b64(&hmac_sha256(private_key.as_bytes(), data.as_bytes())))
}

/// An RFC 1123 date ("Thu, 16 Apr 2015 16:12:01 GMT") for a UNIX epoch second,
/// which is one of the formats MOTOR's handbook lists for X-Date.
pub fn http_date(epoch: u64) -> String {
    let days = (epoch / 86_400) as i64;
    let secs = epoch % 86_400;
    // civil-from-days (Howard Hinnant), valid for every date this program will see
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    if month <= 2 {
        year += 1;
    }
    const WD: [&str; 7] = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"];
    const MO: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    format!(
        "{}, {:02} {} {} {:02}:{:02}:{:02} GMT",
        WD[(days.rem_euclid(7)) as usize],
        day,
        MO[(month - 1) as usize],
        year,
        secs / 3_600,
        (secs / 60) % 60,
        secs % 60
    )
}

pub fn now_epoch() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
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
///   {{secret:FIELD}}   a credential from the credential store
///   {{session:NAME}}   a token this side captured earlier
/// The lookups are asked for values; the page never is. Returns the expanded
/// text and whether anything secret was used. There is deliberately no
/// placeholder that signs: a signature is made only by a provider's own signing
/// scheme below, over the request actually being sent.
pub fn expand_template(
    template: &str,
    lookup: &mut dyn FnMut(&str) -> Result<Option<String>, String>,
) -> Result<(String, bool), String> {
    let mut no_session = |_: &str| -> Option<String> { None };
    expand_template_with(template, lookup, &mut no_session)
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
        } else {
            return Err(format!("unknown placeholder {{{{{}}}}}", inner.split(':').next().unwrap_or("")));
        }
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok((out, used))
}

// ---------------------------------------------------------------- provider requests

/// A request as the page describes it for a licensed provider.
#[derive(Clone, Debug, Default)]
pub struct ProviderSpec {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    pub timeout_secs: u64,
    /// "motor_shared" asks for MOTOR's documented Shared signature. Nothing else
    /// is accepted, and only for MOTOR.
    pub auth: Option<String>,
}

/// Headers a signing scheme sets itself. The page may not supply them, so the
/// time stamp that is signed is always the one that is sent.
const SIGNED_HEADERS: &[&str] = &["authorization", "x-date", "date"];

/// Turn the page's description into the request that will actually go out:
/// check the host, fill in credentials and session tokens, and sign. Pure apart
/// from the lookups, so every rule here is tested without a network.
pub fn prepare_provider_request(
    provider: &str,
    spec: &ProviderSpec,
    lookup: &mut dyn FnMut(&str) -> Result<Option<String>, String>,
    session: &mut dyn FnMut(&str) -> Option<String>,
    epoch: u64,
    max_bytes: u64,
) -> Result<Request, String> {
    if !safe_token(provider, 40) {
        return Err("bad provider id".into());
    }
    let host = https_host(&spec.url).ok_or_else(|| "only plain https addresses can be requested".to_string())?;
    if !host_allowed(&host, provider_hosts(provider)) {
        return Err(format!("{host} is not a host that {provider} credentials may be sent to"));
    }
    let method = if spec.method.is_empty() { "GET".to_string() } else { spec.method.to_ascii_uppercase() };
    let (url, _) = expand_template_with(&spec.url, lookup, session)?;
    // The expanded address must still be the same host.
    if https_host(&url).as_deref() != Some(host.as_str()) {
        return Err("the request address changed host after expansion".into());
    }
    let signing = match spec.auth.as_deref() {
        None | Some("") => None,
        Some("motor_shared") if provider == "motor_daas" => Some("motor_shared"),
        Some(other) => return Err(format!("{provider} has no signing scheme called {other}")),
    };
    let mut headers = vec![];
    for (name, value) in &spec.headers {
        if signing.is_some() && SIGNED_HEADERS.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(format!("the {name} header is set by the signing step, not by the page"));
        }
        let (v, _) = expand_template_with(value, lookup, session)?;
        headers.push((name.clone(), v));
    }
    let body = match &spec.body {
        Some(b) => Some(expand_template_with(b, lookup, session)?.0),
        None => None,
    };
    if signing == Some("motor_shared") {
        let public_key = lookup("publicKey")?.ok_or_else(|| "MISSING_CREDENTIAL:publicKey".to_string())?;
        let private_key = lookup("privateKey")?.ok_or_else(|| "MISSING_CREDENTIAL:privateKey".to_string())?;
        let path = uri_path(&url).ok_or_else(|| "cannot read the request path".to_string())?;
        headers.push(("X-Date".into(), http_date(epoch)));
        headers.push(("Authorization".into(), motor_authorization(&public_key, &private_key, &method, epoch, &path)));
    }
    Ok(Request {
        method,
        url,
        headers,
        body,
        timeout_secs: if spec.timeout_secs == 0 { 30 } else { spec.timeout_secs },
        max_bytes,
        // a redirect could carry an Authorization header somewhere else
        follow_redirects: false,
        header_file: None,
    })
}

/// Redirects are never followed for a licensed provider. When one comes back,
/// say where it pointed instead of passing on an empty body.
pub fn redirect_refusal(status: u16, dump: &str) -> Option<String> {
    if (300..400).contains(&status) {
        let to = header_value(dump, "Location").unwrap_or_default();
        let where_to = https_host(&to).unwrap_or_else(|| if to.is_empty() { "an unstated address".into() } else { to.clone() });
        return Some(format!("REDIRECT_REFUSED: the provider answered {status} pointing to {where_to}; credentials are never forwarded"));
    }
    None
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
    if !["GET", "POST", "PUT", "HEAD"].contains(&method.as_str()) {
        return Err("unsupported request method".into());
    }
    if https_host(&req.url).is_none() {
        return Err("only plain https addresses can be requested".into());
    }
    let mut c = String::new();
    c.push_str(&format!("url = {}\n", curl_quote(&req.url)));
    if method == "HEAD" {
        c.push_str("head\n");
    } else {
        c.push_str(&format!("request = {}\n", curl_quote(&method)));
    }
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
//
// datasets/
//   <name>/                 the index in use: <MAKE>.ndjson shards + meta.json
//   <name>.building/        a refresh in progress
//   <name>.previous/        the old index, only for the instant of the swap
//   <name>.status.json      last check, last success, last failure — kept even
//                           when an update fails, and never part of the index
//   _sources/<name>/<file>.zip       the NHTSA file the index was built from
//   _sources/<name>/<file>.new.zip   a newer download, adopted only on commit

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

fn sources_dir(base: &Path, name: &str) -> Result<PathBuf, String> {
    check_ds(name)?;
    let dir = ds_root(base).join("_sources").join(name);
    fs::create_dir_all(&dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Where a downloaded NHTSA file is kept. `fresh` is a new download that has
/// not been adopted yet.
pub fn ds_source_path(base: &Path, name: &str, file: &str, fresh: bool) -> Result<PathBuf, String> {
    if !safe_token(file, 60) {
        return Err("bad source file name".into());
    }
    let dir = sources_dir(base, name)?;
    Ok(dir.join(if fresh { format!("{}.new.zip", file) } else { format!("{}.zip", file) }))
}

/// The file to read a source from: a fresh download if there is one, otherwise
/// the one the current index was built from.
pub fn ds_source_for_reading(base: &Path, name: &str, file: &str) -> Result<Option<PathBuf>, String> {
    let fresh = ds_source_path(base, name, file, true)?;
    if fresh.is_file() {
        return Ok(Some(fresh));
    }
    let kept = ds_source_path(base, name, file, false)?;
    Ok(if kept.is_file() { Some(kept) } else { None })
}

/// A download is only kept if it is a whole ZIP archive: a local file header at
/// the start and an end-of-central-directory record in the last 65,557 bytes
/// (the largest distance the ZIP format allows). A truncated transfer fails the
/// second check.
pub fn zip_is_complete(path: &Path) -> Result<(), String> {
    let mut f = fs::File::open(path).map_err(|e| format!("cannot open the download: {e}"))?;
    let len = f.metadata().map_err(|e| format!("cannot read the download: {e}"))?.len();
    if len < 22 {
        return Err("the download is too small to be a ZIP archive".into());
    }
    let mut head = [0u8; 4];
    f.read_exact(&mut head).map_err(|e| format!("cannot read the download: {e}"))?;
    if head != [0x50, 0x4b, 0x03, 0x04] {
        return Err("the download is not a ZIP archive".into());
    }
    use std::io::{Seek, SeekFrom};
    let tail_len = len.min(65_557);
    f.seek(SeekFrom::Start(len - tail_len)).map_err(|e| format!("cannot read the download: {e}"))?;
    let mut tail = vec![0u8; tail_len as usize];
    f.read_exact(&mut tail).map_err(|e| format!("cannot read the download: {e}"))?;
    // the record is 22 bytes, so its signature can be no nearer the end than that
    let found = (0..=tail.len() - 22).rev().any(|i| tail[i..i + 4] == [0x50, 0x4b, 0x05, 0x06]);
    if !found {
        return Err("the download is incomplete (the ZIP directory is missing)".into());
    }
    Ok(())
}

/// Keep a finished download beside the file in use. Called after the transfer
/// has been written to `part` and has passed `zip_is_complete`.
pub fn ds_stage_source(base: &Path, name: &str, file: &str, part: &Path) -> Result<u64, String> {
    zip_is_complete(part)?;
    {
        let f = fs::OpenOptions::new().write(true).open(part).map_err(|e| format!("cannot finish the download: {e}"))?;
        f.sync_all().map_err(|e| format!("cannot flush the download: {e}"))?;
    }
    let dest = ds_source_path(base, name, file, true)?;
    let _ = fs::remove_file(&dest);
    fs::rename(part, &dest).map_err(|e| format!("cannot keep the download: {e}"))?;
    Ok(fs::metadata(&dest).map(|m| m.len()).unwrap_or(0))
}

/// After a successful commit: fresh downloads replace the files they update,
/// and files the index no longer uses are removed.
pub fn ds_adopt_sources(base: &Path, name: &str, keep: &[String]) -> Result<(), String> {
    let dir = sources_dir(base, name)?;
    for file in keep {
        let fresh = ds_source_path(base, name, file, true)?;
        if fresh.is_file() {
            let kept = ds_source_path(base, name, file, false)?;
            let _ = fs::remove_file(&kept);
            fs::rename(&fresh, &kept).map_err(|e| format!("cannot adopt {file}: {e}"))?;
        }
    }
    for entry in fs::read_dir(&dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?.flatten() {
        let n = entry.file_name().to_string_lossy().to_string();
        let stem = n.strip_suffix(".new.zip").or_else(|| n.strip_suffix(".zip")).unwrap_or(&n).to_string();
        if !keep.contains(&stem) {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
}

/// After a failed refresh: downloads that were never used are thrown away and
/// the files the working index came from stay exactly as they were.
pub fn ds_discard_fresh_sources(base: &Path, name: &str) -> Result<(), String> {
    let dir = sources_dir(base, name)?;
    for entry in fs::read_dir(&dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?.flatten() {
        if entry.file_name().to_string_lossy().ends_with(".new.zip") {
            let _ = fs::remove_file(entry.path());
        }
    }
    Ok(())
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

/// Swap a finished refresh into place. Every file of the new index is flushed to
/// disk first. The old index is moved aside and only removed once the new one
/// is in; if anything fails the old one is put back exactly as it was.
pub fn ds_commit(base: &Path, name: &str, meta: &str) -> Result<(), String> {
    check_ds(name)?;
    let root = ds_root(base);
    let live = root.join(name);
    let building = root.join(format!("{}.building", name));
    let previous = root.join(format!("{}.previous", name));
    if !building.is_dir() {
        return Err("no refresh is in progress for this dataset".into());
    }
    let shards: Vec<PathBuf> = fs::read_dir(&building)
        .map_err(|e| format!("cannot read the new index: {e}"))?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".ndjson"))
        .map(|e| e.path())
        .collect();
    if shards.is_empty() {
        return Err("the new index is empty; the existing index was left in place".into());
    }
    if meta.trim().is_empty() || serde_json::from_str::<serde_json::Value>(meta).is_err() {
        return Err("the new index has no readable description; the existing index was left in place".into());
    }
    for shard in &shards {
        let f = fs::OpenOptions::new()
            .write(true)
            .open(shard)
            .map_err(|e| format!("cannot reopen {}: {e}", shard.display()))?;
        f.sync_all().map_err(|e| format!("cannot flush {} to disk: {e}", shard.display()))?;
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

/// If the program stopped in the middle of a swap, finish or undo it so the
/// shop always starts with one whole index.
pub fn ds_recover(base: &Path, name: &str) -> Result<(), String> {
    check_ds(name)?;
    let root = ds_root(base);
    let live = root.join(name);
    let previous = root.join(format!("{}.previous", name));
    if previous.exists() {
        if live.join("meta.json").is_file() {
            fs::remove_dir_all(&previous).map_err(|e| format!("cannot tidy an old copy: {e}"))?;
        } else {
            if live.exists() {
                fs::remove_dir_all(&live).map_err(|e| format!("cannot tidy a half-placed index: {e}"))?;
            }
            fs::rename(&previous, &live).map_err(|e| format!("cannot restore the previous index: {e}"))?;
        }
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

/// Record how the last check or update went. Written to a temporary file,
/// flushed and renamed, so it is never half written.
pub fn ds_status_write(base: &Path, name: &str, json: &str) -> Result<(), String> {
    check_ds(name)?;
    if serde_json::from_str::<serde_json::Value>(json).is_err() {
        return Err("status is not valid JSON".into());
    }
    let root = ds_root(base);
    fs::create_dir_all(&root).map_err(|e| format!("cannot create {}: {e}", root.display()))?;
    let tmp = root.join(format!("{}.status.tmp", name));
    let dest = root.join(format!("{}.status.json", name));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("cannot write status: {e}"))?;
        f.write_all(json.as_bytes()).map_err(|e| format!("cannot write status: {e}"))?;
        f.sync_all().map_err(|e| format!("cannot flush status: {e}"))?;
    }
    fs::rename(&tmp, &dest).map_err(|e| format!("cannot keep status: {e}"))
}

pub fn ds_status_read(base: &Path, name: &str) -> Result<Option<String>, String> {
    check_ds(name)?;
    let p = ds_root(base).join(format!("{}.status.json", name));
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
        assert_eq!(b64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn motor_signature_matches_the_handbook_example() {
        // MOTOR DaaS Development Handbook, "Example API Key Credentials":
        // public L6yPPubKey, private 90PoIbjdUdhY9Hmfrin7JoEVo, epoch 1429200721,
        // GET /v1/Information/YMME/Years?min=1990, and the header it prints.
        let data = motor_signature_data("L6yPPubKey", "GET", 1429200721, "/v1/Information/YMME/Years");
        assert_eq!(data, "L6yPPubKey\nGET\n1429200721\n/v1/Information/YMME/Years");
        assert_eq!(
            motor_authorization("L6yPPubKey", "90PoIbjdUdhY9Hmfrin7JoEVo", "GET", 1429200721, "/v1/Information/YMME/Years"),
            "Shared L6yPPubKey:q+FhRKNYtWNCsUiip9e92yPw73zEIfm4ZETGOh+olRs="
        );
        assert_eq!(http_date(1429200721), "Thu, 16 Apr 2015 16:12:01 GMT");
    }

    #[test]
    fn http_dates_are_rfc_1123() {
        assert_eq!(http_date(0), "Thu, 01 Jan 1970 00:00:00 GMT");
        assert_eq!(http_date(951782400), "Tue, 29 Feb 2000 00:00:00 GMT");
        assert_eq!(http_date(1789257600), "Sun, 13 Sep 2026 00:00:00 GMT");
        assert_eq!(http_date(4102444799), "Thu, 31 Dec 2099 23:59:59 GMT");
    }

    #[test]
    fn the_signed_path_is_the_path_sent_without_its_query() {
        assert_eq!(uri_path("https://api.motor.com/v1/Information/YMME/Years?min=1990").as_deref(), Some("/v1/Information/YMME/Years"));
        assert_eq!(uri_path("https://api.motor.com/v1/Information/Vehicles/Search/ByVIN?VIN=1HGCM").as_deref(), Some("/v1/Information/Vehicles/Search/ByVIN"));
        assert_eq!(uri_path("https://api.motor.com:443/v1/HelloWorld#x").as_deref(), Some("/v1/HelloWorld"));
        assert_eq!(uri_path("https://api.motor.com").as_deref(), Some("/"));
        assert_eq!(uri_path("https://api.motor.com?x=1").as_deref(), Some("/"));
        assert_eq!(uri_path("http://api.motor.com/v1"), None);
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
                println!("CREDMAN: stored, read back on the native side, deleted, confirmed gone (Windows Credential Manager)");
            }
            Err(e) => println!("CREDMAN: credential store unavailable on this machine, round trip skipped: {e}"),
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
                _ => None,
            })
        };
        let (s, used) = expand_template("Bearer {{secret:apiKey}}", &mut lookup).unwrap();
        assert_eq!(s, "Bearer KEY123");
        assert!(used);
        let (s, used) = expand_template("no secrets here", &mut lookup).unwrap();
        assert_eq!(s, "no secrets here");
        assert!(!used);
        let missing = expand_template("{{secret:nope}}", &mut lookup).unwrap_err();
        assert!(missing.starts_with("MISSING_CREDENTIAL:nope"), "{missing}");
        assert!(expand_template("{{secret:../x}}", &mut lookup).is_err());
        assert!(expand_template("{{file:C:/x}}", &mut lookup).is_err());
        assert!(expand_template("{{secret:apiKey", &mut lookup).is_err());
        // the page cannot ask for a signature over text of its choosing
        assert!(expand_template("{{hmac_sha256_b64:apiKey:anything}}", &mut lookup).is_err());
        assert!(expand_template("{{hmac_sha256_b64url:apiKey:anything}}", &mut lookup).is_err());

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

    fn motor_keys(f: &str) -> Result<Option<String>, String> {
        Ok(match f {
            "publicKey" => Some("PUB".to_string()),
            "privateKey" => Some("k".to_string()),
            _ => None,
        })
    }

    fn spec(url: &str) -> ProviderSpec {
        ProviderSpec {
            method: "GET".into(),
            url: url.into(),
            headers: vec![("Accept".into(), "application/json".into())],
            body: None,
            timeout_secs: 20,
            auth: Some("motor_shared".into()),
        }
    }

    #[test]
    fn a_motor_request_is_signed_here_exactly_as_documented() {
        let mut lookup = motor_keys;
        let mut sess = |_: &str| None;
        let req = prepare_provider_request(
            "motor_daas",
            &spec("https://api.motor.com/v1/HelloWorld?xcorrelationid=abc"),
            &mut lookup,
            &mut sess,
            1_700_000_000,
            1_000,
        )
        .unwrap();
        let h = |n: &str| req.headers.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
        // HMAC-SHA256("k", "PUB\nGET\n1700000000\n/v1/HelloWorld"), from Python's hmac module
        assert_eq!(h("Authorization").as_deref(), Some("Shared PUB:hBAMu1TNSNkbyc5IZpjoAU1ht6goLDwwxomk4zuOlTM="));
        assert_eq!(h("X-Date").as_deref(), Some(http_date(1_700_000_000).as_str()));
        assert_eq!(h("Accept").as_deref(), Some("application/json"));
        assert!(!req.follow_redirects, "a signed request never follows a redirect");
        assert_eq!(req.url, "https://api.motor.com/v1/HelloWorld?xcorrelationid=abc");
        let cfg = curl_config(&req, Path::new("o"), None).unwrap();
        assert!(!cfg.contains("location"));
    }

    #[test]
    fn a_provider_request_cannot_be_turned_into_a_proxy() {
        let mut lookup = motor_keys;
        let mut sess = |_: &str| None;
        let mut go = |provider: &str, s: ProviderSpec| prepare_provider_request(provider, &s, &mut lookup, &mut sess, 1, 1_000);
        // unrelated host, look-alike hosts, other schemes, malformed addresses
        for bad in [
            "https://evil.example/v1/HelloWorld",
            "https://api.motor.com.evil.example/v1/HelloWorld",
            "https://api.motor.com@evil.example/v1/HelloWorld",
            "http://api.motor.com/v1/HelloWorld",
            "https://api motor.com/v1",
            "api.motor.com/v1/HelloWorld",
            "https:///v1/HelloWorld",
        ] {
            assert!(go("motor_daas", spec(bad)).is_err(), "{bad} must be refused");
        }
        // a provider with no API hosts (a portal) cannot send anything
        assert!(go("alldata", spec("https://my.alldata.com/")).is_err());
        // MOTOR's keys never go to another provider's host, and vice versa
        assert!(go("tecrmi", spec("https://api.motor.com/v1/HelloWorld")).is_err());
        // only MOTOR has the Shared signing scheme
        let mut s = spec("https://rmi-services.tecalliance.net/rest/Times/WorkList");
        assert!(go("tecrmi", s.clone()).is_err());
        s.auth = None;
        assert!(go("tecrmi", s).is_ok());
        let mut s = spec("https://api.motor.com/v1/HelloWorld");
        s.auth = Some("mws".into());
        assert!(go("motor_daas", s).is_err(), "the retired MWS scheme is not offered");
        // the page cannot supply the headers the signing step owns
        for name in ["Authorization", "X-Date", "date"] {
            let mut s = spec("https://api.motor.com/v1/HelloWorld");
            s.headers.push((name.into(), "Shared PUB:forged".into()));
            assert!(go("motor_daas", s).is_err(), "{name} must be refused");
        }
    }

    #[test]
    fn missing_motor_keys_are_reported_by_name() {
        let mut none = |_: &str| -> Result<Option<String>, String> { Ok(None) };
        let mut sess = |_: &str| None;
        let e = prepare_provider_request("motor_daas", &spec("https://api.motor.com/v1/HelloWorld"), &mut none, &mut sess, 1, 1)
            .unwrap_err();
        assert!(e.starts_with("MISSING_CREDENTIAL:publicKey"), "{e}");
        let mut only_public = |f: &str| -> Result<Option<String>, String> { Ok(if f == "publicKey" { Some("P".into()) } else { None }) };
        let e = prepare_provider_request("motor_daas", &spec("https://api.motor.com/v1/HelloWorld"), &mut only_public, &mut sess, 1, 1)
            .unwrap_err();
        assert!(e.starts_with("MISSING_CREDENTIAL:privateKey"), "{e}");
    }

    #[test]
    fn a_redirect_to_another_host_is_refused_not_followed() {
        let dump = "HTTP/1.1 302 Found\r\nLocation: https://evil.example/collect\r\n\r\n";
        let e = redirect_refusal(302, dump).unwrap();
        assert!(e.starts_with("REDIRECT_REFUSED"), "{e}");
        assert!(e.contains("evil.example"), "{e}");
        assert!(redirect_refusal(200, "HTTP/1.1 200 OK\r\n\r\n").is_none());
        assert!(redirect_refusal(401, "HTTP/1.1 401 Unauthorized\r\n\r\n").is_none());
    }

    /// A real call to MOTOR's public DaaS sandbox, through the same code the
    /// desktop app uses. It runs only when the sandbox keys MOTOR publishes at
    /// motor.com/daas-sandbox are supplied as MOTOR_SANDBOX_PUBLIC and
    /// MOTOR_SANDBOX_PRIVATE; they are never stored in this repository.
    ///   cargo test motor_sandbox_live -- --ignored --nocapture
    #[test]
    #[ignore]
    fn motor_sandbox_live() {
        let (Ok(public), Ok(private)) = (std::env::var("MOTOR_SANDBOX_PUBLIC"), std::env::var("MOTOR_SANDBOX_PRIVATE")) else {
            panic!("MOTOR_SANDBOX_PUBLIC and MOTOR_SANDBOX_PRIVATE are not set");
        };
        let scratch = scratch("motorlive");
        let call = |path: &str, private_key: &str| -> (u16, serde_json::Value) {
            let mut lookup = |f: &str| -> Result<Option<String>, String> {
                Ok(match f {
                    "publicKey" => Some(public.clone()),
                    "privateKey" => Some(private_key.to_string()),
                    _ => None,
                })
            };
            let mut sess = |_: &str| None;
            let req = prepare_provider_request(
                "motor_daas",
                &spec(&format!("https://api.motor.com/v1{path}")),
                &mut lookup,
                &mut sess,
                now_epoch(),
                25_000_000,
            )
            .unwrap();
            let out = scratch.join(format!("r{}.json", crate::next_seq()));
            let status = run_request(&req, &out, &scratch).expect("MOTOR sandbox answered");
            let body = fs::read_to_string(&out).unwrap_or_default();
            (status, serde_json::from_str(&body).unwrap_or(serde_json::Value::Null))
        };
        let code = |v: &serde_json::Value| v["Header"]["Messages"][0]["Code"].as_str().unwrap_or("").to_string();

        let (st, v) = call("/HelloWorld", &private);
        println!("LIVE: HelloWorld -> {st} {}", v["Body"]);
        assert_eq!(st, 200, "authentication with the published sandbox keys: {v}");

        let (st, v) = call("/Information/Vehicles/Search/ByVIN?VIN=19XFA1F57AE000001", &private);
        let veh = &v["Body"]["Vehicles"][0];
        println!(
            "LIVE: ByVIN -> {st} {} {} {} {} BaseVehicleID={} EngineID={}",
            veh["Year"], veh["MakeName"], veh["ModelName"], veh["SubModelName"], veh["BaseVehicleID"], veh["EngineID"]
        );
        assert_eq!(st, 200, "{v}");
        let base_vehicle = veh["BaseVehicleID"].as_i64().expect("a base vehicle id");

        let (st, v) = call(
            &format!("/Information/Vehicles/Attributes/BaseVehicleID/{base_vehicle}/Content/Summaries/Of/EstimatedWorkTimes?SearchTerm=brake"),
            &private,
        );
        let apps = v["Body"]["Applications"].as_array().cloned().unwrap_or_default();
        let first = apps.first().cloned().unwrap_or(serde_json::Value::Null);
        println!(
            "LIVE: EstimatedWorkTimes -> {st} {} operations; first: {} {} h (ApplicationID {})",
            apps.len(),
            first["DisplayName"],
            first["Items"][0]["BaseLaborTime"],
            first["ApplicationID"]
        );
        assert_eq!(st, 200, "{v}");
        assert!(!apps.is_empty(), "the sandbox returned labor operations");

        let (st, v) = call("/HelloWorld", "not-the-private-key");
        println!("LIVE: wrong private key -> {st} {}", code(&v));
        assert_eq!(st, 401);
        assert!(code(&v).starts_with("401."), "MOTOR's own error code is available: {v}");
        fs::remove_dir_all(&scratch).ok();
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
        let mut head = req.clone();
        head.method = "HEAD".into();
        let cfg = curl_config(&head, Path::new("o"), None).unwrap();
        assert!(cfg.contains("\nhead\n") && !cfg.contains("request ="));
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

    fn tiny_zip() -> Vec<u8> {
        // a stored (uncompressed) archive holding one empty file named "a"
        let mut z = vec![];
        z.extend_from_slice(&[0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, b'a']);
        let cd = z.len() as u32;
        z.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, b'a']);
        let cd_len = z.len() as u32 - cd;
        z.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 1, 0, 1, 0]);
        z.extend_from_slice(&cd_len.to_le_bytes());
        z.extend_from_slice(&cd.to_le_bytes());
        z.extend_from_slice(&[0, 0]);
        z
    }

    #[test]
    fn only_a_whole_zip_download_is_kept() {
        let base = scratch("zip");
        let good = base.join("good.part");
        fs::write(&good, tiny_zip()).unwrap();
        assert!(zip_is_complete(&good).is_ok());
        let cut_short = base.join("short.part");
        let z = tiny_zip();
        fs::write(&cut_short, &z[..z.len() - 5]).unwrap();
        assert!(zip_is_complete(&cut_short).unwrap_err().contains("incomplete"));
        let html = base.join("html.part");
        fs::write(&html, b"<html>Service Unavailable</html> padding padding").unwrap();
        assert!(zip_is_complete(&html).unwrap_err().contains("not a ZIP"));
        assert!(ds_stage_source(&base, "inv", "FLAT_INV", &html).is_err());
        assert!(ds_source_for_reading(&base, "inv", "FLAT_INV").unwrap().is_none());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_new_download_is_adopted_only_after_the_index_is_committed() {
        let base = scratch("sources");
        // the file the working index was built from
        let first = base.join("1.part");
        fs::write(&first, tiny_zip()).unwrap();
        ds_stage_source(&base, "mc", "TSBS_2025", &first).unwrap();
        ds_adopt_sources(&base, "mc", &["TSBS_2025".to_string()]).unwrap();
        let kept = ds_source_path(&base, "mc", "TSBS_2025", false).unwrap();
        assert!(kept.is_file());
        assert_eq!(ds_source_for_reading(&base, "mc", "TSBS_2025").unwrap().unwrap(), kept);

        // a newer download that then fails to index is thrown away
        let mut newer = tiny_zip();
        newer.extend_from_slice(b"");
        let second = base.join("2.part");
        fs::write(&second, &newer).unwrap();
        ds_stage_source(&base, "mc", "TSBS_2025", &second).unwrap();
        let fresh = ds_source_path(&base, "mc", "TSBS_2025", true).unwrap();
        assert_eq!(ds_source_for_reading(&base, "mc", "TSBS_2025").unwrap().unwrap(), fresh);
        ds_discard_fresh_sources(&base, "mc").unwrap();
        assert!(!fresh.exists());
        assert!(kept.is_file(), "the file behind the working index is untouched");

        // a successful one replaces it, and files no longer used are removed
        let third = base.join("3.part");
        fs::write(&third, tiny_zip()).unwrap();
        ds_stage_source(&base, "mc", "TSBS_2025", &third).unwrap();
        let old = base.join("4.part");
        fs::write(&old, tiny_zip()).unwrap();
        ds_stage_source(&base, "mc", "TSBS_1995", &old).unwrap();
        ds_adopt_sources(&base, "mc", &["TSBS_2025".to_string()]).unwrap();
        assert!(kept.is_file() && !fresh.exists());
        assert!(!ds_source_path(&base, "mc", "TSBS_1995", false).unwrap().exists());
        assert!(!ds_source_path(&base, "mc", "TSBS_1995", true).unwrap().exists());
        assert!(ds_source_path(&base, "mc", "../x", false).is_err());
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn a_swap_interrupted_part_way_is_put_right_on_start() {
        let base = scratch("recover");
        ds_begin(&base, "inv").unwrap();
        ds_write(&base, "inv", "BMW", "good\n", false).unwrap();
        ds_commit(&base, "inv", "{\"records\":1}").unwrap();
        // simulate a stop between "move current aside" and "move new in"
        let root = ds_root(&base);
        fs::rename(root.join("inv"), root.join("inv.previous")).unwrap();
        ds_recover(&base, "inv").unwrap();
        assert_eq!(ds_read(&base, "inv", "BMW").unwrap().unwrap(), "good\n");
        assert!(!root.join("inv.previous").exists());
        // and a stop after the new index was placed simply removes the old copy
        fs::create_dir_all(root.join("inv.previous")).unwrap();
        ds_recover(&base, "inv").unwrap();
        assert!(!root.join("inv.previous").exists());
        assert_eq!(ds_meta(&base, "inv").unwrap().unwrap(), "{\"records\":1}");
        fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn update_status_survives_a_failed_update_and_is_never_half_written() {
        let base = scratch("status");
        assert_eq!(ds_status_read(&base, "inv").unwrap(), None);
        ds_status_write(&base, "inv", "{\"lastSuccessAt\":\"2026-09-12T10:00:00Z\"}").unwrap();
        ds_status_write(&base, "inv", "{\"lastSuccessAt\":\"2026-09-12T10:00:00Z\",\"lastFailure\":{\"error\":\"HTTP 503\"}}").unwrap();
        assert!(ds_status_read(&base, "inv").unwrap().unwrap().contains("HTTP 503"));
        assert!(ds_status_write(&base, "inv", "not json").is_err());
        assert!(ds_status_read(&base, "inv").unwrap().unwrap().contains("lastSuccessAt"));
        assert!(!ds_root(&base).join("inv.status.tmp").exists());
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
