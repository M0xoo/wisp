//! The edge's routing table (plan §7.2.5): which part of the grid a Host header is for. One process,
//! many kinds of address, all on the grid's one port:
//!
//! ```text
//!   <domain>                     the grid itself: sign in, your account, the device API
//!   <handle>.<domain>            the edge: that user's own wisp, started on demand by hostd and
//!                                proxied (HTTP + SSE) in trusted-proxy mode
//!   <name>--<handle>.<domain>    a computer the user added, through the tunnel it holds open
//!   p<port>--<handle>.<domain>   a page the agent left running in that user's box (boxes only:
//!                                hostd.previews; a process wisp's loopback is the grid's own)
//!   p<port>--<name>--<handle>    the same for a computer, through its tunnel
//!   sb-<id>--<handle>.<domain>   a sandbox: a box of its own for one task; p<port>--sb-… its pages
//!   <slug>--app--<handle>        an app published from My Stuff, served by the grid itself
//! ```
//!
//! and on them, by path: `<handle>/_in/<token>` (a channel's webhook, held for the box),
//! `<domain>/_mail/<provider>` (the mail provider's webhook), `<domain>/_route/<token>` (a bot the grid
//! owns, for `on laptop`), and `/_grid/*` (the edge's own: auth, signout, keys, preview, state, stop,
//! tls-ask, a).
//!
//! Cookies never span subdomains, so one user's wisp page can't read or set another's. The order of
//! `LABELS` is the order labels are tried: the first that matches decides.
use std::collections::HashSet;

use crate::rows::{ComputerRow, SandboxRow, SiteRow};

#[derive(Debug, Clone, PartialEq)]
pub enum HostKind {
    Root,
    /// A published app; `None`: unpublished or a typo (a 404 page, never an edge).
    Site(Option<SiteRow>),
    Sandbox(SandboxRow),
    Computer(ComputerRow),
    Preview(Preview),
    Edge {
        handle: String,
    },
    Unknown,
}

