//! HTTPS for a phone on the shop's Wi-Fi.
//!
//! A phone's browser only keeps a web app for use with no signal when the app
//! came over HTTPS. There is no public name for a computer on a shop's Wi-Fi,
//! so the hub is its own certificate authority:
//!
//! * The shop's authority is made once. Its private key lives in the same
//!   secret store as the device secrets (Windows Credential Manager in the
//!   installed program), never in a file. Its certificate is limited by name
//!   constraints to private network addresses, so even a stolen key could not
//!   vouch for a real website.
//! * The phone installs the authority's certificate once (Settings shows it as
//!   a profile) and trusts it.
//! * Each time the hub starts, it issues itself a fresh certificate for the
//!   addresses it has at that moment, valid 397 days (the most Apple accepts),
//!   and keeps it only in memory.
//!
//! The certificates are made with RustCrypto (p256, x509-cert). The TLS itself
//! is Windows' own (SChannel), through the `schannel` bindings.

use crate::secrets::SecretStore;
use crate::util;
use der::asn1::{Ia5String, OctetString};
use der::{Decode, Encode};
use p256::ecdsa::{DerSignature, SigningKey};
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use std::net::IpAddr;
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;
use x509_cert::builder::{Builder, CertificateBuilder, Profile};
use x509_cert::ext::pkix::constraints::name::{GeneralSubtree, NameConstraints};
use x509_cert::ext::pkix::name::GeneralName;
use x509_cert::ext::pkix::{ExtendedKeyUsage, SubjectAltName};
use x509_cert::name::Name;
use x509_cert::serial_number::SerialNumber;
use x509_cert::spki::SubjectPublicKeyInfoOwned;
use x509_cert::time::Validity;
use x509_cert::Certificate;

const CA_SECRET: &str = "tls/ca-key";
pub const PFX_PASSWORD: &str = "jzd-shophub";
/// The id-kp-serverAuth purpose.
const SERVER_AUTH: der::oid::ObjectIdentifier = der::oid::ObjectIdentifier::new_unwrap("1.3.6.1.5.5.7.3.1");

fn e<E: std::fmt::Display>(x: E) -> String {
    x.to_string()
}

fn serial() -> Result<SerialNumber, String> {
    let mut b = util::rand_bytes(16);
    b[0] &= 0x7f; // positive
    b[0] |= 0x01; // and not starting with a zero byte
    SerialNumber::new(&b).map_err(e)
}

/// Only letters, digits, spaces and a few marks make it into a certificate name.
fn clean(s: &str) -> String {
    let c: String = s.chars().filter(|c| c.is_ascii_alphanumeric() || " .-_".contains(*c)).take(40).collect();
    let c = c.trim().to_string();
    if c.is_empty() { "Shop".into() } else { c }
}

/// The private address ranges the shop's authority may vouch for.
fn private_subtrees() -> Vec<GeneralSubtree> {
    let v4 = |a: [u8; 4], m: [u8; 4]| {
        let mut b = a.to_vec();
        b.extend_from_slice(&m);
        GeneralSubtree { base: GeneralName::IpAddress(OctetString::new(b).expect("8 bytes")), minimum: 0, maximum: None }
    };
    vec![
        v4([10, 0, 0, 0], [255, 0, 0, 0]),
        v4([172, 16, 0, 0], [255, 240, 0, 0]),
        v4([192, 168, 0, 0], [255, 255, 0, 0]),
        v4([127, 0, 0, 0], [255, 0, 0, 0]),
        v4([169, 254, 0, 0], [255, 255, 0, 0]),
    ]
}

pub struct Authority {
    pub cert_der: Vec<u8>,
    key: SigningKey,
    name: Name,
}

