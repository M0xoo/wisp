//! wisp.telemetry: anonymous usage stats (v1 server/telemetry.js, services/telemetry.js), as ADR-0021
//! has it: this plugin owns the pipeline (the catalogue, opt-out, scrubbing, the queue, the install's
//! distinct id) and hands batches to every `telemetry.sink@1`. It names no vendor: `wisp.posthog` is
//! one sink. Events come from the plugin that owns the fact (`telemetry.track`), or from kernel events
//! where v1 tracked on the runner's (`turn.started` → `turn_started`, and `turn.ended` → `turn_ended` as a
//! durable subscriber, ADR-0044).
//!
//! Nothing here blocks: a flush runs every 15 s (or at 50 events) off the caller's way, each sink in its
//! own task with a 3 s budget; a batch a sink doesn't take is dropped (v1: telemetry never gets in the
//! way).
//!
//! resources: data-only (its rows are ids and the send queue; a formula never sets telemetry (ADR-0028)).

use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

use serde_json::{Map, Value, json};
use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_router_api::commands as router;
use wisp_router_api::types::{Feedback, Signals};
use wisp_runtime_api::commands as r;
use wisp_runtime_api::events::{TurnEnded, TurnStarted};
use wisp_runtime_api::{SessionId, TurnId};
use wisp_store::{Col, EntityDef, Migration, Query, Row, Store};
use wisp_telemetry_api::{self as api, SINK, TelemetryEvent};
use wisp_telemetry_core::env::{FLUSH_MS, TIMEOUT_MS};
use wisp_telemetry_core::turns::{ended_props, started_props};
use wisp_telemetry_core::{Common, Env, ScrubOptions, Telemetry, Tracked};

mod facts;
use facts::facts;

const MIGRATIONS: &[Migration] = &[
    Migration::sql(1, "CREATE TABLE telemetry_meta (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;"),
    Migration::sql(
        2,
        "CREATE TABLE telemetry_state (id TEXT PRIMARY KEY, \"on\" INTEGER NOT NULL, setting INTEGER NOT NULL, blocked INTEGER NOT NULL) STRICT;",
    ),
];

/// Settings → Privacy reads one row, id `this`: stats on, the switch, and whether the environment turns them off.
pub const STATE_TOPIC: &str = "plugin:wisp.telemetry:state";
const STATE: EntityDef = EntityDef {
    kind: "telemetry.state",
    table: "telemetry_state",
    key: "id",
    columns: &[("id", Col::Text), ("on", Col::Bool), ("setting", Col::Bool), ("blocked", Col::Bool)],
    json_columns: &[],
    parent: None,
    seq: None,
    topics: |_| vec![STATE_TOPIC.to_owned()],
};

/// The Privacy row: `on` only when the switch is on and nothing in the environment turns stats off.
pub fn state_row(setting: bool, env: &Env) -> Row {
    let blocked = wisp_telemetry_core::env::env_disabled(env);
    let mut r = Row::new();
    r.insert("id".into(), json!("this"));
    r.insert("on".into(), json!(setting && !blocked));
    r.insert("setting".into(), json!(setting));
    r.insert("blocked".into(), json!(blocked));
    r
}
const META: EntityDef = EntityDef {
    kind: "telemetry_meta",
    table: "telemetry_meta",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: |_| Vec::new(),
};

struct State {
    store: Store,
    t: Mutex<Telemetry>,
    /// feedback no sink took yet (v1 feedback-outbox.json): sent with the next one
    outbox: Mutex<Vec<Value>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

type Slot = Arc<OnceLock<Arc<State>>>;

fn state(slot: &Slot) -> Result<Arc<State>> {
    slot.get().cloned().ok_or_else(|| WireError::unavailable("wisp.telemetry is starting"))
}

fn now(ctx: &Ctx) -> i64 {
    ctx.clock().map_or(0, |c| c.now_ms())
}

impl State {
    async fn save(&self) {
        let (id, on, row) = {
            let t = lock(&self.t);
            (t.install_id.clone(), t.setting_on, state_row(t.setting_on, &t.env))
        };
        let outbox = lock(&self.outbox).clone();
        let body = json!({ "installId": id, "telemetry": if on { "on" } else { "off" }, "outbox": outbox });
        let _ = self
            .store
            .write(move |w| {
                let mut r = Row::new();
                r.insert("id".into(), json!("settings"));
                r.insert("body".into(), body);
                w.upsert(META.kind, r)?;
                w.upsert(STATE.kind, row).map(|_| ())
            })
            .await;
    }

