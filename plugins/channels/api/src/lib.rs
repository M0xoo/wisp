//! wisp-channels-api: the contract of `wisp.channels`, the hub every way of reaching wisp from outside
//! goes through (ntfy, Telegram, Slack, Discord, GitHub, email, the grid's routed messages). The hub
//! owns the config, the public API, the fan-out and what a message may do; a transport contributes
//! into [`TRANSPORTS`] and owns only its wire. Shared pure code (policy, grammar, lists, the
//! conversation flow) is in `wisp-channels-core`.

/// Pure policy, scrubbing and secret redaction every transport uses (moved from wisp-channels-core so a transport
/// plugin reaches them through this api, as the layers require).
pub mod policy;
pub mod scrub;
pub mod secrets;
pub mod hub;
pub mod transport;
pub mod views;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wisp_kernel::{Command, Event};

pub use hub::{
    AwayEntry, BoxApi, BoxGrid, ChannelHub, ChannelUrl, Exec, ExecOut, HttpRequest, HttpResponse,
    Later, Net, NetError, Phone, Ws, WsConn, WsFrame,
};
pub use transport::{
    Headers, InboundOpts, InboundResult, Status, TRANSPORTS, Transport, TransportDef,
    TransportKind, enabled_key, header,
};
pub use views::*;

pub const PLUGIN: &str = "wisp.channels";
/// The topic Settings → Notifications watches.
pub const TOPIC: &str = "plugin:wisp.channels:remote";
/// v1 `defaults.acceptChannels`: `on` takes tasks the grid routes here.
pub const SETTING_ACCEPT: &str = "channels.acceptChannels";

macro_rules! command {
    ($ty:ident, $id:literal, $args:ty, $out:ty $(, read_only = $ro:literal)?) => {
        #[derive(Debug)]
        pub struct $ty;
        impl Command for $ty {
            const ID: &'static str = $id;
            $(const READ_ONLY: bool = $ro;)?
            type Args = $args;
            type Out = $out;
        }
    };
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Empty {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SendArgs {
    pub msg: Msg,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Sent {
    pub sent: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifyArgs {
    pub session_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<SummaryView>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Line {
    pub line: String,
}

/// A message the grid held for this cloud wisp (`POST /api/channels/inbound`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct InboundArgs {
    pub channel: String,
    #[serde(default)]
    pub headers: Headers,
    /// the raw body, base64: the channel's signature is over these exact bytes
    pub body: String,
    /// when the grid took it, ms
    #[serde(default)]
    pub at: i64,
    /// messages the grid lost for this channel before this one
    #[serde(default)]
    pub dropped: u32,
    /// the grid's delivery mark was present and good
    #[serde(default)]
    pub verified: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct HttpOut {
    pub status: u16,
    pub body: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelArg {
    pub channel: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExtraArgs {
    pub channel: String,
    pub what: String,
}

command!(View, "channels.view", Empty, Value, read_only = true);
command!(Update, "channels.update", Value, Value);
command!(Test, "channels.test", Empty, Value);
command!(SendNotice, "channels.send", SendArgs, Sent);
command!(Notify, "channels.notify", NotifyArgs, Empty);
command!(Act, "channels.act", ActArgs, Line);
command!(Inbound, "channels.inbound", InboundArgs, HttpOut);
command!(Routed, "channels.routed", Value, HttpOut);
command!(Rotate, "channels.rotate", ChannelArg, HttpOut);
command!(Extra, "channels.extra", ExtraArgs, Value, read_only = true);
command!(Refresh, "channels.refresh", Empty, Empty);

/// Settings should look again.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Changed {}
impl Event for Changed {
    const TYPE: &'static str = "channels.changed";
}

/// A task began from a channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedFrom {
    pub session_id: String,
    pub channel: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by: Option<String>,
}
impl Event for StartedFrom {
    const TYPE: &'static str = "channels.started";
}

/// Every command id this plugin answers, for the manifest test and the capability sets.
pub const COMMANDS: &[&str] = &[
    View::ID,
    Update::ID,
    Test::ID,
    SendNotice::ID,
    Notify::ID,
    Act::ID,
    Inbound::ID,
    Routed::ID,
    Rotate::ID,
    Extra::ID,
    Refresh::ID,
];
