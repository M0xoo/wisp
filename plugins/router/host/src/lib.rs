//! wisp.router host: Auto (v1 server/router.js, services/auto.js, routes/auto.js). The decisions are
//! `wisp-router-core`'s; this crate keeps the state, reads this computer's harnesses from
//! `runtime.agents`, and answers the six commands.
//!
//! The learned state and Settings → Auto are kept as v1 kept them, in `<home>/router.json` (written
//! atomically, temp then rename), so a v1 install's record reads as it is. It moves into router-owned
//! store tables with the rest of the plugin's rows.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::services::Paths;
use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_router_api::commands::{Ack, Preview, Record, Reset, Set, Signal, View};
use wisp_router_api::view::{PreviewArgs, RouterView, Settings};
use wisp_router_api::{AgentInfo, ChooseArgs, ModelInfo};
use wisp_router_core::{Mulberry32, Router, RouterState, auto, choose, report};

#[derive(Debug, Default)]
pub struct RouterPlugin;

/// What `router.json` holds: the learned state and the settings.
#[derive(Debug, Default, Serialize, Deserialize)]
struct Saved {
    #[serde(default, flatten)]
    state: RouterState,
    #[serde(default)]
    settings: Settings,
}

struct State {
    router: Mutex<Router>,
    settings: Mutex<Settings>,
    file: Option<PathBuf>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl State {
    fn load(file: Option<PathBuf>) -> Self {
        let saved: Saved = file.as_ref().and_then(|f| std::fs::read(f).ok()).and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        Self { router: Mutex::new(Router::new(saved.state)), settings: Mutex::new(saved.settings), file }
    }

    async fn save(&self) {
        let Some(file) = self.file.clone() else { return };
        let saved = {
            let r = lock(&self.router);
            Saved { state: r.st.clone(), settings: lock(&self.settings).clone() }
        };
        let Ok(bytes) = serde_json::to_vec(&saved) else { return };
        let tmp = file.with_extension("json.tmp");
        if tokio::fs::write(&tmp, bytes).await.is_ok() {
            let _ = tokio::fs::rename(&tmp, &file).await;
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

fn view(st: &State, here: &[AgentInfo], now: i64) -> RouterView {
    let s = lock(&st.settings).clone();
    let mut r = lock(&st.router);
    r.sync(here, false, now);
    let prefs = auto::prefs(&s, here);
    RouterView { goals: auto::goals(), goal: auto::goal_of(None, &s).to_owned(), settings: auto::settings_view(&s), projects: Vec::new(), report: report::report(&r, here, &prefs, now) }
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
        let file = s.ctx().service::<Paths>().ok().map(|p| p.home().join("router.json"));
        let st = Arc::new(State::load(file));
        on!(s, st, View, |st, ctx, call, _a| {
            let here = agents(&ctx, &call).await;
            Ok(view(&st, &here, now(&ctx)))
        });
        on!(s, st, Set, |st, ctx, call, a| {
            let here = agents(&ctx, &call).await;
            {
                let mut set = lock(&st.settings);
                auto::apply_patch(&mut set, &a, &|id| here.iter().any(|h| h.id == id)).map_err(|e| WireError::invalid(e.to_string()))?;
            }
            st.save().await;
            Ok(view(&st, &here, now(&ctx)))
        });
        on!(s, st, Preview, |st, ctx, call, a| {
            let here = agents(&ctx, &call).await;
            Ok(preview(&st, &here, a, now(&ctx)))
        });
        on!(s, st, Reset, |st, ctx, call, _a| {
            let here = agents(&ctx, &call).await;
            lock(&st.router).reset(now(&ctx));
            st.save().await;
            Ok(view(&st, &here, now(&ctx)))
        });
        on!(s, st, Signal, |st, ctx, call, a| {
            let out = lock(&st.router).signal(&a.id, &a.patch, now(&ctx));
            st.save().await;
            let _ = &call;
            Ok(out)
        });
        on!(s, st, Record, |st, ctx, call, a| {
            lock(&st.router).record(&a.id, a.route, now(&ctx));
            st.save().await;
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

    #[test]
    fn a_preview_is_the_same_every_time() {
        let st = State::load(None);
        let here = vec![AgentInfo { id: "claude".into(), name: "Claude Code".into(), available: true, models: vec![ModelInfo { id: "opus".into(), label: Some("Opus".into()), efforts: None }], ..AgentInfo::default() }];
        let a = || PreviewArgs { prompt: Some("fix the flaky login test".into()), ..PreviewArgs::default() };
        let one = serde_json::to_value(preview(&st, &here, a(), 1_000)).unwrap();
        let two = serde_json::to_value(preview(&st, &here, a(), 1_000)).unwrap();
        assert_eq!(one, two);
        assert_eq!(one["pick"]["agent"], "claude", "{one}");
        assert!(view(&st, &here, 1_000).goals.contains_key("balanced"));
    }
}
