//! Who may talk to wisp at all (v1 server/index.js's request guard, edge case 1–2). Agents run with broad
//! permissions, so only same-origin local pages may, or a trusted proxy that checked who is asking. An
//! open route (a trigger's secret URL, a webhook) checks its own secret instead. Pure: headers in, a
//! refusal or nothing out.
use http::{HeaderMap, Method};

use crate::error::ApiError;
use crate::trust::{TrustedProxy, header, strip_scheme};

/// `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`: nothing else is this wisp.
pub fn local_host(host: &str, port: u16) -> bool {
    let Some((name, p)) = host.rsplit_once(':') else {
        return false;
    };
    p.parse::<u16>().ok() == Some(port) && matches!(name, "127.0.0.1" | "localhost" | "[::1]")
}

pub fn safe_method(m: &Method) -> bool {
    m == Method::GET || m == Method::HEAD
}

/// Host, then (non-GET) Origin.
pub fn check(method: &Method, h: &HeaderMap, port: u16, proxy: &TrustedProxy, via_proxy: bool, open: bool) -> Result<(), ApiError> {
    if open {
        return Ok(());
    }
    if !via_proxy && !header(h, "host").is_some_and(|x| local_host(x, port)) {
        return Err(ApiError::ForbiddenHost);
    }
    if safe_method(method) {
        return Ok(());
    }
    let origin = header(h, "origin");
    let origin_ok = if via_proxy { proxy.origin_ok(h) } else { origin.is_none_or(|o| local_host(strip_scheme(o), port)) };
    if origin_ok {
        Ok(())
    } else if !via_proxy && origin.is_some_and(|o| other_local_port(strip_scheme(o), port)) {
        Err(ApiError::PaneOrigin)
    } else {
        Err(ApiError::ForbiddenOrigin)
    }
}

/// A page on this computer at another port: a My Stuff app or pane (`stuff.launch` serves each on its own port), or
/// any other local server. It never writes to wisp itself; a pane asks wisp's page, which shows you a card.
fn other_local_port(origin: &str, port: u16) -> bool {
    origin
        .rsplit_once(':')
        .is_some_and(|(name, p)| p.parse::<u16>().is_ok_and(|p| p != port) && matches!(name, "127.0.0.1" | "localhost" | "[::1]"))
}

/// Non-GET bodies are JSON; `application/octet-stream` only where the route takes uploads.
pub fn content_ok(method: &Method, h: &HeaderMap, upload: bool) -> Result<(), ApiError> {
    if safe_method(method) {
        return Ok(());
    }
    let ct = header(h, "content-type").unwrap_or("");
    if ct.starts_with("application/json") || (upload && ct.starts_with("application/octet-stream")) {
        Ok(())
    } else {
        Err(ApiError::JsonOnly)
    }
}

/// The share target's POST /share when the service worker didn't take it (v1 http/share.js): answered
/// ahead of the Origin and JSON checks it would fail for no gain; the form is never read.
pub fn is_share(method: &Method, path: &str) -> bool {
    method == Method::POST && path == "/share"
}
pub const SHARE_LANDING: &str = "/?shared=none";

#[cfg(test)]
mod tests {
    use super::*;

    fn hm(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }
    const P: u16 = 4477;

    #[test]
    fn only_local_hosts_at_our_port() {
        for ok in ["127.0.0.1:4477", "localhost:4477", "[::1]:4477"] {
            assert!(local_host(ok, P), "{ok}");
        }
        for no in ["127.0.0.1:4478", "evil.com:4477", "localhost", "127.0.0.1.evil.com:4477", "[::1]", "localhost:4477x"] {
            assert!(!local_host(no, P), "{no}");
        }
    }

