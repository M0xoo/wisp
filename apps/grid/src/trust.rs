//! Who may reach what on the grid, as data (plan §7.2.4, ADR-0014). v1 wrote these rules as comments in
//! grid/route.js, grid/inbox.js, grid/server.js and server/http/trust.js; here each is a row the edge
//! asks (`may`) and a test reads (`tests/trust.rs`). Default deny: a credential reaches only what its
//! set allows, and a deny names why, in the words v1's comments used.
//!
//! The one rule everything else serves: **a box never gets a token for a laptop.** Anything on a box
//! can read its Box secret (hostd gives it to the box's wisp), so a prompt injection in a box holds it.
//! That secret therefore reaches the box's own channel and publishing API and nothing past them: never
//! a computer, never a computer's report, never a key or a sign-in link.
use serde::Serialize;

/// How a caller proved who it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Credential {
    /// the grid's own cookie, on the grid's own origin: its pages and CSRF forms
    Session,
    /// `i:<box id>`: a sign-in at one box's or computer's own address, set from a one-time ticket
    Cookie,
    /// `p:<label>`: a preview's sign-in, for that label's preview addresses only
    Preview,
    /// a device token (`wgd_…`, RFC 8628): wisp on a computer or a phone
    Device,
    /// an API key (`wgk_…`): a script, for its user's own wisp
    Key,
    /// `Box <handle> <secret>`: the cloud wisp asking for itself
    Box,
    /// a sandbox's own bearer, for that sandbox's address
    Sandbox,
    /// a trigger's secret URL (POST /api/hooks/<token>): the wisp checks it
    Hook,
    /// an unguessable webhook path (/_in/<token>, /_route/<token>) or a provider's signature (/_mail/)
    Webhook,
}

impl Credential {
    pub const ALL: [Self; 9] = [
        Self::Session,
        Self::Cookie,
        Self::Preview,
        Self::Device,
        Self::Key,
        Self::Box,
        Self::Sandbox,
        Self::Hook,
        Self::Webhook,
    ];
}

/// Where a request goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
pub enum Reach {
    /// the grid's pages: account, devices, delete, sign out
    #[serde(rename = "grid:pages")]
    GridPages,
    /// /channels/route: giving the grid a bot to own (only here, never at <handle>/_grid/*)
    #[serde(rename = "grid:route-page")]
    GridRoutePage,
    /// the device API: /api/me, /api/device/link, /api/computers, /api/device/revoke
    #[serde(rename = "grid:device")]
    GridDevice,
    /// /api/keys: list, make and revoke API keys from a device
    #[serde(rename = "grid:keys")]
    GridKeys,
    /// /_grid/keys at the box's own address: the same, from the person's browser
    #[serde(rename = "edge:keys")]
    EdgeKeys,
    /// /api/channels/url, …/rotate, …/key: a channel's webhook for the box's own address
    #[serde(rename = "grid:channels")]
    GridChannels,
    /// /api/channels/mail/reply: answering a message the box accepted
    #[serde(rename = "grid:mail-reply")]
    GridMailReply,
    /// /api/channels/reply: a computer's report on a routed message
    #[serde(rename = "grid:report")]
    GridReport,
    /// /api/sites, /api/shares, /api/sandboxes: publishing from My Stuff, sharing, sandboxes
    #[serde(rename = "grid:publish")]
    GridPublish,
    /// GET /api/computers/<id>/tunnel: a computer holding its tunnel open
    #[serde(rename = "grid:tunnel")]
    GridTunnel,
    /// <handle>: the user's own wisp in its box
    #[serde(rename = "box")]
    Box,
    /// <name>--<handle>: a computer the user added, through its tunnel
    #[serde(rename = "computer")]
    Computer,
    /// sb-<id>--<handle>: a sandbox's box
    #[serde(rename = "sandbox")]
    Sandbox,
    /// p<port>--<label>: a page in a box or on a computer
    #[serde(rename = "preview")]
    Preview,
    /// /_in/<token>, /_mail/<provider>: held by the grid for the box
    #[serde(rename = "inbox")]
    Inbox,
    /// /_route/<token>: `on laptop`, read by the grid and sent to a computer
    #[serde(rename = "route")]
    Route,
}

