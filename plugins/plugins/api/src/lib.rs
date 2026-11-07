//! wisp-plugins-api: the contract of `wisp.plugins`, the plugin manager (Settings → Plugins; v1 called
//! them spells, plan §6.0). It lists, installs, switches on and off and removes the user's plugins:
//! folders with a `wisp-plugin.json` in `~/.wisp/plugins` (declarative or exec tier), and v1 `wispSpell`
//! files in `~/.wisp/spells`, which are converted to manifests and still load for two releases.
//!
//! Switching a plugin on or off inside the running kernel is the kernel's job: wisp.plugins asks it
//! through the [`PluginHostService`] (`kernel.plugins@1`), which the install provides.
//!
//! Wire names that agents and released clients read keep their v1 spelling on purpose: the
//! `/api/spells*` routes, the `spell` report block, the `wisp_spell_*` tools.

pub mod commands;
pub mod points;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

pub use commands::*;
pub use points::*;

pub const PLUGIN_ID: &str = "wisp.plugins";
/// The ext slot a Make a plugin task carries: `session.ext["wisp.plugins"] = { "make": true }`.
pub const EXT: &str = "wisp.plugins";
/// Rows are published on the kernel's config topic, beside the kernel's own plugin rows.
pub const TOPIC: &str = "config";
/// A converted spell's plugin id is `user.<spell id>`: spells were the user's own.
pub const SPELL_PREFIX: &str = "user.";

pub mod perm {
    pub const READ: &str = "plugins:read";
    pub const INSTALL: &str = "plugins:install";
    pub const WRITE: &str = "plugins:write";
    pub const OPEN: &str = "plugins:open";
    pub const MAKE: &str = "plugins:make";
    pub const FIRE: &str = "plugins:fire";
}

/// The plugin id a v1 spell becomes.
pub fn spell_plugin_id(spell_id: &str) -> String {
    format!("{SPELL_PREFIX}{spell_id}")
}

/// Is this row a converted spell or a plugin folder (or a built-in the user switched)?
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Spell,
    Plugin,
}

/// The riskiest thing a plugin can do, for the review badge: safe < acts < reads < runs.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize, TS, Default,
)]
#[serde(rename_all = "lowercase")]
pub enum Risk {
    #[default]
    Safe,
    Acts,
    Reads,
    Runs,
}

impl Risk {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "safe" => Some(Self::Safe),
            "acts" => Some(Self::Acts),
            "reads" => Some(Self::Reads),
            "runs" => Some(Self::Runs),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Safe => "safe",
            Self::Acts => "acts",
            Self::Reads => "reads",
            Self::Runs => "runs",
        }
    }
}

/// Plan §6.0.2: who wrote a plugin never decides what it may do; trust and permissions do.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum Trust {
    Declarative,
    Untrusted,
    Trusted,
}

impl Trust {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "declarative" => Some(Self::Declarative),
            "untrusted" => Some(Self::Untrusted),
            "trusted" => Some(Self::Trusted),
            _ => None,
        }
    }
}

/// Where an installed plugin came from (v1 spells.json `sources`): 'local', 'file', 'url', 'gist',
/// 'folder'. Unknown fields a v1 file carried are kept.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Source {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    #[serde(default)]
    pub at: i64,
}

impl Source {
    pub fn of(kind: &str) -> Self {
        Self {
            kind: kind.to_owned(),
            url: None,
            owner: None,
            name: None,
            session: None,
            at: 0,
        }
    }
}

/// One row of the plugin table: what v1 kept in `~/.wisp/spells.json`, per plugin.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct StateRow {
    /// the spell id for a spell ('my-prs'), the manifest id for a folder or built-in ('acme.thing')
    pub id: String,
    pub kind: Kind,
    pub enabled: bool,
    pub source: Option<Source>,
    pub at: i64,
    /// when it was last switched on: of two that set one setting, the later wins (v1's list order)
    pub on_at: i64,
}

/// A row of Settings → Plugins.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct PluginView {
    /// the id the kernel knows it by ('user.my-prs' for a spell)
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub kind: Kind,
    pub enabled: bool,
    pub builtin: bool,
    pub source: Option<Source>,
    /// what it does, in plain words
    pub summary: Vec<String>,
    pub risk: Risk,
    /// the kernel's state: 'active', 'resolved', 'off', 'refused', or 'unknown' without a kernel host
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub trust: Trust,
}

/// A file that couldn't be loaded, and why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Broken {
    pub id: String,
    pub error: String,
}

/// GET /api/plugins and /api/spells: v1's `{ safe, spells, broken }` plus the new `plugins` rows.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
pub struct ListOut {
    /// WISP_SAFE=1: every user plugin is off for this run
    pub safe: bool,
    pub plugins: Vec<PluginView>,
    /// v1 SpellView: the spell, plus enabled, source, hash, summary and kind
    #[ts(type = "Array<Record<string, unknown>>")]
    pub spells: Vec<Value>,
    pub broken: Vec<Broken>,
}

/// Who set a locked setting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LockedBy {
    pub id: String,
    pub name: String,
}
