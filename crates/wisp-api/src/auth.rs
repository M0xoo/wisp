//! Who is asking (ADR-0008, v1 agent-token.js, edge case 3): every request speaks for one capability set,
//! decided here once, before any route runs; the route's permission is then checked against it.
//!
//! | what the request carries                         | caller                                       |
//! |--------------------------------------------------|----------------------------------------------|
//! | `x-wisp-token` = wisp's own (master) token        | the user set (`user:full`, `box` on a box)   |
//! | `x-wisp-token` = HMAC(master, `session:<id>`)     | `agent:session` for `<id>` only              |
//! | `x-wisp-token` = HMAC(master, `connectors`)       | `connector`                                  |
//! | `x-wisp-token` = anything else                    | 403 `bad token`, whatever the route          |
//! | via the proxy with `x-wisp-proxy-via: key`        | `apikey` (a grid API key, checked at the grid) |
//! | via the proxy, otherwise                          | the user set                                 |
//! | the local page (Host and Origin checked)          | the user set                                 |
//!
//! The session an agent token speaks for is named by the URL (`:id`, `:sid`), then `x-wisp-session`,
//! then the JSON body's `session`; a token for another session is a 403. The master token is never
//! handed to an agent.
use std::collections::BTreeMap;

use hmac::{Hmac, Mac};
use http::HeaderMap;
use sha2::Sha256;
use subtle::ConstantTimeEq;
use wisp_kernel::Caller;

use crate::error::ApiError;
use crate::trust::header;

fn derive(master: &str, what: &str) -> String {
    // HMAC accepts a key of any length: new_from_slice can't fail for it
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(master.as_bytes()) else { return String::new() };
    mac.update(what.as_bytes());
    hex(&mac.finalize().into_bytes())
}

pub(crate) fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut s, b| {
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// Constant-time equality (lengths may differ: that alone answers false).
pub fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

/// The token a session's agent gets: it speaks for that session only.
pub fn session_token(master: &str, session: &str) -> String {
    derive(master, &format!("session:{session}"))
}

/// The token connector proxies get: it opens only the routes they use.
pub fn connector_token(master: &str) -> String {
    derive(master, "connectors")
}

/// The caller sets the edge itself names.
pub mod sets {
    pub const USER: &str = "user:full";
    pub const BOX: &str = "box";
    pub const CONNECTOR: &str = "connector";
    pub const APIKEY: &str = "apikey";
    /// an open route's caller without a token (a webhook from the internet)
    pub const PUBLIC: &str = "public";
}

/// Decides the agent's set for a session (`agent:session`, or `agent:capped` for a capped task).
pub type AgentSet = std::sync::Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

pub struct AuthOptions<'a> {
    pub master: &'a str,
    /// the set the person at the page speaks with: `user:full`, or `box` on a grid box
    pub user_set: &'a str,
    pub via_proxy: bool,
    /// an open route reached from outside: no token is `public`
    pub public: bool,
    pub agent_set: Option<&'a AgentSet>,
}

/// The session ids a request names, in the order they count.
pub fn named_sessions(params: &BTreeMap<String, String>, h: &HeaderMap, body: &[u8]) -> Vec<String> {
    let mut ids: Vec<String> = ["id", "sid"].iter().filter_map(|k| params.get(*k).filter(|v| !v.is_empty()).cloned()).collect();
    if let Some(s) = header(h, "x-wisp-session").filter(|s| !s.is_empty()) {
        ids.push(s.to_owned());
    }
    if ids.is_empty() && !body.is_empty() {
        // bySession routes name it in the body (v1 internal.js): only read when nothing else did
        if let Ok(serde_json::Value::Object(o)) = serde_json::from_slice::<serde_json::Value>(body) {
            if let Some(serde_json::Value::String(s)) = o.get("session").filter(|s| s.as_str().is_some_and(|s| !s.is_empty())) {
                ids.push(s.clone());
            }
        }
    }
    ids
}

pub fn resolve(h: &HeaderMap, params: &BTreeMap<String, String>, body: &[u8], o: &AuthOptions<'_>) -> Result<Caller, ApiError> {
    let user = || Caller { set: o.user_set.to_owned(), session: None, plugin: None };
    if let Some(token) = h.get("x-wisp-token") {
        let token = token.to_str().map_err(|_| ApiError::BadToken)?;
        if same(token, o.master) {
            return Ok(user());
        }
        if same(token, &connector_token(o.master)) {
            return Ok(Caller { set: sets::CONNECTOR.into(), session: None, plugin: None });
        }
        for id in named_sessions(params, h, body) {
            if same(token, &session_token(o.master, &id)) {
                let set = o.agent_set.and_then(|f| f(&id)).unwrap_or_else(|| "agent:session".into());
                return Ok(Caller { set, session: Some(id), plugin: None });
            }
        }
        return Err(ApiError::BadToken);
    }
    if o.via_proxy && header(h, "x-wisp-proxy-via") == Some("key") {
        return Ok(Caller { set: sets::APIKEY.into(), session: None, plugin: None });
    }
    if o.public {
        return Ok(Caller { set: sets::PUBLIC.into(), session: None, plugin: None });
    }
    Ok(user())
}