impl Reach {
    pub const ALL: [Self; 16] = [
        Self::GridPages,
        Self::GridRoutePage,
        Self::GridDevice,
        Self::GridKeys,
        Self::EdgeKeys,
        Self::GridChannels,
        Self::GridMailReply,
        Self::GridReport,
        Self::GridPublish,
        Self::GridTunnel,
        Self::Box,
        Self::Computer,
        Self::Sandbox,
        Self::Preview,
        Self::Inbox,
        Self::Route,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::GridPages => "grid:pages",
            Self::GridRoutePage => "grid:route-page",
            Self::GridDevice => "grid:device",
            Self::GridKeys => "grid:keys",
            Self::EdgeKeys => "edge:keys",
            Self::GridChannels => "grid:channels",
            Self::GridMailReply => "grid:mail-reply",
            Self::GridReport => "grid:report",
            Self::GridPublish => "grid:publish",
            Self::GridTunnel => "grid:tunnel",
            Self::Box => "box",
            Self::Computer => "computer",
            Self::Sandbox => "sandbox",
            Self::Preview => "preview",
            Self::Inbox => "inbox",
            Self::Route => "route",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Deny {
    pub reach: Reach,
    pub why: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CapabilitySet {
    pub credential: Credential,
    pub allow: &'static [Reach],
    pub deny: &'static [Deny],
}

const fn deny(reach: Reach, why: &'static str) -> Deny {
    Deny { reach, why }
}

const PREVIEW_ONLY: &str = "a preview cookie is good for its own label’s preview addresses only";
const KEY_OWN: &str = "a key reaches none of the grid’s own API";
const KEYS_IN_BROWSER: &str = "API keys are made from Settings, in a browser";

use Reach as R;

/// The table. Changing a row is a deliberate act in the PR (`tests/trust.rs` pins it).
pub const CAPABILITIES: [CapabilitySet; 9] = [
    CapabilitySet {
        credential: Credential::Session,
        allow: &[R::GridPages, R::GridRoutePage],
        deny: &[],
    },
    CapabilitySet {
        credential: Credential::Cookie,
        allow: &[R::Box, R::Computer, R::Sandbox, R::EdgeKeys],
        deny: &[deny(
            R::Preview,
            "a preview link, which anything on a box can ask for, must never become a session anywhere else, and the reverse",
        )],
    },
    CapabilitySet {
        credential: Credential::Preview,
        allow: &[R::Preview],
        deny: &[
            deny(R::Box, PREVIEW_ONLY),
            deny(R::Computer, PREVIEW_ONLY),
            deny(R::Sandbox, PREVIEW_ONLY),
        ],
    },
    CapabilitySet {
        credential: Credential::Device,
        allow: &[
            R::GridDevice,
            R::GridKeys,
            R::GridReport,
            R::GridPublish,
            R::GridTunnel,
            R::Box,
            R::Computer,
            R::Sandbox,
        ],
        deny: &[
            deny(
                R::GridChannels,
                "a channel’s URL and key are the box’s own word, for its own address",
            ),
            deny(R::EdgeKeys, KEYS_IN_BROWSER),
        ],
    },
    CapabilitySet {
        credential: Credential::Key,
        allow: &[R::Box],
        deny: &[
            deny(
                R::Computer,
                "a key opens its user’s own wisp, never a computer",
            ),
            deny(
                R::Sandbox,
                "a key opens its user’s own wisp, never a sandbox",
            ),
            deny(
                R::Preview,
                "a key opens its user’s own wisp, never a preview",
            ),
            deny(
                R::GridTunnel,
                "a key opens its user’s own wisp, never a tunnel",
            ),
            deny(R::GridDevice, KEY_OWN),
            deny(R::GridKeys, "a key can’t manage keys"),
            deny(R::EdgeKeys, KEYS_IN_BROWSER),
            deny(R::GridPublish, KEY_OWN),
        ],
    },
    CapabilitySet {
        credential: Credential::Box,
        allow: &[R::GridChannels, R::GridMailReply, R::GridPublish],
        deny: &[
            deny(
                R::Computer,
                "a box never gets a token for a laptop: anything on a box can read its Box secret, and a prompt injection in a box must never reach a laptop",
            ),
            deny(
                R::GridReport,
                "anything on a box can read its Box secret, so it never gets as far as a computer’s report",
            ),
            deny(
                R::GridTunnel,
                "anything on a box can read its Box secret, so it can never be a computer",
            ),
            deny(
                R::GridKeys,
                "anything on a box can read its Box secret: a cloud wisp’s person makes keys at its edge (/_grid/keys)",
            ),
            deny(
                R::GridDevice,
                "anything on a box can read its Box secret: no sign-in links, no computers",
            ),
            deny(
                R::GridRoutePage,
                "the bot for `on laptop` is given on the grid’s own origin, out of a box page’s reach",
            ),
        ],
    },
    CapabilitySet {
        credential: Credential::Sandbox,
        allow: &[R::Sandbox],
        deny: &[
            deny(
                R::GridPublish,
                "a sandbox has neither a device token nor a Box secret",
            ),
            deny(R::Box, "a sandbox’s token opens that sandbox only"),
            deny(R::Computer, "a sandbox’s token opens that sandbox only"),
        ],
    },
    CapabilitySet {
        credential: Credential::Hook,
        allow: &[R::Box],
        deny: &[],
    },
    CapabilitySet {
        credential: Credential::Webhook,
        allow: &[R::Inbox, R::Route],
        deny: &[deny(
            R::Box,
            "a channel’s message is held by the grid and delivered; it never signs in to the box",
        )],
    },
];

pub fn capabilities(c: Credential) -> &'static CapabilitySet {
    // CAPABILITIES is in Credential's order; the fallback is unreachable but keeps this panic-free.
    CAPABILITIES
        .iter()
        .find(|s| s.credential == c)
        .unwrap_or(&CAPABILITIES[0])
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    No(String),
}

impl Verdict {
    pub fn ok(&self) -> bool {
        matches!(self, Self::Ok)
    }
}

/// Whether a caller holding `credential` may reach `reach`. Deny beats allow; anything unnamed is denied.
pub fn may(credential: Credential, reach: Reach) -> Verdict {
    let set = capabilities(credential);
    if let Some(d) = set.deny.iter().find(|d| d.reach == reach) {
        return Verdict::No(d.why.to_owned());
    }
    if set.allow.contains(&reach) {
        return Verdict::Ok;
    }
    let name = serde_json::to_value(credential)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default();
    Verdict::No(format!("{name} doesn’t reach {}", reach.name()))
}

mod marks;
pub use marks::*;
