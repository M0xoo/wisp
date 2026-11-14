//! Trusted-proxy mode (v1 server/http/trust.js): wisp behind a reverse proxy that serves it at its own
//! public address (wisp Grid's edge, or your own nginx/Caddy). Off unless `WISP_TRUSTED_PROXY_SECRET` is
//! at least 32 characters. A request carrying the secret in `x-wisp-proxy-secret` came through the
//! proxy, which already checked who is asking: any Host is fine, and a non-GET Origin must be the public
//! address (`WISP_PUBLIC_URL`), so a page elsewhere still can't post to it. Without the header the
//! localhost rules apply, so the CLI and the agents' MCP keep working on the box itself.
use http::HeaderMap;
use subtle::ConstantTimeEq;

pub const MIN_SECRET: usize = 32;

#[derive(Clone, Default)]
pub struct TrustedProxy {
    secret: Option<Vec<u8>>,
    /// the public origin, `https://ada.grid.trywisp.dev`
    origin: Option<String>,
}

impl std::fmt::Debug for TrustedProxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TrustedProxy").field("on", &self.on()).field("origin", &self.origin).finish_non_exhaustive()
    }
}

pub(crate) fn header<'a>(h: &'a HeaderMap, name: &str) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

impl TrustedProxy {
    /// From `WISP_TRUSTED_PROXY_SECRET` and `WISP_PUBLIC_URL` (read by the binary, passed in).
    pub fn new(secret: Option<&str>, public_url: Option<&str>) -> Self {
        let secret = secret.unwrap_or_default();
        if !secret.is_empty() && secret.len() < MIN_SECRET {
            tracing::warn!("WISP_TRUSTED_PROXY_SECRET is shorter than {MIN_SECRET} characters; trusted-proxy mode stays off");
        }
        let origin = public_url.filter(|u| !u.is_empty()).and_then(|u| {
            if let Ok(u) = url::Url::parse(u) {
                Some(u.origin().ascii_serialization())
            } else {
                tracing::warn!("WISP_PUBLIC_URL is not a URL; ignoring it");
                None
            }
        });
        Self { secret: (secret.len() >= MIN_SECRET).then(|| secret.as_bytes().to_vec()), origin }
    }

    pub fn off() -> Self {
        Self::default()
    }

    pub fn on(&self) -> bool {
        self.secret.is_some()
    }

    pub fn origin(&self) -> Option<&str> {
        self.origin.as_deref()
    }

    /// Whether this request came through the proxy (the secret compared in constant time).
    pub fn via(&self, h: &HeaderMap) -> bool {
        let (Some(want), Some(got)) = (&self.secret, h.get("x-wisp-proxy-secret")) else {
            return false;
        };
        let got = got.as_bytes();
        got.len() == want.len() && bool::from(got.ct_eq(want))
    }

    /// A non-GET Origin through the proxy: the public address, or with none set the Host asked for.
    pub fn origin_ok(&self, h: &HeaderMap) -> bool {
        let Some(o) = header(h, "origin") else {
            return true;
        };
        if let Some(want) = &self.origin {
            return o == want;
        }
        let bare = strip_scheme(o);
        Some(bare) == header(h, "x-forwarded-host") || Some(bare) == header(h, "host")
    }
}

pub(crate) fn strip_scheme(o: &str) -> &str {
    o.strip_prefix("https://").or_else(|| o.strip_prefix("http://")).unwrap_or(o)
}

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
    const S: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn short_secret_keeps_it_off() {
        let p = TrustedProxy::new(Some("short"), None);
        assert!(!p.on());
        assert!(!p.via(&hm(&[("x-wisp-proxy-secret", "short")])));
    }

    #[test]
    fn via_needs_the_exact_secret() {
        let p = TrustedProxy::new(Some(S), None);
        assert!(p.on());
        assert!(p.via(&hm(&[("x-wisp-proxy-secret", S)])));
        assert!(!p.via(&hm(&[("x-wisp-proxy-secret", "0123456789abcdef0123456789abcdeX")])));
        assert!(!p.via(&hm(&[("x-wisp-proxy-secret", &S[..31])])));
        assert!(!p.via(&hm(&[])));
    }

    #[test]
    fn origin_is_the_public_url() {
        let p = TrustedProxy::new(Some(S), Some("https://ada.grid.trywisp.dev/some/path"));
        assert_eq!(p.origin(), Some("https://ada.grid.trywisp.dev"));
        assert!(p.origin_ok(&hm(&[("origin", "https://ada.grid.trywisp.dev")])));
        assert!(!p.origin_ok(&hm(&[("origin", "https://evil.example")])));
        assert!(p.origin_ok(&hm(&[])));
    }

    #[test]
    fn without_public_url_origin_is_the_forwarded_host() {
        let p = TrustedProxy::new(Some(S), Some("not a url"));
        assert_eq!(p.origin(), None);
        assert!(p.origin_ok(&hm(&[("origin", "https://box.example"), ("x-forwarded-host", "box.example")])));
        assert!(p.origin_ok(&hm(&[("origin", "http://box.example"), ("host", "box.example")])));
        assert!(!p.origin_ok(&hm(&[("origin", "https://evil.example"), ("host", "box.example")])));
    }
}
