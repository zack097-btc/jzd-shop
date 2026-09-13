//! Small shared helpers.

pub fn rand_bytes(n: usize) -> Vec<u8> {
    let mut b = vec![0u8; n];
    getrandom::getrandom(&mut b).expect("the operating system's random source is available");
    b
}

pub fn rand_hex(n: usize) -> String {
    rand_bytes(n).iter().map(|b| format!("{b:02x}")).collect()
}

/// Six random decimal digits, as a string.
pub fn rand_digits6() -> String {
    let b = rand_bytes(4);
    let n = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) % 1_000_000;
    format!("{n:06}")
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Addresses the hub will talk to: this computer and the private address
/// ranges a shop's own network uses. Anything else is refused at the door.
pub fn private_peer(ip: &std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        std::net::IpAddr::V6(v6) => {
            if let Some(m) = v6.to_ipv4_mapped() {
                return m.is_loopback() || m.is_private() || m.is_link_local();
            }
            let s = v6.segments();
            v6.is_loopback() || (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xffc0) == 0xfe80
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_local_network_peers_are_accepted() {
        for ok in ["127.0.0.1", "192.168.1.20", "10.0.0.5", "172.16.4.1", "169.254.3.3", "::1", "fd00::1", "fe80::1"] {
            assert!(private_peer(&ok.parse().unwrap()), "{ok}");
        }
        for bad in ["8.8.8.8", "172.32.0.1", "100.64.0.1", "2001:4860::8888", "203.0.113.9"] {
            assert!(!private_peer(&bad.parse().unwrap()), "{bad}");
        }
    }
}