/// `p<port>--<label>`: whose page it is.
#[derive(Debug, Clone, PartialEq)]
pub struct Preview {
    pub port: u16,
    pub label: String,
    pub of: PreviewOf,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PreviewOf {
    Sandbox(SandboxRow),
    Computer(ComputerRow),
    Handle(String),
}

/// What the resolver may look up: the rows a label names.
pub trait HostLookups {
    fn domain(&self) -> &str;
    /// the grid's own Host values: <domain>, with its public port suffix, with its listen port
    fn root_hosts(&self) -> &HashSet<String>;
    /// pages in boxes (hostd.previews; on by default for containers)
    fn previews(&self) -> bool;
    fn site(&self, label: &str) -> Option<SiteRow>;
    fn sandbox(&self, label: &str) -> Option<SandboxRow>;
    fn computer(&self, label: &str) -> Option<ComputerRow>;
    /// Whether a user has this handle (for the TLS check only).
    fn handle(&self, label: &str) -> bool;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LabelRule {
    pub kind: &'static str,
    pub pattern: &'static str,
    pub note: &'static str,
}

/// The table, for people and tests: what `host_kind` does, in order.
pub const LABELS: [LabelRule; 9] = [
    LabelRule {
        kind: "root",
        pattern: "<domain>[:port]",
        note: "the grid itself, by its exact Host",
    },
    LabelRule {
        kind: "site",
        pattern: "<slug>--app--<handle>",
        note: "a published app; an unknown one is still a site (404 page), never an edge",
    },
    LabelRule {
        kind: "sandbox",
        pattern: "sb-<8 hex>--<handle>",
        note: "a sandbox that exists; otherwise read on",
    },
    LabelRule {
        kind: "computer",
        pattern: "<name>--<handle>",
        note: "a computer that exists (a label with \"--\")",
    },
    LabelRule {
        kind: "preview",
        pattern: "p<1-65535>--sb-<id>--<handle>",
        note: "a sandbox’s page, only with previews on",
    },
    LabelRule {
        kind: "preview",
        pattern: "p<1-65535>--<name>--<handle>",
        note: "a computer’s page: the computer decides whether it shows",
    },
    LabelRule {
        kind: "preview",
        pattern: "p<1-65535>--<handle>",
        note: "a box’s page, only with previews on",
    },
    LabelRule {
        kind: "edge",
        pattern: "<handle>",
        note: "any other label of a-z, 0-9 and \"-\": a user’s wisp (unknown handles answer 404 there)",
    },
    LabelRule {
        kind: "unknown",
        pattern: "*",
        note: "another domain, or a label with other characters: 421",
    },
];

/// `[a-z0-9-]+`
pub fn is_handle_label(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// `<slug>--app--<handle>`
pub fn is_site_label(label: &str) -> bool {
    label
        .split_once("--app--")
        .is_some_and(|(a, b)| is_handle_label(a) && is_handle_label(b))
}

/// `sb-<8 hex>--<handle>`: the sandbox id, if it is one.
pub fn sandbox_label(label: &str) -> Option<&str> {
    let rest = label.strip_prefix("sb-")?;
    let (id, handle) = rest.split_once("--")?;
    (id.len() == 8
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        && is_handle_label(handle))
    .then_some(id)
}

/// `p<1-5 digits>--<rest>` with rest `[a-z0-9-]+`: (port, rest). The port isn't range-checked here.
pub fn preview_label(label: &str) -> Option<(u32, &str)> {
    let rest = label.strip_prefix('p')?;
    let (digits, rest) = rest.split_once("--")?;
    if digits.is_empty()
        || digits.len() > 5
        || !digits.bytes().all(|b| b.is_ascii_digit())
        || !is_handle_label(rest)
    {
        return None;
    }
    Some((digits.parse().ok()?, rest))
}

fn preview(label: &str, look: &dyn HostLookups) -> Option<Preview> {
    let (port, rest) = preview_label(label)?;
    let port = u16::try_from(port).ok().filter(|p| *p >= 1)?;
    let label = rest.to_owned();
    if sandbox_label(rest).is_some()
        && look.previews()
        && let Some(sb) = look.sandbox(rest)
    {
        return Some(Preview {
            port,
            label,
            of: PreviewOf::Sandbox(sb),
        });
    }
    if rest.contains("--")
        && let Some(c) = look.computer(rest)
    {
        return Some(Preview {
            port,
            label,
            of: PreviewOf::Computer(c),
        });
    }
    if look.previews() && !rest.contains("--") {
        return Some(Preview {
            port,
            label: label.clone(),
            of: PreviewOf::Handle(label),
        });
    }
    None
}

/// Strip a trailing `:<digits>`.
fn without_port(host: &str) -> &str {
    match host.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => h,
        _ => host,
    }
}

/// Which part of the grid a Host header is for. Pure but for the lookups it is given.
pub fn host_kind(raw_host: &str, look: &dyn HostLookups) -> HostKind {
    let host = raw_host.to_ascii_lowercase();
    if look.root_hosts().contains(&host) {
        return HostKind::Root;
    }
    let bare = without_port(&host);
    let Some(label) = bare
        .strip_suffix(look.domain())
        .and_then(|l| l.strip_suffix('.'))
    else {
        return HostKind::Unknown;
    };
    if is_site_label(label) {
        return HostKind::Site(look.site(label));
    }
    if sandbox_label(label).is_some()
        && let Some(sb) = look.sandbox(label)
    {
        return HostKind::Sandbox(sb);
    }
    if label.contains("--")
        && let Some(c) = look.computer(label)
    {
        return HostKind::Computer(c);
    }
    if let Some(pv) = preview(label, look) {
        return HostKind::Preview(pv);
    }
    if is_handle_label(label) {
        return HostKind::Edge {
            handle: label.to_owned(),
        };
    }
    HostKind::Unknown
}

/// The grid's own Host values for a config.
pub fn root_hosts(domain: &str, port_suffix: &str, listen_port: u16) -> HashSet<String> {
    HashSet::from([
        domain.to_owned(),
        format!("{domain}{port_suffix}"),
        format!("{domain}:{listen_port}"),
    ])
}

// --- paths that belong to the edge itself, on any address --------------------------------------------

/// A channel's webhook at <handle>/_in/<token> (inbox).
pub const IN_PREFIX: &str = "/_in";
/// A bot the grid owns, at <domain>/_route/<token> (route).
pub const ROUTE_PREFIX: &str = "/_route";
pub const TLS_ASK: &str = "/_grid/tls-ask";

/// `/_grid/a/<name>.<webp|svg|png>`: the grid's own images.
pub fn asset_path(p: &str) -> Option<(&str, &str)> {
    let file = p.strip_prefix("/_grid/a/")?;
    let (name, ext) = file.rsplit_once('.')?;
    (is_handle_label(name) && matches!(ext, "webp" | "svg" | "png")).then_some((name, ext))
}

pub fn is_under(p: &str, prefix: &str) -> bool {
    p == prefix || p.strip_prefix(prefix).is_some_and(|r| r.starts_with('/'))
}

/// Caddy's on-demand TLS check: only the grid itself and names that exist. `look` answers for the
/// label alone (a handle, a site, a computer, a sandbox, or a preview of one).
pub fn tls_allowed(domain: &str, ask: &str, look: &dyn HostLookups) -> bool {
    let d = ask.to_ascii_lowercase();
    if d == domain {
        return true;
    }
    let Some(label) = d.strip_suffix(domain).and_then(|l| l.strip_suffix('.')) else {
        return false;
    };
    if look.handle(label)
        || look.site(label).is_some()
        || look.computer(label).is_some()
        || look.sandbox(label).is_some()
    {
        return true;
    }
    let Some((_, pv)) = preview_label(label) else {
        return false;
    };
    (look.previews() && (look.handle(pv) || look.sandbox(pv).is_some()))
        || look.computer(pv).is_some()
}