    #[test]
    fn host_is_checked_unless_via_proxy_or_open() {
        let p = TrustedProxy::off();
        let bad = hm(&[("host", "attacker.example:4477")]);
        assert!(matches!(check(&Method::GET, &bad, P, &p, false, false), Err(ApiError::ForbiddenHost)));
        assert!(check(&Method::GET, &bad, P, &p, true, false).is_ok());
        assert!(check(&Method::POST, &bad, P, &p, false, true).is_ok());
        assert!(matches!(check(&Method::GET, &hm(&[]), P, &p, false, false), Err(ApiError::ForbiddenHost)));
    }

    #[test]
    fn non_get_origin_must_be_local() {
        let p = TrustedProxy::off();
        let h = |o: &str| hm(&[("host", "127.0.0.1:4477"), ("origin", o)]);
        assert!(check(&Method::POST, &h("http://localhost:4477"), P, &p, false, false).is_ok());
        assert!(matches!(check(&Method::POST, &h("https://evil.example"), P, &p, false, false), Err(ApiError::ForbiddenOrigin)));
        assert!(matches!(check(&Method::POST, &h("null"), P, &p, false, false), Err(ApiError::ForbiddenOrigin)));
        // a GET with a foreign Origin is a read the browser won't show the page anyway
        assert!(check(&Method::GET, &h("https://evil.example"), P, &p, false, false).is_ok());
        assert!(check(&Method::POST, &hm(&[("host", "127.0.0.1:4477")]), P, &p, false, false).is_ok());
    }

    #[test]
    fn a_pane_on_another_local_port_is_told_it_only_proposes() {
        let p = TrustedProxy::off();
        let h = |o: &str| hm(&[("host", "127.0.0.1:4477"), ("origin", o)]);
        for pane in ["http://localhost:47177", "http://127.0.0.1:47177", "http://[::1]:5173"] {
            let e = check(&Method::POST, &h(pane), P, &p, false, false).err();
            assert!(matches!(e, Some(ApiError::PaneOrigin)), "{pane}");
            let w = e.map(|e| e.to_wire()).unwrap();
            assert_eq!(w.code, wisp_kernel::Code::Forbidden);
            assert!(w.message.contains("can only propose"), "{}", w.message);
        }
        for not in ["http://localhost.evil.example:47177", "http://localhost", "http://localhost:x"] {
            assert!(matches!(check(&Method::POST, &h(not), P, &p, false, false), Err(ApiError::ForbiddenOrigin)), "{not}");
        }
        // through the grid's proxy a local origin is no pane of yours: the plain refusal
        let px = TrustedProxy::new(Some("0123456789abcdef0123456789abcdef"), Some("https://ada.grid.trywisp.dev"));
        assert!(matches!(check(&Method::POST, &h("http://localhost:47177"), P, &px, true, false), Err(ApiError::ForbiddenOrigin)));
    }

    #[test]
    fn via_proxy_origin_is_the_public_url() {
        let p = TrustedProxy::new(Some("0123456789abcdef0123456789abcdef"), Some("https://ada.grid.trywisp.dev"));
        let h = |o: &str| hm(&[("host", "anything"), ("origin", o)]);
        assert!(check(&Method::POST, &h("https://ada.grid.trywisp.dev"), P, &p, true, false).is_ok());
        assert!(matches!(check(&Method::POST, &h("http://localhost:4477"), P, &p, true, false), Err(ApiError::ForbiddenOrigin)));
    }

    #[test]
    fn bodies_are_json_or_uploads() {
        let j = hm(&[("content-type", "application/json; charset=utf-8")]);
        let o = hm(&[("content-type", "application/octet-stream")]);
        let t = hm(&[("content-type", "text/plain")]);
        assert!(content_ok(&Method::POST, &j, false).is_ok());
        assert!(matches!(content_ok(&Method::POST, &o, false), Err(ApiError::JsonOnly)));
        assert!(content_ok(&Method::POST, &o, true).is_ok());
        assert!(matches!(content_ok(&Method::DELETE, &t, true), Err(ApiError::JsonOnly)));
        assert!(matches!(content_ok(&Method::PATCH, &hm(&[]), false), Err(ApiError::JsonOnly)));
        assert!(content_ok(&Method::GET, &t, false).is_ok());
    }
}