/// Rules the edge keeps whatever the capability data says (v1 edge case 3): a grid API key never
/// manages API keys, and a connector token opens only the connectors' token route.
pub fn edge_denies(caller: &Caller, permission: &str) -> bool {
    match caller.set.as_str() {
        sets::APIKEY => permission.starts_with("apikeys:") || permission.starts_with("grid:apikeys"),
        sets::CONNECTOR => !permission.starts_with("connectors:"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const M: &str = "master-token-0123456789abcdef";

    fn hm(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.insert(*k, v.parse().unwrap());
        }
        h
    }
    fn opts(via: bool) -> AuthOptions<'static> {
        AuthOptions { master: M, user_set: "user:full", via_proxy: via, public: false, agent_set: None }
    }
    fn params(id: &str) -> BTreeMap<String, String> {
        BTreeMap::from([("id".to_owned(), id.to_owned())])
    }

    #[test]
    fn tokens_match_v1() {
        // v1: createHmac('sha256', master).update('session:abc').digest('hex')
        assert_eq!(session_token("k", "abc").len(), 64);
        assert_ne!(session_token(M, "a"), session_token(M, "b"));
        assert_ne!(connector_token(M), session_token(M, "connectors"));
        assert_eq!(derive("key", "The quick brown fox jumps over the lazy dog"), "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8");
    }

    #[test]
    fn master_is_the_user_set() {
        let c = resolve(&hm(&[("x-wisp-token", M)]), &BTreeMap::new(), b"", &opts(false)).unwrap();
        assert_eq!(c.set, "user:full");
        let on_box = AuthOptions { user_set: "box", ..opts(false) };
        assert_eq!(resolve(&hm(&[("x-wisp-token", M)]), &BTreeMap::new(), b"", &on_box).unwrap().set, "box");
    }

    #[test]
    fn agent_token_speaks_for_its_session_only() {
        let t = session_token(M, "s1");
        let c = resolve(&hm(&[("x-wisp-token", &t)]), &params("s1"), b"", &opts(false)).unwrap();
        assert_eq!((c.set.as_str(), c.session.as_deref()), ("agent:session", Some("s1")));
        assert!(matches!(resolve(&hm(&[("x-wisp-token", &t)]), &params("s2"), b"", &opts(false)), Err(ApiError::BadToken)));
        // the header names it when the URL doesn't
        assert!(resolve(&hm(&[("x-wisp-token", &t), ("x-wisp-session", "s1")]), &BTreeMap::new(), b"", &opts(false)).is_ok());
        // then the body
        assert!(resolve(&hm(&[("x-wisp-token", &t)]), &BTreeMap::new(), br#"{"session":"s1"}"#, &opts(false)).is_ok());
        assert!(resolve(&hm(&[("x-wisp-token", &t)]), &BTreeMap::new(), br#"{"session":"s2"}"#, &opts(false)).is_err());
        // the URL wins over the body: naming another session in the body doesn't help
        assert!(resolve(&hm(&[("x-wisp-token", &t)]), &params("s2"), br#"{"session":"s1"}"#, &opts(false)).is_err());
        // nothing named: a 403
        assert!(resolve(&hm(&[("x-wisp-token", &t)]), &BTreeMap::new(), b"", &opts(false)).is_err());
    }

    #[test]
    fn capped_sessions_get_their_set() {
        let f: AgentSet = std::sync::Arc::new(|id: &str| (id == "s1").then(|| "agent:capped".to_owned()));
        let o = AuthOptions { agent_set: Some(&f), ..opts(false) };
        let c = resolve(&hm(&[("x-wisp-token", &session_token(M, "s1"))]), &params("s1"), b"", &o).unwrap();
        assert_eq!(c.set, "agent:capped");
    }

    #[test]
    fn wrong_token_is_403_whatever_else() {
        assert!(matches!(resolve(&hm(&[("x-wisp-token", "nope")]), &BTreeMap::new(), b"", &opts(true)), Err(ApiError::BadToken)));
        assert!(matches!(resolve(&hm(&[("x-wisp-token", "")]), &BTreeMap::new(), b"", &opts(false)), Err(ApiError::BadToken)));
    }

    #[test]
    fn connectors_and_api_keys() {
        let c = resolve(&hm(&[("x-wisp-token", &connector_token(M))]), &BTreeMap::new(), b"", &opts(false)).unwrap();
        assert_eq!(c.set, "connector");
        assert!(edge_denies(&c, "settings:write"));
        assert!(!edge_denies(&c, "connectors:token"));
        let k = resolve(&hm(&[("x-wisp-proxy-via", "key")]), &BTreeMap::new(), b"", &opts(true)).unwrap();
        assert_eq!(k.set, "apikey");
        assert!(edge_denies(&k, "apikeys:create"));
        assert!(!edge_denies(&k, "runtime:create"));
        // not through the proxy, the header means nothing
        assert_eq!(resolve(&hm(&[("x-wisp-proxy-via", "key")]), &BTreeMap::new(), b"", &opts(false)).unwrap().set, "user:full");
    }
}