/// The shop's certificate authority: made the first time, then read back.
pub fn authority(secrets: &dyn SecretStore, dir: &Path, shop_name: &str) -> Result<Authority, String> {
    let cert_path = dir.join("ca.cer");
    if let (Ok(Some(key)), Ok(cert_der)) = (secrets.get(CA_SECRET), std::fs::read(&cert_path)) {
        let key = SigningKey::from_pkcs8_der(&key).map_err(|x| format!("the shop's certificate key could not be read: {x}"))?;
        let cert = Certificate::from_der(&cert_der).map_err(e)?;
        let same = cert.tbs_certificate.subject_public_key_info == SubjectPublicKeyInfoOwned::from_key(*key.verifying_key()).map_err(e)?;
        if same {
            return Ok(Authority { cert_der, key, name: cert.tbs_certificate.subject });
        }
    }
    // a new authority
    let key = SigningKey::random(&mut rand_core::OsRng);
    let name = Name::from_str(&format!("CN=JZD Shop Hub - {},O=JZD Shop Manager", clean(shop_name))).map_err(e)?;
    let spki = SubjectPublicKeyInfoOwned::from_key(*key.verifying_key()).map_err(e)?;
    let validity = Validity::from_now(Duration::from_secs(10 * 365 * 24 * 3600)).map_err(e)?;
    let mut b = CertificateBuilder::new(Profile::Root, serial()?, validity, name.clone(), spki, &key).map_err(e)?;
    b.add_extension(&NameConstraints { permitted_subtrees: Some(private_subtrees()), excluded_subtrees: None }).map_err(e)?;
    let cert = b.build::<DerSignature>().map_err(e)?;
    let cert_der = cert.to_der().map_err(e)?;
    let key_der = key.to_pkcs8_der().map_err(e)?;
    secrets.put(CA_SECRET, key_der.as_bytes())?;
    std::fs::create_dir_all(dir).map_err(e)?;
    let tmp = cert_path.with_extension("writing");
    std::fs::write(&tmp, &cert_der).map_err(e)?;
    std::fs::rename(&tmp, &cert_path).map_err(e)?;
    Ok(Authority { cert_der, key, name })
}

pub struct ServerIdentity {
    pub cert_der: Vec<u8>,
    /// Seconds since 1970 when it stops being valid.
    pub not_after: u64,
    /// The certificate and its key as PKCS#12, for Windows to load.
    pub pfx: Vec<u8>,
}

/// A certificate for this hub's current addresses, signed by the shop's
/// authority. Its key exists only in this process.
pub fn server_identity(ca: &Authority, ips: &[IpAddr]) -> Result<ServerIdentity, String> {
    let key = SigningKey::random(&mut rand_core::OsRng);
    let spki = SubjectPublicKeyInfoOwned::from_key(*key.verifying_key()).map_err(e)?;
    let first = ips.first().map(|i| i.to_string()).unwrap_or_else(|| "127.0.0.1".into());
    let subject = Name::from_str(&format!("CN={first},O=JZD Shop Manager")).map_err(e)?;
    let validity = Validity::from_now(Duration::from_secs(397 * 24 * 3600)).map_err(e)?;
    let not_after = validity.not_after.to_unix_duration().as_secs();
    let profile = Profile::Leaf { issuer: ca.name.clone(), enable_key_agreement: false, enable_key_encipherment: false };
    let mut b = CertificateBuilder::new(profile, serial()?, validity, subject, spki, &ca.key).map_err(e)?;
    let mut names: Vec<GeneralName> = ips
        .iter()
        .map(|ip| {
            let bytes = match ip {
                IpAddr::V4(v) => v.octets().to_vec(),
                IpAddr::V6(v) => v.octets().to_vec(),
            };
            GeneralName::IpAddress(OctetString::new(bytes).expect("an address"))
        })
        .collect();
    names.push(GeneralName::DnsName(Ia5String::new("localhost").map_err(e)?));
    b.add_extension(&SubjectAltName(names)).map_err(e)?;
    b.add_extension(&ExtendedKeyUsage(vec![SERVER_AUTH])).map_err(e)?;
    let cert = b.build::<DerSignature>().map_err(e)?;
    let cert_der = cert.to_der().map_err(e)?;
    let key_der = key.to_pkcs8_der().map_err(e)?;
    let pfx = p12::PFX::new(&cert_der, key_der.as_bytes(), Some(&ca.cert_der), PFX_PASSWORD, "JZD Shop Hub").ok_or("could not package the hub's certificate")?.to_der();
    Ok(ServerIdentity { cert_der, not_after, pfx })
}

/// The certificate in the text form most tools read.
pub fn pem(der: &[u8]) -> String {
    use base64::Engine;
    let b = base64::engine::general_purpose::STANDARD.encode(der);
    let mut out = String::from("-----BEGIN CERTIFICATE-----\n");
    for chunk in b.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap());
        out.push('\n');
    }
    out.push_str("-----END CERTIFICATE-----\n");
    out
}

// ---------------- Windows: the TLS itself

