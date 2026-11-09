//! wisp-grid-client-core: the grid client's rules, sans-IO (v1 server/grid-tunnel.js, services/cloud.js,
//! grid-client.js): the tunnel's redial schedule and what ends it, how a request through the tunnel is
//! made to look local, the device flow's poll interval, a grid's address, and links to shares.

/// Waits between redials of a dropped tunnel: 1, 2, 5, 15, then every 30 s.
pub const RETRY_MS: [u64; 5] = [1_000, 2_000, 5_000, 15_000, 30_000];
/// The grid pings every 25 s: this long without a byte, the tunnel is dead.
pub const IDLE_MS: u64 = 70_000;
/// Hop-by-hop, or not allowed in HTTP/2.
pub const HOP: &[&str] = &["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host", "http2-settings"];
/// What a computer sends in `Upgrade:`.
pub const TUNNEL_PROTOCOL: &str = "wisp-tunnel";
/// The mark on every request that came through the tunnel.
pub const MARK_HEADER: &str = "x-wisp-tunnel";

/// The wait before redial number `attempt` (0 for the first).
pub fn retry_ms(attempt: usize) -> u64 {
    RETRY_MS[attempt.min(RETRY_MS.len() - 1)]
}

/// What the grid's answer to a dial (not upgraded) means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialed {
    /// 101: the tunnel is up
    Up,
    /// 401/404: this device or computer is gone; stop asking
    Gone,
    /// anything else: try again later
    Retry,
}

pub fn dialed(status: u16) -> Dialed {
    match status {
        101 => Dialed::Up,
        401 | 404 => Dialed::Gone,
        _ => Dialed::Retry,
    }
}

/// A request through the tunnel as a page on this computer would make it: hop-by-hop headers dropped,
/// this computer's own Host, no Origin (the grid checked who's asking), and the mark. `x-wisp-preview`
/// and `x-wisp-upgrade` stay for the dialer to read.
pub fn local_headers(from: &[(String, String)], port: u16, mark: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = from.iter().filter(|(k, _)| {
        let k = k.to_ascii_lowercase();
        !k.starts_with(':') && !HOP.contains(&k.as_str()) && k != "origin" && k != MARK_HEADER
    }).cloned().collect();
    out.push(("host".into(), format!("127.0.0.1:{port}")));
    out.push((MARK_HEADER.into(), mark.to_owned()));
    out
}

/// Whether `got` is the mark, compared in constant time.
pub fn is_mark(got: &[u8], mark: &[u8]) -> bool {
    if got.len() != mark.len() {
        return false;
    }
    got.iter().zip(mark).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0
}

/// A preview's port (`x-wisp-preview: 5173`); None when it isn't one or isn't a port.
pub fn preview_port(v: Option<&str>) -> Option<u16> {
    v?.trim().parse::<u16>().ok().filter(|p| *p > 0)
}

/// The device flow's next poll, after the grid's answer (`slow_down` adds 5 s, RFC 8628 §3.5).
pub fn next_interval(interval_s: u64, error: &str) -> u64 {
    if error == "slow_down" { interval_s + 5 } else { interval_s.max(1) }
}

/// A grid's address as typed (`grid.trywisp.dev`, `http://wisp.localhost:8080/`) → its origin, no slash.
pub fn grid_url(raw: &str) -> Option<String> {
    let t = raw.trim().trim_end_matches('/');
    if t.is_empty() || t.contains(char::is_whitespace) {
        return None;
    }
    let with = if t.starts_with("http://") || t.starts_with("https://") { t.to_owned() } else if t.ends_with(".localhost") || t.contains(".localhost:") || t.starts_with("localhost") || t.starts_with("127.0.0.1") { format!("http://{t}") } else { format!("https://{t}") };
    let rest = with.split_once("://").map(|(_, r)| r)?;
    let host = rest.split('/').next().unwrap_or_default();
    (!host.is_empty()).then(|| with[..with.len() - rest.len() + host.len()].to_owned())
}

/// Which share a link names.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    /// `<grid>/s/<id>[?ref=v2]`, or a bare id
    Id { grid: Option<String>, id: String, version: Option<String> },
    /// `grid://<handle>/<name>[?ref=v2]`
    Name { handle: String, name: String, version: Option<String> },
}

fn split_ref(s: &str) -> (&str, Option<String>) {
    match s.split_once("?ref=") {
        Some((a, r)) => (a, Some(r.to_owned()).filter(|r| !r.is_empty())),
        None => (s, None),
    }
}

