//! wisp.router host: Auto (v1 server/router.js, services/auto.js, routes/auto.js). The decisions are
//! `wisp-router-core`'s; this crate keeps the state, reads this computer's harnesses from
//! `runtime.agents`, and answers the six commands.
//!
//! The learned state and Settings → Auto live in router-owned store tables (`store.rs`); a change
//! writes the rows it touched in one transaction. v1's router.json and `defaults.router` are imported
//! once at start.

mod pipeline;
mod kind;
mod service;
mod store;

use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use serde_json::{Value, json};
use wisp_kernel::services::Paths;
use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_router_api::commands::{Ack, Preview, Record, Reset, Set, Signal, View};
use wisp_router_api::view::{PreviewArgs, RouterView, Settings};
use wisp_router_api::{AgentInfo, ChooseArgs, ModelInfo};
use wisp_router_core::{Mulberry32, Router, RouterState, auto, choose, report};

#[derive(Debug, Default)]
pub struct RouterPlugin;

struct State {
    router: Mutex<Router>,
    settings: Mutex<Settings>,
    store: OnceLock<wisp_store::Store>,
    /// this computer's harnesses at the last look, for `router.service`'s picks
    here: Mutex<Vec<AgentInfo>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl State {
    fn new() -> Self {
        Self { router: Mutex::new(Router::new(RouterState::default())), settings: Mutex::new(Settings::default()), store: OnceLock::new(), here: Mutex::default() }
    }

    /// The tables, v1's files once, then the state from the tables. At start, before any command.
    async fn open(&self, store: wisp_store::Store, home: Option<std::path::PathBuf>) -> std::result::Result<(), WireError> {
        store::install(&store).map_err(WireError::from)?;
        if let Some(h) = home {
            store::import_v1(&store, &h).await.map_err(WireError::from)?;
        }
        let (st, settings) = store::load(&store).await.map_err(WireError::from)?;
        *lock(&self.router) = Router::new(st);
        *lock(&self.settings) = settings;
        let _ = self.store.set(store);
        Ok(())
    }

    /// `view` written as the row Settings → Auto watches, then given back.
    async fn published(&self, v: RouterView) -> RouterView {
        if let Some(store) = self.store.get()
            && let Err(e) = store::publish(store, &v).await
        {
            tracing::warn!(error = %e, "router: publishing the view");
        }
        v
    }

    /// The rows the state marked dirty (and the settings, when they changed), in one transaction.
    async fn save(&self, settings: bool) {
        let Some(store) = self.store.get().cloned() else { return };
        let s = settings.then(|| lock(&self.settings).clone());
        let ops = {
            let mut r = lock(&self.router);
            let d = r.st.take_dirty();
            store::ops(&r.st, &d, s.as_ref())
        };
        let ops = match ops {
            Ok(o) if o.is_empty() => return,
            Ok(o) => o,
            Err(e) => return tracing::warn!(error = %e, "router: saving"),
        };
        if let Err(e) = store.write(move |w| ops.apply(w)).await {
            tracing::warn!(error = %e, "router: saving");
        }
    }
}

/// This computer's harnesses, as Auto sees them (from `runtime.agents`).
async fn agents(ctx: &Ctx, call: &Call) -> Vec<AgentInfo> {
    let list = ctx.run_json(call, "runtime.agents", json!({})).await.unwrap_or(Value::Null);
    list.as_array()
        .into_iter()
        .flatten()
        .map(|a| AgentInfo {
            id: a["id"].as_str().unwrap_or_default().to_owned(),
            name: a["name"].as_str().unwrap_or_default().to_owned(),
            available: a["available"].as_bool().unwrap_or(false),
            models: a["models"].as_array().into_iter().flatten().map(|m| ModelInfo { id: m["id"].as_str().unwrap_or_default().to_owned(), label: m["label"].as_str().map(str::to_owned), efforts: None }).collect(),
            efforts: a["efforts"].as_array().map(|e| e.iter().filter_map(Value::as_str).map(str::to_owned).collect()),
            delegates: a["delegates"].as_bool(),
            signed_in: a["signedIn"].as_bool(),
            version: a["version"].as_str().map(str::to_owned),
        })
        .collect()
}

fn now(ctx: &Ctx) -> i64 {
    ctx.clock().map_or(0, |c| c.now_ms())
}

fn view(st: &State, here: &[AgentInfo], projects: Vec<Value>, now: i64) -> RouterView {
    here.clone_into(&mut lock(&st.here));
    let s = lock(&st.settings).clone();
    let mut r = lock(&st.router);
    r.sync(here, false, now);
    let prefs = auto::prefs(&s, here);
    RouterView { goals: auto::goals(), goal: auto::goal_of(None, &s).to_owned(), settings: auto::settings_view(&s), projects, report: report::report(&r, here, &prefs, now) }
}

/// Tests per project: each declared project (`resources.export`'s `project` kind) with its test command.
pub fn project_rows(resources: &[Value]) -> Vec<Value> {
    resources
        .iter()
        .filter(|r| r.get("kind").and_then(Value::as_str) == Some("project"))
        .filter_map(|r| {
            let name = r.get("name").and_then(Value::as_str)?;
            let spec = r.get("spec").cloned().unwrap_or(Value::Null);
            let mut row = serde_json::json!({ "id": name, "name": name, "testCommand": spec.get("test").and_then(Value::as_str).unwrap_or_default() });
            if let Some(c) = spec.get("color").and_then(Value::as_str).filter(|c| !c.is_empty()) {
                row["color"] = Value::String(c.to_owned());
            }
            Some(row)
        })
        .collect()
}

async fn projects(ctx: &Ctx, call: &wisp_kernel::Call) -> Vec<Value> {
    let list = ctx.run_json(call, "resources.export", serde_json::json!({ "kinds": ["project"] })).await.ok();
    list.as_ref().and_then(Value::as_array).map(|a| project_rows(a)).unwrap_or_default()
}

/// The same prompt previews the same pick: the dice are seeded from it.
fn seed_of(prompt: &str) -> u32 {
    prompt.bytes().fold(0x811c_9dc5_u32, |h, b| (h ^ u32::from(b)).wrapping_mul(0x0100_0193))
}

fn preview(st: &State, here: &[AgentInfo], a: PreviewArgs, now: i64) -> wisp_router_api::view::PreviewResult {
    let s = lock(&st.settings).clone();
    let prefs = auto::prefs(&s, here);
    let prompt = a.prompt.unwrap_or_default();
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)] // a count of files
    let attachments = a.attachments.unwrap_or(0.0).max(0.0) as u32;
    let args = ChooseArgs { prompt: prompt.clone(), attachments, goal: a.goal, need_delegate: a.team.unwrap_or(false), preview: true, ..ChooseArgs::default() };
    let r = lock(&st.router);
    let pick = choose(&r.st, now, &args, here, &prefs, &mut Mulberry32::new(seed_of(&prompt)));
    auto::preview_of(pick, a.machine.as_deref().unwrap_or_default())
}

