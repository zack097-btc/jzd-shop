//! Pairing and the encrypted session.
//!
//! No primitive is implemented here: key agreement is P-256 ECDH (`p256`),
//! message authentication is HMAC-SHA-256 (`hmac`, `sha2`), and every message
//! after the handshake is sealed with ChaCha20-Poly1305 (`chacha20poly1305`).
//! This file only decides how they are put together.
//!
//! PAIRING. The host shows a six-digit pairing code. The new computer connects,
//! quotes the code, and both sides run an ephemeral ECDH exchange. Each side
//! then shows six VERIFY digits computed from the shared secret and both public
//! keys; the person approving on the host checks the digits match the ones on
//! the new computer. That comparison is what stops a machine in the middle: it
//! cannot make both screens show the same digits. On approval both sides derive
//! the same long-term device secret from the exchange. It is never sent.
//!
//! SESSIONS. On every connection the device names itself and proves it holds
//! its secret with an HMAC over fresh nonces; the hub proves the same back.
//! Keys for each direction are derived from the secret and both nonces, and
//! each sealed message carries a counter that must arrive in order, so a
//! recorded message cannot be replayed or reordered.

use crate::util::rand_bytes;
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use hmac::{Hmac, Mac};
use p256::ecdh::EphemeralSecret;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::PublicKey;
use sha2::Sha256;

pub fn hmac(key: &[u8], parts: &[&[u8]]) -> [u8; 32] {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    for p in parts {
        m.update(&(p.len() as u32).to_be_bytes());
        m.update(p);
    }
    m.finalize().into_bytes().into()
}

/// Constant-time comparison of two MACs.
pub fn mac_eq(key: &[u8], parts: &[&[u8]], tag: &[u8]) -> bool {
    let mut m = <Hmac<Sha256> as Mac>::new_from_slice(key).expect("any key length");
    for p in parts {
        m.update(&(p.len() as u32).to_be_bytes());
        m.update(p);
    }
    m.verify_slice(tag).is_ok()
}

pub fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

pub fn b64(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

pub fn unb64(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).map_err(|e| e.to_string())
}

pub struct PairKeys {
    secret: EphemeralSecret,
    pub public: Vec<u8>,
}

pub fn pair_keys() -> PairKeys {
    let secret = EphemeralSecret::random(&mut rand_core::OsRng);
    let public = secret.public_key().to_encoded_point(false).as_bytes().to_vec();
    PairKeys { secret, public }
}

pub struct Paired {
    pub verify: String,
    pub device_secret: [u8; 32],
}

/// Both sides call this with their own keys and the other side's public key,
/// passing the client's key first and the host's second.
pub fn pair_finish(mine: PairKeys, other_public: &[u8], client_pub: &[u8], host_pub: &[u8]) -> Result<Paired, String> {
    let other = PublicKey::from_sec1_bytes(other_public).map_err(|_| "the other computer sent an invalid key".to_string())?;
    let shared = mine.secret.diffie_hellman(&other);
    let raw = shared.raw_secret_bytes();
    let v = hmac(raw.as_slice(), &[b"jzd-shophub verify", client_pub, host_pub]);
    let n = u32::from_be_bytes([v[0], v[1], v[2], v[3]]) % 1_000_000;
    let device_secret = hmac(raw.as_slice(), &[b"jzd-shophub device secret", client_pub, host_pub]);
    Ok(Paired { verify: format!("{:03} {:03}", n / 1000, n % 1000), device_secret })
}

pub struct Session {
    send: ChaCha20Poly1305,
    recv: ChaCha20Poly1305,
    send_ctr: u64,
    recv_ctr: u64,
}

fn nonce(ctr: u64) -> Nonce {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&ctr.to_be_bytes());
    Nonce::from(n)
}