    /// Queues `name` (catalogue keys only) and says it to watchers; a full queue flushes now.
    async fn track(&self, ctx: &Ctx, name: &str, props: Map<String, Value>) -> bool {
        let Some(e) = api::entry(name) else { return false };
        let props = api::allowed(e, props);
        let (tracked, new_id, last) = {
            let mut t = lock(&self.t);
            let had = t.install_id.is_some();
            let r = t.track(name, props, now(ctx), wisp_kernel::ids::uuid7);
            (r, !had && t.install_id.is_some(), t.queue.last().cloned())
        };
        if tracked == Tracked::Off {
            return false;
        }
        if new_id {
            self.save().await;
        }
        if let Some(ev) = last.and_then(|v| serde_json::from_value::<TelemetryEvent>(v).ok()) {
            ctx.emit(&ctx.root_call(), &ev);
        }
        if tracked == Tracked::Flush {
            self.flush(ctx);
        }
        true
    }

    /// Hands the queue to every sink, each on its own (a slow or failing one holds nothing up).
    fn flush(&self, ctx: &Ctx) -> usize {
        let batch = lock(&self.t).drain();
        if batch.is_empty() {
            return 0;
        }
        let n = batch.len();
        for sink in ctx.contributions(&SINK) {
            let b = batch.clone();
            ctx.spawn(async move {
                let id = sink.id().to_owned();
                if !matches!(tokio::time::timeout(Duration::from_millis(TIMEOUT_MS), sink.send(b)).await, Ok(true)) {
                    tracing::debug!(sink = %id, "telemetry batch dropped");
                }
            });
        }
        n
    }
}

/// v1 `sendFeedback`: checked, kept on its turn when it's thumbs (and told to Auto), then posted with what waited in
/// the outbox; what no sink took waits there for the next one.
async fn feedback(st: &State, ctx: &Ctx, call: &Call, body: &Value) -> Result<Value> {
    use wisp_telemetry_core::feedback::{self as fb, Context};
    let a = fb::parse(body).map_err(WireError::invalid)?;
    let facts = match (&a.session_id, &a.turn_id) {
        (Some(s), Some(t)) => facts(ctx, call, s, t).await,
        _ => None,
    };
    if let (Some(sid), Some(tid)) = (&a.session_id, &a.turn_id)
        && fb::sticks_to_turn(&a)
    {
        let rating = a.rating.and_then(fb::Rating::as_str);
        let value = json!({ "feedback": rating.map(|r| json!({ "rating": r, "at": now(ctx) })) });
        let ext = r::TurnExtArgs { id: SessionId(sid.clone()), turn_id: TurnId(tid.clone()), plugin: api::PLUGIN_ID.into(), value };
        ctx.run::<r::TurnSetExt>(call, ext).await?;
        // Auto learns from it (v1 router.signal): best effort, a task Auto didn't route has nothing to learn
        let feedback = match a.rating {
            Some(fb::Rating::Up) => Some(Feedback::Up),
            Some(fb::Rating::Down) => Some(Feedback::Down),
            Some(fb::Rating::Clear) | None => None,
        };
        let signal = router::SignalArgs { id: sid.clone(), patch: Signals { feedback: Some(feedback), ..Signals::default() } };
        if let Err(err) = ctx.run::<router::Signal>(call, signal).await {
            tracing::warn!(error = %err.message, task = %sid, "telemetry: router.signal");
        }
    }
    let (name, props) = fb::event(&a, &Context { run: facts.as_ref().map(|(r, t)| (r, t)), tour: false, machine: false });
    let outbox: Vec<Value> = lock(&st.outbox).clone();
    let batch = lock(&st.t).feedback(name, props, &outbox, now(ctx), wisp_kernel::ids::uuid7());
    let available = batch.is_some();
    let mut sent = false;
    if let Some(batch) = batch {
        for sink in ctx.contributions(&SINK) {
            sent |= matches!(tokio::time::timeout(Duration::from_millis(TIMEOUT_MS), sink.send(batch.clone())).await, Ok(true));
        }
        *lock(&st.outbox) = if sent { Vec::new() } else { batch };
        st.save().await;
    }
    Ok(json!({ "ok": true, "sent": sent, "available": available }))
}

fn env() -> Env {
    ["DO_NOT_TRACK", "WISP_TELEMETRY", "CI", "WISP_FEEDBACK", "WISP_DESKTOP", "WISP_GRID_URL"]
        .iter()
        .filter_map(|k| std::env::var(k).ok().map(|v| ((*k).to_owned(), v)))
        .collect()
}

/// The telemetry plugin. `env` is the environment it decides opt-out from (`DO_NOT_TRACK`, `WISP_TELEMETRY`,
/// `CI`, …): the process's by default, or a given one so a test runs the same on a CI box as on a laptop.
#[derive(Debug, Default)]
pub struct TelemetryPlugin {
    env: Option<Env>,
}

impl TelemetryPlugin {
    /// Decides from `env` instead of the process environment.
    #[must_use]
    pub fn with_env(env: Env) -> Self {
        Self { env: Some(env) }
    }
}

impl Plugin for TelemetryPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    #[allow(clippy::too_many_lines)] // the commands, the two turn events and the start, side by side
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let slot: Slot = Arc::new(OnceLock::new());
        let sl = slot.clone();
        s.command::<api::Track, _, _>(move |ctx, call, a| {
            let slot = sl.clone();
            async move {
                let st = state(&slot)?;
                // a call from the page may send only the UI's events, with their allowed values
                let ui = call.caller().set.starts_with("user") && call.caller().plugin.is_none() && call.depth() == 0;
                let props = if ui { api::ui_event(&a.event, &a.props) } else { Some(a.props) };
                let Some(props) = props else { return Ok(api::Tracked { queued: false }) };
                Ok(api::Tracked { queued: st.track(&ctx, &a.event, props).await })
            }
        });
        let sl = slot.clone();
        s.command::<api::Set, _, _>(move |_ctx, _call, a| {
            let slot = sl.clone();
            async move {
                let st = state(&slot)?;
                lock(&st.t).setting_on = a.on;
                if !a.on {
                    let _ = lock(&st.t).drain(); // what was queued goes too
                }
                st.save().await;
                Ok(a)
            }
        });
        let sl = slot.clone();
        s.command::<api::Flush, _, _>(move |ctx, _call, _a| {
            let slot = sl.clone();
            async move { Ok(api::Tracked { queued: state(&slot)?.flush(&ctx) > 0 }) }
        });
        let sl = slot.clone();
        s.command::<api::Feedback, _, _>(move |ctx, call, body| {
            let slot = sl.clone();
            async move { feedback(&*state(&slot)?, &ctx, &call, &body).await }
        });
        let sl = slot.clone();
        s.on::<TurnStarted, _, _>(move |ctx, e| {
            let slot = sl.clone();
            async move {
                let Ok(st) = state(&slot) else { return };
                let call = ctx.root_call();
                if let Some((r, t)) = facts(&ctx, &call, e.session_id.as_str(), e.turn_id.as_str()).await {
                    st.track(&ctx, "turn_started", started_props(&r, &t)).await;
                }
            }
        });
        let sl = slot.clone();
        // a durable fact (ADR-0044): telemetry is one more durable subscriber, so a restart loses no turn's end
        s.on_durable::<TurnEnded, _, _>("turn_ended", move |ctx, call, d| {
            let slot = sl.clone();
            async move {
                let wisp_kernel::durable::Durable::Event { event: e, .. } = d else { return Ok(()) };
                let Ok(st) = state(&slot) else { return Ok(()) };
                if let Some((r, t)) = facts(&ctx, &call, e.session_id.as_str(), e.turn_id.as_str()).await {
                    st.track(&ctx, "turn_ended", ended_props(&r, &t, e.interrupted)).await;
                }
                Ok(())
            }
        });
        let start = slot;
        let given = self.env.clone();
        s.on_start(move |ctx| async move {
            let store = ctx.service::<Store>()?.as_ref().clone();
            store.migrate("telemetry", MIGRATIONS).map_err(WireError::from)?;
            store.define_entity(META).map_err(WireError::from)?;
            store.define_entity(STATE).map_err(WireError::from)?;
            let saved = store.read_async(|r| r.query(META.kind, &Query::new())).await.map_err(WireError::from)?;
            let body = saved.first().and_then(|r| r.get("body").cloned()).unwrap_or(Value::Null);
            let e = given.unwrap_or_else(env);
            let common = Common {
                version: env!("CARGO_PKG_VERSION").into(),
                os: match std::env::consts::OS {
                    "macos" => "darwin".into(),
                    "windows" => "win32".into(),
                    o => o.into(),
                },
                os_release: None,
                arch: match std::env::consts::ARCH {
                    "x86_64" => "x64".into(),
                    "aarch64" => "arm64".into(),
                    a => a.into(),
                },
                node: std::env::var("WISP_NODE_VERSION").ok(),
                shell: wisp_telemetry_core::shell_of(&e).into(),
            };
            let home = std::env::var("HOME").unwrap_or_default();
            let mut t = Telemetry::new(
                e,
                common.props(),
                ScrubOptions {
                    home,
                    root: std::env::current_exe()
                        .ok()
                        .and_then(|p| p.parent().map(|d| d.to_string_lossy().into_owned()))
                        .unwrap_or_default(),
                },
            );
            t.install_id = body["installId"].as_str().map(str::to_owned);
            t.setting_on = wisp_telemetry_core::env::setting_on(body.get("telemetry"));
            let outbox = body["outbox"].as_array().cloned().unwrap_or_default();
            let st = Arc::new(State { store, t: Mutex::new(t), outbox: Mutex::new(outbox) });
            let _ = start.set(st.clone());
            st.save().await; // the Privacy row exists from the start
            // app_started: which harnesses are installed, and their versions (v1 index.js), off the start's way
            let (c3, st3) = (ctx.clone(), st.clone());
            ctx.spawn(async move {
                match c3.run::<r::Agents>(&c3.root_call(), r::AgentsArgs::default()).await {
                    Ok(agents) => {
                        let list: Vec<(String, Option<String>)> =
                            agents.into_iter().filter(|a| a.available).map(|a| (a.id, a.version)).collect();
                        st3.track(&c3, "app_started", wisp_telemetry_core::turns::app_started_props(&list)).await;
                    }
                    Err(err) => tracing::warn!(error = %err.message, "telemetry: runtime.agents (no app_started)"),
                }
            });
            if let Ok(clock) = ctx.clock() {
                let (scope, c2) = (ctx.scope().clone(), ctx.clone());
                ctx.spawn(async move {
                    loop {
                        tokio::select! {
                            () = scope.cancelled() => return,
                            () = clock.sleep(FLUSH_MS) => { st.flush(&c2); }
                        }
                    }
                });
            }
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The Privacy row: on with the switch on, off with it off, and off with the switch on when the
    /// environment says so (`DO_NOT_TRACK`, `WISP_TELEMETRY=0`, `CI`), with `blocked` saying why.
    #[test]
    fn the_privacy_row_says_on_off_and_blocked_by_the_environment() {
        let none: Env = Env::default();
        assert_eq!(state_row(true, &none)["on"], true);
        assert_eq!(state_row(false, &none)["on"], false);
        let dnt: Env = [("DO_NOT_TRACK".to_owned(), "1".to_owned())].into_iter().collect();
        let r = state_row(true, &dnt);
        assert_eq!((r["on"].clone(), r["setting"].clone(), r["blocked"].clone()), (json!(false), json!(true), json!(true)));
    }

    #[test]
    fn manifest_is_valid() {
        assert_eq!(TelemetryPlugin::default().manifest().id, "wisp.telemetry");
    }
}