macro_rules! on {
    ($s:ident, $st:ident, $C:ty, |$state:ident, $ctx:ident, $call:ident, $a:ident| $body:expr) => {{
        let st = $st.clone();
        $s.command::<$C, _, _>(move |$ctx, $call, $a| {
            let $state = st.clone();
            async move { $body }
        });
    }};
}

impl Plugin for RouterPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        crate::pipeline::register_pipeline(s);
        let k: Arc<dyn wisp_resources_api::ResourceKind> = Arc::new(kind::RouterKind { ctx: s.ctx() });
        s.contribute(&wisp_resources_api::RESOURCE_KIND, k);
        let st = Arc::new(State::new());
        let svc: Arc<dyn wisp_router_api::service::RouterApi> = Arc::new(service::Svc { st: st.clone(), ctx: s.ctx() });
        s.provide::<wisp_router_api::service::RouterService>(svc);
        service::learn(s, &st);
        let opening = st.clone();
        s.on_start(move |ctx| async move {
            let store = ctx.service::<wisp_store::Store>()?.as_ref().clone();
            let home = ctx.service::<Paths>().ok().map(|p| p.home().to_owned());
            opening.open(store, home).await?;
            // the view row exists from the start: Settings → Auto never waits on a row nobody wrote
            let here = agents(&ctx, &ctx.root_call()).await;
            let ps = projects(&ctx, &ctx.root_call()).await;
            opening.published(view(&opening, &here, ps, now(&ctx))).await;
            Ok(())
        });
        on!(s, st, View, |st, ctx, call, _a| {
            let here = agents(&ctx, &call).await;
            let ps = projects(&ctx, &call).await;
            Ok(st.published(view(&st, &here, ps, now(&ctx))).await)
        });
        on!(s, st, Set, |st, ctx, call, a| {
            let here = agents(&ctx, &call).await;
            {
                let mut set = lock(&st.settings);
                auto::apply_patch(&mut set, &a, &|id| here.iter().any(|h| h.id == id)).map_err(|e| WireError::invalid(e.to_string()))?;
            }
            st.save(true).await;
            let ps = projects(&ctx, &call).await;
            Ok(st.published(view(&st, &here, ps, now(&ctx))).await)
        });
        on!(s, st, Preview, |st, ctx, call, a| {
            let here = agents(&ctx, &call).await;
            Ok(preview(&st, &here, a, now(&ctx)))
        });
        on!(s, st, Reset, |st, ctx, call, _a| {
            let here = agents(&ctx, &call).await;
            lock(&st.router).reset(now(&ctx));
            st.save(false).await;
            let ps = projects(&ctx, &call).await;
            Ok(st.published(view(&st, &here, ps, now(&ctx))).await)
        });
        on!(s, st, Signal, |st, ctx, call, a| {
            let out = lock(&st.router).signal(&a.id, &a.patch, now(&ctx));
            st.save(false).await;
            let _ = &call;
            Ok(out)
        });
        on!(s, st, Record, |st, ctx, call, a| {
            lock(&st.router).record(&a.id, a.route, now(&ctx));
            st.save(false).await;
            let _ = &call;
            Ok(Ack {})
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(RouterPlugin.manifest().id, "wisp.router");
    }

    /// Settings → Auto watches one `router_view` row: it's written whole and flat (the UI reads `arms`, `goal`,
    /// `settings` at the top), from `router.view`'s answer, and it's in the topic the UI subscribes to.
    #[tokio::test]
    async fn the_auto_view_is_published_as_a_flat_row() {
        use wisp_store::{Location, Store};
        let db = Store::open(Location::Memory, std::sync::Arc::new(wisp_store::SystemClock)).unwrap();
        store::install(&db).unwrap();
        let st = State::new();
        let here = vec![AgentInfo { id: "claude".into(), name: "Claude Code".into(), available: true, ..AgentInfo::default() }];
        let v = view(&st, &here, Vec::new(), 1_000);
        store::publish(&db, &v).await.unwrap();
        let row = db.read(|r| r.get("router_view", "view")).unwrap().unwrap();
        let want = serde_json::to_value(&v).unwrap();
        assert_eq!(row.get("goal"), want.get("goal"));
        assert!(row.get("arms").is_some_and(Value::is_array) && row.get("settings").is_some_and(Value::is_object), "{row:?}");
        assert_eq!((store::VIEW.topics)(&row), vec![store::VIEW_TOPIC.to_owned()]);
        assert_eq!(store::VIEW_TOPIC, "plugin:wisp.router:view", "the topic the UI watches (plugins/router/ui types.ts TOPIC.view)");
    }

    /// Tests per project lists every declared project with its test command (none: empty), so the field
    /// the Auto pane edits has a row to show.
    #[test]
    fn tests_per_project_lists_the_declared_projects_and_their_test_commands() {
        let res = vec![
            serde_json::json!({ "kind": "project", "name": "app", "spec": { "path": "/w/app", "test": "cargo test -p app", "color": "#f00" } }),
            serde_json::json!({ "kind": "project", "name": "web", "spec": { "path": "/w/web" } }),
            serde_json::json!({ "kind": "skill", "name": "x", "spec": {} }),
        ];
        let rows = project_rows(&res);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0]["testCommand"], "cargo test -p app");
        assert_eq!(rows[0]["color"], "#f00");
        assert_eq!(rows[1]["testCommand"], "");
        assert!(rows[1].get("color").is_none());
    }

    #[test]
    fn a_preview_is_the_same_every_time() {
        let st = State::new();
        let here = vec![AgentInfo { id: "claude".into(), name: "Claude Code".into(), available: true, models: vec![ModelInfo { id: "opus".into(), label: Some("Opus".into()), efforts: None }], ..AgentInfo::default() }];
        let a = || PreviewArgs { prompt: Some("fix the flaky login test".into()), ..PreviewArgs::default() };
        let one = serde_json::to_value(preview(&st, &here, a(), 1_000)).unwrap();
        let two = serde_json::to_value(preview(&st, &here, a(), 1_000)).unwrap();
        assert_eq!(one, two);
        assert_eq!(one["pick"]["agent"], "claude", "{one}");
        assert!(view(&st, &here, Vec::new(), 1_000).goals.contains_key("balanced"));
    }
}