#[cfg(windows)]
pub mod win {
    use super::{Authority, ServerIdentity};
    use schannel::cert_context::CertContext;
    use schannel::cert_store::{CertAdd, CertStore, PfxImportOptions};
    use serde_json::json;
    use std::net::IpAddr;
    use std::path::Path;
    use schannel::schannel_cred::{Direction, SchannelCred};
    use schannel::tls_stream::{Builder, TlsStream};
    use std::io::{Read, Write};
    use std::net::TcpStream;

    pub struct Acceptor {
        cert: CertContext,
    }

    impl Acceptor {
        /// The hub's certificate, kept in this Windows user's certificate store
        /// with its key, so Windows can use it. Windows' TLS will not use a key
        /// held only in memory, and every import of a new key leaves a key file
        /// behind, so the same certificate is used again at the next start
        /// while it still covers this computer's addresses and has at least 30
        /// days left. `dir` holds a note of which certificate that is.
        pub fn persistent(ca: &Authority, ips: &[IpAddr], dir: &Path) -> Result<Acceptor, String> {
            let note_path = dir.join("hub-cert.json");
            let note: serde_json::Value = std::fs::read(&note_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let ca_sha = crate::flat::sha256_hex(&ca.cert_der);
            let mut my = CertStore::open_current_user("My").map_err(|e| format!("Windows' certificate store: {e}"))?;
            let old_der = note["der"].as_str().and_then(|b| crate::crypto::unb64(b).ok());
            let old = old_der.as_ref().and_then(|der| my.certs().find(|c| c.to_der() == &der[..]));
            let now = crate::util::now_ms() / 1000;
            let covers = ips.iter().all(|ip| note["ips"].as_array().map(|a| a.iter().any(|x| x.as_str() == Some(&ip.to_string()))).unwrap_or(false));
            let fresh = note["notAfter"].as_u64().unwrap_or(0) > now + 30 * 24 * 3600;
            if let Some(c) = &old {
                if covers && fresh && note["ca"].as_str() == Some(&ca_sha) && c.private_key().silent(true).acquire().is_ok() {
                    return Ok(Acceptor { cert: c.clone() });
                }
            }
            let id: ServerIdentity = super::server_identity(ca, ips)?;
            let imported = PfxImportOptions::new().password(super::PFX_PASSWORD).import(&id.pfx).map_err(|e| format!("Windows could not load the hub's certificate: {e}"))?;
            let leaf = imported.certs().find(|c| c.to_der() == &id.cert_der[..]).ok_or("the hub's certificate was not in its package")?;
            let kept = my.add_cert(&leaf, CertAdd::ReplaceExisting).map_err(|e| format!("Windows would not keep the hub's certificate: {e}"))?;
            let _ = kept.set_friendly_name("JZD Shop Hub (this computer)");
            if let Some(c) = old {
                let _ = c.delete();
            }
            let note = json!({"der": crate::crypto::b64(&id.cert_der), "ips": ips.iter().map(|i| i.to_string()).collect::<Vec<_>>(), "notAfter": id.not_after, "ca": ca_sha});
            let tmp = note_path.with_extension("writing");
            std::fs::write(&tmp, note.to_string()).map_err(|e| e.to_string())?;
            std::fs::rename(&tmp, &note_path).map_err(|e| e.to_string())?;
            Ok(Acceptor { cert: kept })
        }

        /// Take the hub's certificate back out of the Windows store.
        pub fn forget(dir: &Path) {
            let note_path = dir.join("hub-cert.json");
            let note: serde_json::Value = std::fs::read(&note_path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            if let (Some(der), Ok(my)) = (note["der"].as_str().and_then(|b| crate::crypto::unb64(b).ok()), CertStore::open_current_user("My")) {
                if let Some(c) = my.certs().find(|c| c.to_der() == &der[..]) {
                    let _ = c.delete();
                }
            }
            let _ = std::fs::remove_file(note_path);
        }

        pub fn accept<S: Read + Write>(&self, stream: S) -> Result<TlsStream<S>, String> {
            let cred = SchannelCred::builder().cert(self.cert.clone()).acquire(Direction::Inbound).map_err(|e| format!("TLS: {e}"))?;
            match Builder::new().accept(cred, stream) {
                Ok(s) => Ok(s),
                Err(schannel::tls_stream::HandshakeError::Failure(e)) => Err(format!("TLS handshake: {e}")),
                Err(schannel::tls_stream::HandshakeError::Interrupted(_)) => Err("TLS handshake: interrupted".into()),
            }
        }
    }

    pub type Stream = TlsStream<TcpStream>;
}
