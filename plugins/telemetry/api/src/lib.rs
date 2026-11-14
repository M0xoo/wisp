//! wisp-telemetry-api: the contract of wisp.telemetry (ADR-0021). wisp.telemetry owns the pipeline
//! (the catalogue, opt-out, scrubbing, batching, the install's distinct id); sinks deliver it.
//!
//! - [`Track`]: record an event of the catalogue. A UI-originated call may only send the events (and
//!   property values) the catalogue allows the UI.
//! - [`TelemetryEvent`] (`telemetry.event`): each event as it was queued, after the opt-out check and
//!   scrubbing, for any plugin to watch.
//! - [`SINK`] (`telemetry.sink@1`): a list point. Every sink gets the same scrubbed batches; a failing
//!   or slow one never holds the others or the app up. `wisp.posthog` is one; no other plugin names a
//!   vendor.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use wisp_kernel::{BoxFuture, Command, Event, Point};

pub const PLUGIN_ID: &str = "wisp.telemetry";
pub const PERM_TRACK: &str = "telemetry:track";

/// One event of the catalogue: its name (v1's, `PostHog`'s dashboards use them), the plugin that owns
/// the fact, the property keys it may carry (`*Version`: any key ending so), and for UI-sent events the
/// values each property may take.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CatalogueEntry {
    pub name: String,
    pub owner: String,
    pub props: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ui: Option<Map<String, Value>>,
}

/// v1's 52 events (ADR-0021: adding one is an entry here and a golden).
pub fn catalogue() -> &'static [CatalogueEntry] {
    static C: std::sync::OnceLock<Vec<CatalogueEntry>> = std::sync::OnceLock::new();
    C.get_or_init(|| serde_json::from_str(include_str!("catalogue.json")).unwrap_or_default())
}

pub fn entry(name: &str) -> Option<&'static CatalogueEntry> {
    catalogue().iter().find(|e| e.name == name)
}

/// Only the catalogue's keys of `props` (a key it doesn't know is dropped, never sent).
pub fn allowed(e: &CatalogueEntry, props: Map<String, Value>) -> Map<String, Value> {
    props.into_iter().filter(|(k, _)| e.props.iter().any(|p| p == k || p.strip_prefix('*').is_some_and(|tail| k.ends_with(tail)))).collect()
}

/// What the UI may send: a UI event with only the allowed values (v1 `pageEvent`); None: dropped.
pub fn ui_event(name: &str, props: &Map<String, Value>) -> Option<Map<String, Value>> {
    let ui = entry(name)?.ui.as_ref()?;
    Some(
        ui.iter()
            .filter_map(|(k, vals)| props.get(k).filter(|v| vals.as_array().is_some_and(|a| a.contains(v))).map(|v| (k.clone(), v.clone())))
            .collect(),
    )
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TrackArgs {
    pub event: String,
    #[serde(default)]
    pub props: Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tracked {
    /// false: off (opted out, or an event the caller may not send)
    pub queued: bool,
}

#[derive(Debug)]
pub struct Track;
impl Command for Track {
    const ID: &'static str = "telemetry.track";
    const PERMISSION: Option<&'static str> = Some(PERM_TRACK);
    type Args = TrackArgs;
    type Out = Tracked;
}

/// Settings → Privacy → Usage stats (v1 `defaults.telemetry`: 'off' turns them off).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SetArgs {
    pub on: bool,
}

#[derive(Debug)]
pub struct Set;
impl Command for Set {
    const ID: &'static str = "telemetry.set";
    const PERMISSION: Option<&'static str> = Some("telemetry:set");
    type Args = SetArgs;
    type Out = SetArgs;
}

/// Sends what is queued now (tests, shutdown).
#[derive(Debug)]
pub struct Flush;
impl Command for Flush {
    const ID: &'static str = "telemetry.flush";
    const PERMISSION: Option<&'static str> = Some(PERM_TRACK);
    type Args = Value;
    type Out = Tracked;
}

/// POST /api/feedback (v1 services/feedback.js): thumbs on a turn (`rating` up, down or null to take it back, with
/// `sessionId` and `turnId`) and/or a note (`text`, `kind` bug or idea). It goes to the wisp team with how the run was
/// set up, never the prompt or the result; offline, it waits in the outbox. Answers `{ ok, sent, available }`.
/// Additive (2026-11-12).
#[derive(Debug)]
pub struct Feedback;
impl Command for Feedback {
    const ID: &'static str = "telemetry.feedback";
    const PERMISSION: Option<&'static str> = Some("telemetry:feedback");
    type Args = Value;
    type Out = Value;
}

/// An event as it was queued (scrubbed, common properties and the distinct id in).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TelemetryEvent {
    pub event: String,
    pub timestamp: String,
    pub properties: Map<String, Value>,
}

impl Event for TelemetryEvent {
    const TYPE: &'static str = "telemetry.event";
}

/// Where batches go. `send` answers true once the destination has them.
pub trait Sink: Send + Sync + 'static {
    fn id(&self) -> &'static str;
    fn send(&self, batch: Vec<Value>) -> BoxFuture<'static, bool>;
}

pub const SINK: Point<dyn Sink> = Point::new("telemetry.sink", 1);
