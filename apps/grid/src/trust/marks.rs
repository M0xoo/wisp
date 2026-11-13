//! The grid's marks (headers only it may set) and the box's side of trusted-proxy mode.
use std::collections::BTreeMap;

use serde::Serialize;

use crate::secrets::safe_equal;

// --- headers: the grid's marks ---------------------------------------------------------------------
//
// A box (or a computer) trusts a few headers because only the grid sets them. So every one of them is
// dropped from what comes in from outside, on every path, before the grid adds its own.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Mark {
    pub header: &'static str,
    /// who sets it, and only they
    pub set_by: &'static str,
    /// which values, where it carries one
    pub values: &'static [&'static str],
}

pub const MARKS: [Mark; 6] = [
    Mark { header: "x-wisp-proxy-secret", set_by: "the edge, towards a box: trusted-proxy mode (box side: BoxTrust)", values: &[] },
    // 'inbox' only from delivery (inbox → to_box), 'key' only from the edge for an API key. A box acts
    // on these (a channel's message never counts as use; a key can't manage keys), so nothing outside
    // may claim either.
    Mark {
        header: "x-wisp-proxy-via",
        set_by: "the grid: inbox delivery sets \"inbox\", the edge sets \"key\" for an API key",
        values: &["inbox", "key"],
    },
    Mark { header: "x-wisp-route", set_by: "route delivery, through a computer’s tunnel, only", values: &["grid"] },
    Mark { header: "x-wisp-preview", set_by: "the preview edge: which port of the box the page is on", values: &[] },
    Mark { header: "x-wisp-upgrade", set_by: "the tunnel: what a websocket asked to upgrade to (HTTP/2 has no Upgrade)", values: &[] },
    Mark { header: "x-wisp-tunnel", set_by: "the computer’s side of its tunnel", values: &[] },
];

/// The value of x-wisp-proxy-via, and who alone may set it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    /// a channel's message, delivered from the inbox: never counts as use of the box
    Inbox,
    /// an API key at the edge: the box refuses it key management
    Key,
}

/// Who sets a via mark.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ViaSource {
    Delivery,
    Edge,
}

impl Via {
    pub fn value(self) -> &'static str {
        match self {
            Self::Inbox => "inbox",
            Self::Key => "key",
        }
    }
    /// VIA: `inbox` is set by delivery, `key` by the edge.
    pub fn source(self) -> ViaSource {
        match self {
            Self::Inbox => ViaSource::Delivery,
            Self::Key => ViaSource::Edge,
        }
    }
}

/// The via mark for a request the grid itself makes: only the source VIA names may set it.
pub fn via_header(via: Via, source: ViaSource) -> Result<(&'static str, &'static str), String> {
    if via.source() != source {
        return Err(format!("x-wisp-proxy-via: {} is set by {:?}, not {source:?}", via.value(), via.source()));
    }
    Ok(("x-wisp-proxy-via", via.value()))
}

/// True for a header only the grid may set: one of MARKS, any x-wisp-proxy-*, or the x-forwarded-* set.
/// (x-wisp-proxy-* as a whole, as v1's edge dropped it: a box reads its trusted-proxy marks by prefix.)
/// Only these: a client's own x-wisp-* headers (x-wisp-relay, x-wisp-token, x-wisp-sw, x-wisp-build,
/// x-wisp-session) are wisp's to read and go through to the box as they did in v1.
pub fn is_mark(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    MARKS.iter().any(|m| m.header == n) || n.starts_with("x-wisp-proxy") || n.starts_with("x-forwarded")
}

const HOP: [&str; 7] = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"];

pub fn is_hop(name: &str) -> bool {
    HOP.iter().any(|h| h.eq_ignore_ascii_case(name))
}

/// What of an outside request's headers is kept.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Keep {
    pub cookie: bool,
    pub authorization: bool,
}

/// What of an outside request goes on: no hop-by-hop header, none of the grid's marks, and no sign-in
/// of the grid's own (its cookie and bearer stay at the edge) unless asked to keep them.
pub fn from_outside(headers: &http::HeaderMap, keep: Keep) -> http::HeaderMap {
    let mut out = http::HeaderMap::with_capacity(headers.len());
    for (k, v) in headers {
        let n = k.as_str();
        if is_hop(n) || is_mark(n) || (n == "cookie" && !keep.cookie) || (n == "authorization" && !keep.authorization) {
            continue;
        }
        out.append(k.clone(), v.clone());
    }
    out
}

// --- the box's side: trusted-proxy mode (v1 server/http/trust.js) ------------------------------------
//
// A box's wisp runs behind the edge. A request carrying the secret in x-wisp-proxy-secret came through
// the edge, which already checked who is asking: any Host is fine, and a non-GET Origin must be the
// public address (WISP_PUBLIC_URL), so a page elsewhere still can't post to it. Without the header the
// usual localhost rules apply, so the CLI and the agents' MCP keep working on the box. The grid's
// stand-in boxes run this, and the kernel's HTTP trusted-proxy option (plan §7.2.5) is meant to match.

pub const MIN_PROXY_SECRET: usize = 32;

#[derive(Clone)]
pub struct BoxTrust {
    pub on: bool,
    pub origin: Option<String>,
    secret: String,
}

impl std::fmt::Debug for BoxTrust {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BoxTrust").field("on", &self.on).field("origin", &self.origin).finish_non_exhaustive()
    }
}

impl BoxTrust {
    /// From the box's environment (`WISP_TRUSTED_PROXY_SECRET`, `WISP_PUBLIC_URL`). `warn` hears why a
    /// setting was ignored.
    pub fn from_env(env: &BTreeMap<String, String>, warn: &mut dyn FnMut(&str)) -> Self {
        let secret = env.get("WISP_TRUSTED_PROXY_SECRET").cloned().unwrap_or_default();
        if !secret.is_empty() && secret.len() < MIN_PROXY_SECRET {
            warn(&format!("wisp: WISP_TRUSTED_PROXY_SECRET is shorter than {MIN_PROXY_SECRET} characters; trusted-proxy mode stays off"));
        }
        let on = secret.len() >= MIN_PROXY_SECRET;
        let origin = env.get("WISP_PUBLIC_URL").filter(|u| !u.is_empty()).and_then(|u| {
            if let Ok(p) = url::Url::parse(u) {
                Some(p.origin().ascii_serialization())
            } else {
                warn("wisp: WISP_PUBLIC_URL is not a URL; ignoring it");
                None
            }
        });
        Self { on, origin, secret }
    }

    /// Whether this request came through the edge.
    pub fn via(&self, headers: &http::HeaderMap) -> bool {
        if !self.on {
            return false;
        }
        headers.get("x-wisp-proxy-secret").and_then(|v| v.to_str().ok()).is_some_and(|got| safe_equal(got, &self.secret))
    }

    /// A non-GET Origin through the edge: the public address (or, with none set, the Host asked for).
    pub fn origin_ok(&self, headers: &http::HeaderMap) -> bool {
        let get = |k: &str| headers.get(k).and_then(|v| v.to_str().ok()).unwrap_or("");
        let o = get("origin");
        if o.is_empty() {
            return true;
        }
        if let Some(want) = &self.origin {
            return o == want;
        }
        let bare = o.strip_prefix("https://").or_else(|| o.strip_prefix("http://")).unwrap_or(o);
        bare == get("x-forwarded-host") || bare == get("host")
    }
}
