//! wisp-settings-api: the contract of wisp.settings (plan §3.1 rule 8: one config system). Settings are
//! declared in each plugin's manifest; the kernel keeps the registry (validation, locks, watchers) and
//! saves server settings through the store. This plugin is the user's way in: list, read and write them,
//! and v1's `GET`/`PATCH /config` over the same values.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{Command, SettingInfo};

pub const PLUGIN_ID: &str = "wisp.settings";
/// The user's IANA time zone, sent by the client (what wisp.later writes times in).
pub const TIME_ZONE: &str = "settings.timeZone";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyArgs {
    pub key: String,
}

/// `value: null` resets it to its default.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct SetArgs {
    pub key: String,
    #[serde(default)]
    pub value: Value,
}

#[derive(Debug)]
pub struct List;
impl Command for List {
    const ID: &'static str = "settings.list";
    const PERMISSION: Option<&'static str> = Some("settings:read");
    const READ_ONLY: bool = true;
    type Args = Value;
    type Out = Vec<SettingInfo>;
}

#[derive(Debug)]
pub struct Get;
impl Command for Get {
    const ID: &'static str = "settings.get";
    const PERMISSION: Option<&'static str> = Some("settings:read");
    const READ_ONLY: bool = true;
    type Args = KeyArgs;
    type Out = Value;
    fn args_ts() -> Option<String> {
        Some("{ \n/**\n * the setting's key (`wisp settings list`)\n */\nkey: string, }".into())
    }
}

#[derive(Debug)]
pub struct Set;
impl Command for Set {
    const ID: &'static str = "settings.set";
    const PERMISSION: Option<&'static str> = Some("settings:write");
    type Args = SetArgs;
    type Out = SettingInfo;
    fn args_ts() -> Option<String> {
        Some("{ \n/**\n * the setting's key (`wisp settings list`)\n */\nkey: string, \n/**\n * its new value: JSON, or a word; `null` resets it to its default\n */\nvalue: unknown, }".into())
    }
}

/// v1's `config.defaults` names for the settings that kept them, and the key each is now.
pub const V1_ALIASES: &[(&str, &str)] = &[
    ("timeZone", TIME_ZONE),
    ("review", "review.harness"),
    ("panes", "stuff.panes"),
    ("worktreeCleanup", "worktrees.cleanup"),
    ("worktreeMax", "worktrees.max"),
    ("worktreeOnDone", "worktrees.onDone"),
];

/// The setting a v1 `defaults` name stands for, or the name itself when it is already a key.
pub fn key_of(v1: &str) -> &str {
    V1_ALIASES.iter().find(|(a, _)| *a == v1).map_or(v1, |(_, k)| *k)
}
