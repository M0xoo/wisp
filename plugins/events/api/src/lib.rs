//! wisp-events-api: the contract of `wisp.events` (ADR-0044), the durable event log seen from outside the
//! process: `events.tail` (the CLI, MCP `wisp_events`, the SDK), `events.why` (a chain of causes),
//! `events.retry` and `events.parked` (what a subscription gave up on), `events.ls` (the catalogue from
//! every manifest's `contributes.events`), the `events:<glob>` topic, and `events.sink@1`: where matching
//! durable events are forwarded (a signed webhook ships here; ntfy, Slack and others are plugins).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;
use wisp_kernel::{BoxFuture, Command, Point, Result};

pub const PLUGIN: &str = "wisp.events";
/// The setting holding the sinks: `[{ name, kind: "webhook", url, match, secret? }]`.
pub const SINKS: &str = "events.sinks";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "events/")]
pub struct TailArgs {
    /// a type or glob (`pr.*`); every type when left out
    #[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
    pub ty: Option<String>,
    /// what it's about (a task id)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subject: Option<String>,
    /// after this seq
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
    /// at most this many (100 by default, 1000 at most)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events/")]
pub struct SeqArgs {
    pub seq: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events/")]
pub struct NameArgs {
    pub name: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events/")]
pub struct NoArgs {}

/// One sink, as configured in the `events.sinks` setting.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "events/")]
pub struct SinkConfig {
    pub name: String,
    /// `webhook`, or a sink plugin's kind
    pub kind: String,
    #[serde(default)]
    pub url: String,
    /// the types it takes (a glob; `*` for all)
    #[serde(default = "all", rename = "match")]
    pub matches: String,
    /// the name of the secret it signs with (`wisp secret set <name>`); unsigned when left out
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// waits between tries (ms): 1 s, 5 s, 30 s by default
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backoff_ms: Option<Vec<u64>>,
    /// events in a row that failed every try before it pauses (5 by default)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_after: Option<u32>,
}

fn all() -> String {
    "*".into()
}

/// `events.sink@1`: a way to send a durable event somewhere. `send` is one try; the host retries, backs off
/// and pauses.
pub trait EventSink: Send + Sync + 'static {
    fn kind(&self) -> &'static str;
    /// `event` as `wisp events tail --json` shows it; `secret` the sink's signing secret, if it has one
    fn send(&self, cfg: SinkConfig, event: Value, secret: Option<String>) -> BoxFuture<'static, Result<()>>;
}

pub const SINK: Point<dyn EventSink> = Point::new("events.sink", 1);

macro_rules! command {
    ($name:ident = $id:literal $(read $ro:ident)? : $args:ty => $out:ty) => {
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            type Out = $out;
            fn args_ts() -> Option<String> {
                Some(<$args as ::ts_rs::TS>::inline(&::ts_rs::Config::default()))
            }
        }
    };
}

command!(Tail = "events.tail" read yes : TailArgs => Value);
command!(Why = "events.why" read yes : SeqArgs => Value);
command!(Retry = "events.retry" : SeqArgs => Value);
command!(ParkedCmd = "events.parked" read yes : NoArgs => Value);
command!(Ls = "events.ls" read yes : NoArgs => Value);
command!(Sinks = "events.sinksStatus" read yes : NoArgs => Value);
command!(Resume = "events.resume" : NameArgs => Value);