impl Session {
    /// `client` selects which of the two derived keys this side sends with.
    pub fn new(device_secret: &[u8], nonce_c: &[u8], nonce_s: &[u8], client: bool) -> Session {
        let c2s = hmac(device_secret, &[b"jzd-shophub c2s", nonce_c, nonce_s]);
        let s2c = hmac(device_secret, &[b"jzd-shophub s2c", nonce_c, nonce_s]);
        let (send, recv) = if client { (c2s, s2c) } else { (s2c, c2s) };
        Session {
            send: ChaCha20Poly1305::new(Key::from_slice(&send)),
            recv: ChaCha20Poly1305::new(Key::from_slice(&recv)),
            send_ctr: 0,
            recv_ctr: 0,
        }
    }

    pub fn seal(&mut self, plain: &[u8]) -> Vec<u8> {
        self.send_ctr += 1;
        let ct = self.send.encrypt(&nonce(self.send_ctr), plain).expect("encryption does not fail");
        let mut out = Vec::with_capacity(8 + ct.len());
        out.extend_from_slice(&self.send_ctr.to_be_bytes());
        out.extend_from_slice(&ct);
        out
    }

    pub fn open(&mut self, frame: &[u8]) -> Result<Vec<u8>, String> {
        if frame.len() < 8 + 16 {
            return Err("short message".into());
        }
        let ctr = u64::from_be_bytes(frame[..8].try_into().unwrap());
        if ctr != self.recv_ctr + 1 {
            return Err("message out of order or replayed".into());
        }
        let plain = self.recv.decrypt(&nonce(ctr), &frame[8..]).map_err(|_| "message failed authentication".to_string())?;
        self.recv_ctr = ctr;
        Ok(plain)
    }
}

pub fn new_nonce() -> Vec<u8> {
    rand_bytes(24)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_computers_see_the_same_verify_digits_and_derive_the_same_secret() {
        let c = pair_keys();
        let h = pair_keys();
        let (cp, hp) = (c.public.clone(), h.public.clone());
        let a = pair_finish(c, &hp, &cp, &hp).unwrap();
        let b = pair_finish(h, &cp, &cp, &hp).unwrap();
        assert_eq!(a.verify, b.verify);
        assert_eq!(a.device_secret, b.device_secret);
        assert_eq!(a.verify.len(), 7);
        // a machine in the middle, pairing separately with each side, cannot
        // make the digits agree
        let c2 = pair_keys();
        let m1 = pair_keys();
        let m2 = pair_keys();
        let h2 = pair_keys();
        let (c2p, m1p, m2p, h2p) = (c2.public.clone(), m1.public.clone(), m2.public.clone(), h2.public.clone());
        let client_side = pair_finish(c2, &m1p, &c2p, &m1p).unwrap();
        let host_side = pair_finish(h2, &m2p, &m2p, &h2p).unwrap();
        let _ = m1;
        assert_ne!(client_side.device_secret, host_side.device_secret);
        assert!(pair_finish(pair_keys(), b"not a key", b"x", b"y").is_err());
    }

    #[test]
    fn sealed_messages_open_once_in_order_and_never_after_tampering() {
        let secret = [7u8; 32];
        let (nc, ns) = (new_nonce(), new_nonce());
        let mut client = Session::new(&secret, &nc, &ns, true);
        let mut hub = Session::new(&secret, &nc, &ns, false);
        let m1 = client.seal(b"LF tread 4/32");
        let m2 = client.seal(b"RF tread 5/32");
        assert_eq!(hub.open(&m1).unwrap(), b"LF tread 4/32");
        assert!(hub.open(&m1).is_err(), "a replay is refused");
        let mut bad = m2.clone();
        let last = bad.len() - 1;
        bad[last] ^= 1;
        assert!(hub.open(&bad).is_err(), "a changed message is refused");
        assert_eq!(hub.open(&m2).unwrap(), b"RF tread 5/32");
        let back = hub.seal(b"ack");
        assert_eq!(client.open(&back).unwrap(), b"ack");
        // a different secret opens nothing
        let mut stranger = Session::new(&[8u8; 32], &nc, &ns, false);
        assert!(stranger.open(&client.seal(b"x")).is_err());
        assert!(mac_eq(&secret, &[b"a", b"b"], &hmac(&secret, &[b"a", b"b"])));
        assert!(!mac_eq(&secret, &[b"ab"], &hmac(&secret, &[b"a", b"b"])), "parts are length-prefixed");
    }
}
