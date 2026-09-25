//! The hub's own certificates, and Windows serving TLS with them.

use shophub::secrets::FileSecrets;
use shophub::tls;
use std::net::IpAddr;

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("shophub-tls-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn the_authority_is_made_once_and_read_back() {
    let d = tmp("ca");
    let secrets = FileSecrets::new(d.join("secrets.json"));
    let a = tls::authority(&secrets, &d, "Joe's Garage & Tire").unwrap();
    let b = tls::authority(&secrets, &d, "Joe's Garage & Tire").unwrap();
    assert_eq!(a.cert_der, b.cert_der, "the same authority comes back");
    assert!(d.join("ca.cer").exists());
    // the key is not in the certificate file
    let pem = tls::pem(&a.cert_der);
    assert!(pem.starts_with("-----BEGIN CERTIFICATE-----\n"));
}

#[test]
fn a_server_certificate_for_the_current_addresses() {
    let d = tmp("leaf");
    let secrets = FileSecrets::new(d.join("secrets.json"));
    let ca = tls::authority(&secrets, &d, "Shop").unwrap();
    let ips: Vec<IpAddr> = vec!["192.168.1.20".parse().unwrap(), "127.0.0.1".parse().unwrap()];
    let id = tls::server_identity(&ca, &ips).unwrap();
    assert!(!id.cert_der.is_empty() && !id.pfx.is_empty());
}

#[cfg(windows)]
#[test]
fn windows_serves_tls_with_it() {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    let d = tmp("win");
    let secrets = FileSecrets::new(d.join("secrets.json"));
    let ca = tls::authority(&secrets, &d, "Shop").unwrap();
    let acceptor = tls::win::Acceptor::persistent(&ca, &["127.0.0.1".parse().unwrap()], &d).unwrap();
    let l = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = l.local_addr().unwrap().port();
    let server = std::thread::spawn(move || {
        let (s, _) = l.accept().unwrap();
        let mut t = acceptor.accept(s).unwrap();
        let mut buf = [0u8; 5];
        t.read_exact(&mut buf).unwrap();
        t.write_all(b"hello back").unwrap();
        t.flush().unwrap();
        buf
    });
    // a client that trusts only the shop's authority
    let mut store = schannel::cert_store::Memory::new().unwrap();
    store.add_encoded_certificate(&ca.cert_der).unwrap();
    let store = store.into_store();
    let cred = schannel::schannel_cred::SchannelCred::builder().acquire(schannel::schannel_cred::Direction::Outbound).unwrap();
    let tcp = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut c = schannel::tls_stream::Builder::new()
        .domain("127.0.0.1")
        .cert_store(store)
        .connect(cred, tcp)
        .unwrap_or_else(|e| panic!("client handshake: {:?}", match e { schannel::tls_stream::HandshakeError::Failure(e) => e.to_string(), _ => "interrupted".into() }));
    c.write_all(b"hello").unwrap();
    let mut back = [0u8; 10];
    c.read_exact(&mut back).unwrap();
    assert_eq!(&back, b"hello back");
    assert_eq!(&server.join().unwrap(), b"hello");
    tls::win::Acceptor::forget(&d);
}

#[cfg(windows)]
#[test]
fn the_same_certificate_is_used_again_while_it_fits() {
    let d = tmp("keep");
    let secrets = FileSecrets::new(d.join("secrets.json"));
    let ca = tls::authority(&secrets, &d, "Shop").unwrap();
    let a: Vec<IpAddr> = vec!["127.0.0.1".parse().unwrap()];
    let _x = tls::win::Acceptor::persistent(&ca, &a, &d).unwrap();
    let first = std::fs::read_to_string(d.join("hub-cert.json")).unwrap();
    let _y = tls::win::Acceptor::persistent(&ca, &a, &d).unwrap();
    assert_eq!(first, std::fs::read_to_string(d.join("hub-cert.json")).unwrap(), "the same certificate");
    // a new address makes a new one, and the old one leaves the store
    let b: Vec<IpAddr> = vec!["127.0.0.1".parse().unwrap(), "10.9.8.7".parse().unwrap()];
    let _z = tls::win::Acceptor::persistent(&ca, &b, &d).unwrap();
    let second = std::fs::read_to_string(d.join("hub-cert.json")).unwrap();
    assert_ne!(first, second);
    let my = schannel::cert_store::CertStore::open_current_user("My").unwrap();
    let old: serde_json::Value = serde_json::from_str(&first).unwrap();
    let old_der = shophub::crypto::unb64(old["der"].as_str().unwrap()).unwrap();
    assert!(!my.certs().any(|c| c.to_der() == &old_der[..]), "the replaced certificate is gone");
    tls::win::Acceptor::forget(&d);
    let my = schannel::cert_store::CertStore::open_current_user("My").unwrap();
    let new: serde_json::Value = serde_json::from_str(&second).unwrap();
    let new_der = shophub::crypto::unb64(new["der"].as_str().unwrap()).unwrap();
    assert!(!my.certs().any(|c| c.to_der() == &new_der[..]), "forget takes it out");
}
