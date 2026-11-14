//! Settings → Phone's commands (F-chan-13, v1 `GET/PUT /api/remote`, `POST /api/remote/test`): each channel's
//! state in one list (`channels.status`), one channel's setup saved (`channels.setup`: its secrets go to
//! `~/.wisp/secrets.json` and its `channel` resource names them as `${secret:…}`), and a test through its
//! transport (`channels.test`).
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// The channels Settings → Phone sets up, in its order.
pub const PHONE_ORDER: [&str; 6] = ["ntfy", "telegram", "slack", "discord", "github", "email"];

/// One channel's setup to save. What's left out stays as it was.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct SetupArgs {
    /// ntfy | telegram | slack | discord | github | email
    pub transport: String,
    /// switch it on or off
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub enabled: Option<bool>,
    /// its secrets by field (ntfy `token`; Telegram `token`; Slack `appToken`, `botToken`, `signingSecret`; Discord
    /// `token`, `publicKey`), kept in secrets.json only; an empty one is removed
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub secrets: BTreeMap<String, String>,
    /// its plain settings (ntfy `topic`, `server`; Telegram `allowStart`; GitHub `publicReports`; email `sender`)
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    #[ts(type = "Record<string, string | boolean>")]
    pub settings: BTreeMap<String, Value>,
}

/// Where a channel stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum SetupState {
    /// switched off
    Off,
    /// on, but a field it needs isn't filled in (`missing`)
    Incomplete,
    /// on and set up; no answer from its service yet
    Checking,
    /// on and working, waiting for someone to send the link code
    Linking,
    /// on and working
    Connected,
    /// on, and its service said no (`error`)
    Failing,
}

/// One channel as Settings → Phone shows it. Secrets show only as saved or not, never their values.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ChannelSetup {
    pub transport: String,
    /// a plugin serves it on this wisp
    pub installed: bool,
    pub enabled: bool,
    pub state: SetupState,
    /// the secret fields that are saved
    pub saved: Vec<String>,
    /// its plain settings
    #[ts(type = "Record<string, string | boolean>")]
    pub settings: BTreeMap<String, Value>,
    /// the fields it still needs before it can work
    pub missing: Vec<String>,
    /// what its service said last, when it said no
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
    /// the code a person sends the bot to link their chat (Telegram `/link 123456`, Slack and Discord `link 123456`)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub link_code: Option<String>,
    /// chats or people linked
    pub linked: u32,
    /// the chat it's linked to (Telegram), or this cloud wisp's secret address (email)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub who: Option<String>,
}

/// Every channel Settings → Phone sets up.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PhoneStatus {
    /// this wisp is a cloud computer (Slack and Discord take a signing secret or public key; email is offered)
    pub cloud: bool,
    pub channels: Vec<ChannelSetup>,
}

/// Which channel to test (none: every one that's on).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct TestArgs {
    /// ntfy, telegram, …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub channel: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum TestOutcome {
    /// the test message went out
    Sent,
    /// it didn't (`error` says why)
    Failed,
    /// a channel that only answers where it's asked (Slack, Discord, GitHub, email): there's nowhere to send a
    /// message nobody asked for, so try it from there
    Unprompted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Tested {
    pub channel: String,
    pub outcome: TestOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}
