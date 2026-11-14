//! `crew.share` (ADR-0052): members, or the whole crew, as a link, through wisp.share like every other kind (a grid
//! link with access, expiry and revoke); no GitHub token. What goes is `crew.export`'s bundle, refused while it holds
//! a secret. Additive (2026-11-13).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::Command;

/// Sharing the crew out: its own permission, so a member's job (and a capped task) can't put the crew on a link.
pub const PERM_SHARE: &str = "crew:share";

/// The kind wisp.share sends a crew as (`Outgoing.kind`).
pub const SHARE_KIND: &str = "crew";

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "crew/")]
pub struct ShareArgs {
    /// ids, names or handles; empty: the whole crew
    #[serde(default)]
    pub ids: Vec<String>,
    /// their kits go too (default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub kit: Option<bool>,
    /// their notebooks go too (default off)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub notebook: Option<bool>,
    /// the members they delegate to go too
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub team: Option<bool>,
    /// a password: only who has it opens the link (none: anyone with the link)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub password: Option<String>,
    /// when the link stops working (ms since the epoch)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional, type = "number")]
    pub expires_at: Option<i64>,
}

/// The link made: its url and the destination's view (`id`, `version`, `access`, …), and the export's notes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "crew/")]
pub struct SharedLink {
    pub url: String,
    pub members: u32,
    pub notes: Vec<String>,
    #[ts(type = "Record<string, unknown>")]
    pub link: Value,
}

/// `crew.share`
#[derive(Debug)]
pub struct Share;
impl Command for Share {
    const ID: &'static str = "crew.share";
    const PERMISSION: Option<&'static str> = Some(PERM_SHARE);
    type Args = ShareArgs;
    fn args_ts() -> Option<String> {
        Some(format!("{}{}", <ShareArgs as TS>::docs().unwrap_or_default(), <ShareArgs as TS>::inline(&ts_rs::Config::default())))
    }
    type Out = SharedLink;
}