/// `https://grid.trywisp.dev/s/AbC…`, `grid://ada/review?ref=v1`, `wisp://open/AbC…` or an id.
pub fn link(raw: &str) -> Option<Link> {
    let raw = raw.trim();
    if let Some(rest) = raw.strip_prefix("grid://") {
        let (path, version) = split_ref(rest);
        let (handle, name) = path.trim_end_matches('/').split_once('/')?;
        return (!handle.is_empty() && !name.is_empty() && !name.contains('/')).then(|| Link::Name { handle: handle.into(), name: name.into(), version });
    }
    if let Some(id) = raw.strip_prefix("wisp://open/") {
        let (id, version) = split_ref(id);
        return Some(Link::Id { grid: None, id: id.into(), version });
    }
    if let Some((origin, rest)) = raw.split_once("/s/") {
        let (id, version) = split_ref(rest);
        let id = id.trim_end_matches('/');
        return (!id.is_empty() && !id.contains('/')).then(|| Link::Id { grid: grid_url(origin), id: id.into(), version });
    }
    let (id, version) = split_ref(raw);
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).then(|| Link::Id { grid: None, id: id.into(), version })
}

/// A box's host under the grid's domain (`ada.wisp.localhost:8080` for `http://wisp.localhost:8080`).
pub fn label_host(grid: &str, label: &str) -> Option<String> {
    let rest = grid.split_once("://")?.1;
    Some(format!("{label}.{rest}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tunnel_redials_1_2_5_15_30() {
        let waits: Vec<u64> = (0..7).map(retry_ms).collect();
        assert_eq!(waits, [1_000, 2_000, 5_000, 15_000, 30_000, 30_000, 30_000]);
    }

    #[test]
    fn a_tunnel_401_or_404_is_gone() {
        assert_eq!((dialed(101), dialed(401), dialed(404), dialed(502), dialed(503), dialed(200)), (Dialed::Up, Dialed::Gone, Dialed::Gone, Dialed::Retry, Dialed::Retry, Dialed::Retry));
    }

    #[test]
    fn a_tunnel_request_looks_local() {
        let from = vec![
            (":authority".to_owned(), "studio--ada.wisp.localhost".to_owned()),
            ("host".to_owned(), "studio--ada.wisp.localhost".to_owned()),
            ("connection".to_owned(), "keep-alive".to_owned()),
            ("origin".to_owned(), "https://evil.example".to_owned()),
            ("x-wisp-tunnel".to_owned(), "forged".to_owned()),
            ("accept".to_owned(), "text/event-stream".to_owned()),
        ];
        let out = local_headers(&from, 4477, "m4rk");
        assert_eq!(out, vec![("accept".to_owned(), "text/event-stream".to_owned()), ("host".to_owned(), "127.0.0.1:4477".to_owned()), ("x-wisp-tunnel".to_owned(), "m4rk".to_owned())]);
        assert!(is_mark(b"m4rk", b"m4rk") && !is_mark(b"m4rx", b"m4rk") && !is_mark(b"m4r", b"m4rk") && !is_mark(b"", b"m4rk"));
        assert_eq!((preview_port(Some("5173")), preview_port(Some("0")), preview_port(Some("x")), preview_port(None)), (Some(5173), None, None, None));
    }

    #[test]
    fn device_sign_in_slows_down_by_5_s() {
        assert_eq!((next_interval(5, "authorization_pending"), next_interval(5, "slow_down"), next_interval(0, "")), (5, 10, 1));
    }

    #[test]
    fn grid_addresses_and_links() {
        assert_eq!(grid_url("grid.trywisp.dev").as_deref(), Some("https://grid.trywisp.dev"));
        assert_eq!(grid_url("http://wisp.localhost:8080/").as_deref(), Some("http://wisp.localhost:8080"));
        assert_eq!(grid_url("wisp.localhost:8080").as_deref(), Some("http://wisp.localhost:8080"));
        assert_eq!(grid_url(" "), None);
        assert_eq!(link("http://wisp.localhost:8080/s/AbC_1?ref=v2"), Some(Link::Id { grid: Some("http://wisp.localhost:8080".into()), id: "AbC_1".into(), version: Some("v2".into()) }));
        assert_eq!(link("grid://ada/review?ref=v1"), Some(Link::Name { handle: "ada".into(), name: "review".into(), version: Some("v1".into()) }));
        assert_eq!(link("wisp://open/AbC"), Some(Link::Id { grid: None, id: "AbC".into(), version: None }));
        assert_eq!(link("AbC"), Some(Link::Id { grid: None, id: "AbC".into(), version: None }));
        assert_eq!((link("grid://ada"), link("../x")), (None, None));
        assert_eq!(label_host("http://wisp.localhost:8080", "ada").as_deref(), Some("ada.wisp.localhost:8080"));
    }
}
