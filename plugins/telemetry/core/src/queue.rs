//! The client's state (v1 `Telemetry`), with time and ids passed in: the stats queue (flushed every 15 s
//! or at 50; a failed flush is dropped, telemetry never gets in the way), the queue kept at shutdown or on
//! a crash for the next start (`pending`), and the feedback outbox (offline feedback waits for the next
//! feedback or the next start).

use serde_json::{Value, json};

use crate::env::{Env, FEEDBACK_MAX, MAX_QUEUE, OUTBOX_MAX, PENDING_MAX, env_disabled, feedback_available};
use crate::events::{ErrorInfo, Props, event, exception_props};
use crate::scrub::ScrubOptions;
use crate::text::slice_utf16;

#[derive(Debug, Clone)]
pub struct Telemetry {
    pub env: Env,
    pub common: Props,
    pub scrub: ScrubOptions,
    /// the Settings switch is not "off"
    pub setting_on: bool,
    /// random per install, not tied to the machine or user; made on the first event
    pub install_id: Option<String>,
    pub queue: Vec<Value>,
}

/// What `track` asks the host to do next.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tracked {
    /// off: nothing queued
    Off,
    Queued,
    /// queued, and the queue is full: flush now
    Flush,
}

impl Telemetry {
    pub fn new(env: Env, common: Props, scrub: ScrubOptions) -> Self {
        Self { env, common, scrub, setting_on: true, install_id: None, queue: Vec::new() }
    }

    pub fn enabled(&self) -> bool {
        !env_disabled(&self.env) && self.setting_on
    }

    pub fn feedback_available(&self) -> bool {
        feedback_available(&self.env)
    }

    /// Counts an event. `new_id` makes the install id the first time (the host saves it).
    pub fn track(&mut self, name: &str, props: Props, now_ms: i64, new_id: impl FnOnce() -> String) -> Tracked {
        if !self.enabled() {
            return Tracked::Off;
        }
        let id = self.install_id.get_or_insert_with(new_id).clone();
        self.queue.push(event(name, now_ms, &self.common, props, &id));
        if self.queue.len() >= MAX_QUEUE { Tracked::Flush } else { Tracked::Queued }
    }

    pub fn capture_error(&mut self, err: &ErrorInfo, props: Props, now_ms: i64, new_id: impl FnOnce() -> String) -> Tracked {
        if !self.enabled() {
            return Tracked::Off;
        }
        let props = exception_props(err, props, &self.scrub);
        self.track("$exception", props, now_ms, new_id)
    }

    /// A crash: captured unhandled, then the whole queue is what to keep for the next start.
    pub fn crashed(&mut self, err: &ErrorInfo, now_ms: i64, new_id: impl FnOnce() -> String) -> Vec<Value> {
        if !self.enabled() {
            return Vec::new();
        }
        let mut props = Props::new();
        props.insert("handled".into(), json!(false));
        props.insert("type".into(), json!(err.name.clone().filter(|n| !n.is_empty()).unwrap_or_else(|| "UncaughtException".into())));
        self.capture_error(err, props, now_ms, new_id);
        self.persist()
    }

    /// The queue as one batch to post; it is gone either way.
    pub fn drain(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.queue)
    }

    /// Shutdown leaves no time for a request: what's queued, to keep for the next start.
    pub fn persist(&mut self) -> Vec<Value> {
        let mut q = self.drain();
        let cut = q.len().saturating_sub(PENDING_MAX);
        q.drain(..cut);
        q
    }

    /// At start: last run's queue joins this one, unless stats are off by then (then it's dropped).
    pub fn restore(&mut self, pending: Vec<Value>) {
        if self.enabled() {
            let cut = pending.len().saturating_sub(PENDING_MAX);
            self.queue.extend(pending.into_iter().skip(cut));
        }
    }

    /// A rating on a turn (`turn_rated`) or a written note (`feedback`), as the batch to post: what waited
    /// in the outbox, then this one, the last 100. None when feedback can't go out. With usage stats off,
    /// `one_off` is the id (a fresh one per message, so feedback can't be tied to anything else).
    pub fn feedback(&self, name: &str, mut props: Props, outbox: &[Value], now_ms: i64, one_off: String) -> Option<Vec<Value>> {
        if !self.feedback_available() {
            return None;
        }
        let id = self.install_id.clone().filter(|_| self.enabled()).unwrap_or(one_off);
        if let Some(t) = props.get("text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            let t = if self.scrub.home.is_empty() { t.to_owned() } else { t.replace(&self.scrub.home, "~") };
            props.insert("text".into(), json!(slice_utf16(&t, FEEDBACK_MAX)));
        } else {
            props.remove("text");
        }
        let mut batch: Vec<Value> = outbox.to_vec();
        batch.push(event(name, now_ms, &self.common, props, &id));
        let cut = batch.len().saturating_sub(OUTBOX_MAX);
        batch.drain(..cut);
        Some(batch)
    }
}
