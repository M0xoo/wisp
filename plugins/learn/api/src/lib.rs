//! wisp.learn contract (v1 server/preferences.js): what wisp learns about how you work. Two lists, each kept
//! for every project (`global`) and per project (its folder): **preferences** (how you want agents to work)
//! and **lessons** (a mistake and the way that worked). A retro run reads a quiet task and updates them; the
//! lists ride along in later tasks' system prompts. Off with the `learn.enabled` setting.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::Command;

pub const PLUGIN_ID: &str = "wisp.learn";
/// v1 `defaults.learn` ('off' turned it off)
pub const SETTING_ON: &str = "learn.enabled";
pub const PERM_READ: &str = "learn:read";
pub const PERM_WRITE: &str = "learn:write";
/// The scope every project shares.
pub const GLOBAL: &str = "global";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "learn/")]
pub enum Kind {
    Preferences,
    Lessons,
}

impl Kind {
    pub const ALL: [Kind; 2] = [Kind::Preferences, Kind::Lessons];
}

/// One scope's lists.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "learn/")]
pub struct Lists {
    #[serde(default)]
    pub preferences: Vec<String>,
    #[serde(default)]
    pub lessons: Vec<String>,
    #[serde(default)]
    #[ts(type = "number")]
    pub updated_at: i64,
}

impl Lists {
    pub fn get(&self, k: Kind) -> &[String] {
        match k {
            Kind::Preferences => &self.preferences,
            Kind::Lessons => &self.lessons,
        }
    }
    pub fn get_mut(&mut self, k: Kind) -> &mut Vec<String> {
        match k {
            Kind::Preferences => &mut self.preferences,
            Kind::Lessons => &mut self.lessons,
        }
    }
    pub fn is_empty(&self) -> bool {
        self.preferences.is_empty() && self.lessons.is_empty()
    }
}

/// An item a retro added or removed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "learn/")]
pub struct Change {
    pub text: String,
    pub kind: Kind,
    /// `global` or `project`
    pub scope: String,
}

/// One retro run, for Settings → Learning (v1 keeps the last 30).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "learn/")]
pub struct Retro {
    pub id: String,
    pub session_id: String,
    pub title: String,
    pub project: String,
    pub agent: String,
    /// the turns it read
    pub turns: u32,
    #[ts(type = "number")]
    pub at: i64,
    /// `learned`, `nothing` or `failed`
    pub status: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<Change>>", optional)]
    pub added: Vec<Change>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    #[ts(as = "Option<Vec<Change>>", optional)]
    pub removed: Vec<Change>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

/// `learn.view`: every list and the recent retros.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "learn/")]
pub struct View {
    pub global: Lists,
    /// by project folder
    pub projects: BTreeMap<String, Lists>,
    /// newest last
    pub history: Vec<Retro>,
    pub enabled: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "learn/")]
pub struct Empty {}

/// `learn.set` (v1 PUT /preferences): your edit of one list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "learn/")]
pub struct SetArgs {
    /// `global` or a project folder
    pub scope: String,
    pub kind: Kind,
    pub items: Vec<String>,
}

/// `learn.retro`: read this task now, without waiting for it to go quiet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "learn/")]
pub struct RetroArgs {
    pub id: String,
}

macro_rules! command {
    ($(#[$m:meta])* $name:ident = $id:literal [$perm:expr] : $args:ty => $out:ty $(, $ro:ident)?) => {
        $(#[$m])*
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some($perm);
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            type Out = $out;
        }
    };
}

command!(
    /// Every list and the recent retros (v1 GET /preferences).
    Read = "learn.view" [PERM_READ] : Empty => View, read_only
);
command!(
    /// Replace one list (v1 PUT /preferences): cleaned, deduped and capped.
    Set = "learn.set" [PERM_WRITE] : SetArgs => Lists
);
command!(
    /// A retro of this task now.
    RunRetro = "learn.retro" [PERM_WRITE] : RetroArgs => Retro
);

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_list_reads_and_writes_by_kind() {
        let mut l = Lists::default();
        l.get_mut(Kind::Lessons).push("Run tests with cargo test -p x".into());
        assert_eq!(l.get(Kind::Lessons).len(), 1);
        assert!(!l.is_empty());
        assert_eq!(serde_json::to_value(Kind::Preferences).unwrap(), "preferences");
    }
}
