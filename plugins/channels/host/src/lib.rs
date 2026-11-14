//! wisp-channels: the hub every way of reaching wisp from outside goes through (plan §6.11.3). It reads
//! the `channel` and `notification` resources (ADR-0028), gives each transport (`channels.transport@1`:
//! wisp.ntfy, wisp.telegram, …) its config and starts the ones that are on (all off by default), and
//! sends what the notifications ask for: `finished`, `failed` and `asks` to a channel or a webhook.
//! Transports own their wire; every IO they do goes through the hub's handles (`hub.rs`).

mod hub;
mod kept;
mod kinds;
mod report;
mod routed;
mod setup;
mod ws;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use serde_json::{Value, json};
use wisp_channels_api::views::{Action, ActionKind, Msg, SessionView};
use wisp_channels_api::{
    Act, Extra, HttpOut, Inbound, InboundOpts, Line, Notify, PhoneView, Refresh, Rotate, Routed, SendNotice, Sent, SetupChannel,
    TRANSPORTS, Test, Transport, Update, View,
};
use wisp_kernel::{CancellationToken, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_runtime_api::events::{SessionDeleted, TaskAsked, TurnEnded, TurnFinished};
use wisp_runtime_api::model::TurnStatus;

use crate::hub::{Hub, State};
use crate::kinds::{Channels, Kinds, Notifications, OnChange};

#[derive(Debug, Default)]
pub struct ChannelsPlugin;

/// A transport that's on, and what stops it.
type Running = (Arc<dyn Transport>, CancellationToken);

/// The hub's live parts: the running transports by name, what's declared.
#[derive(Default)]
struct Live {
    st: Arc<State>,
    running: Mutex<HashMap<String, Running>>,
    channels: Channels,
    notes: Notifications,
    kinds: OnceLock<Arc<Kinds>>,
    /// asks a channel already said it waits on
    said: report::Said,
    /// one `channels.setup` at a time (setup.rs)
    setup_turn: tokio::sync::Mutex<()>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A channel's config as its transport reads it: the declared fields, its token read from secrets, and
/// its `routing` object's own settings (ntfy's `server` and `topic`; Slack's tokens as `${secret:}`, read too).
async fn config_of(ctx: &Ctx, c: &kinds::ChannelSpec) -> Value {
    let mut cfg = json!({ "enabled": c.enabled == Some(true), "allow": c.allow, "cap": c.cap });
    if !c.token.is_empty() {
        cfg["token"] = json!(kinds::reveal(ctx, &c.token).await);
    }
    if let Some(Value::Object(r)) = &c.routing {
        for (k, v) in r {
            cfg[k] = match v.as_str() {
                Some(s) if s.contains("${secret:") => json!(kinds::reveal_or_empty(ctx, s).await),
                _ => v.clone(),
            };
        }
    }
    cfg
}

/// Re-reads the declared channels; stops every transport, then starts the ones that are on.
async fn act(ctx: &Ctx, live: &Arc<Live>) {
    let Some(k) = live.kinds.get() else { return };
    // before the start read what was kept, an act would start a transport over it
    if !live.st.loaded.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    let read = kinds::read(k, &live.channels, &live.notes).await;
    for (_, (_, stop)) in lock(&live.running).drain() {
        stop.cancel();
    }
    let declared = lock(&live.channels).clone();
    let hub: Arc<dyn wisp_channels_api::ChannelHub> = Arc::new(Hub { ctx: ctx.clone(), st: live.st.clone() });
    for def in ctx.contributions(&TRANSPORTS) {
        let Some((_, c)) = declared.iter().find(|(_, c)| c.transport == def.name()) else {
            // its channel was removed (now, or while wisp was off): what it kept goes too, its secrets with it
            if read.as_ref().is_some_and(|named| !named.iter().any(|t| t == def.name())) {
                kept::drop_kept(ctx, &live.st, def.name(), def.secrets());
            }
            continue;
        };
        let cfg = config_of(ctx, c).await;
        {
            let keys: Vec<String> = cfg.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
            let before = lock(&live.st.declared).insert(def.name().to_owned(), keys).unwrap_or_default();
            lock(&live.st.secret_paths).insert(def.name().to_owned(), def.secrets().iter().map(|p| (*p).to_owned()).collect());
            let mut all = lock(&live.st.cfg);
            // the first act after a restart: what the transport kept before it, under the same token
            let kept = all.remove(def.name()).or_else(|| kept::restore(&live.st, def.name(), &cfg)).unwrap_or_default();
            all.insert(def.name().to_owned(), kinds::keep_over(kept, cfg, &before));
        }
        kept::put_kept(ctx, &live.st, def.name());
        if c.enabled != Some(true) {
            continue;
        }
        let t = def.create(hub.clone());
        let stop = ctx.scope().child_token();
        lock(&live.running).insert(def.name().to_owned(), (t.clone(), stop.clone()));
        ctx.spawn(async move { t.start(stop).await });
    }
}

/// The task's cwd is in one of `projects` (or there are none).
fn in_projects(projects: &[String], cwd: &str) -> bool {
    projects.is_empty()
        || projects.iter().any(|p| cwd == p.trim_end_matches('/') || cwd.starts_with(&format!("{}/", p.trim_end_matches('/'))))
}

/// Sends `event` about a task to every notification that asks for it. `fanned`: the same event goes to the channels
/// the task came from (report.rs), so a notification to one of them is already said.
async fn notify(ctx: &Ctx, live: &Arc<Live>, event: &str, session: &str, text: &str, actions: Vec<Action>, fanned: bool) {
    let due: Vec<kinds::NotificationSpec> =
        lock(&live.notes).iter().filter(|(_, n)| n.on.iter().any(|e| e == event)).map(|(_, n)| n.clone()).collect();
    if due.is_empty() {
        return;
    }
    let Ok(task) = hub::typed::<wisp_runtime_api::commands::Get>(ctx, hub::get(session)).await else { return };
    let view = hub::session_view(&task);
    let cwd = view.cwd.clone().unwrap_or_default();
    let title = match event {
        "finished" => format!("✓ {}", view.title),
        "failed" => format!("✗ {}", view.title),
        _ => format!("? {}", view.title),
    };
    let msg = Msg { title, text: text.to_owned(), actions };
    for n in due.into_iter().filter(|n| in_projects(&n.projects, &cwd)) {
        if let Err(e) = deliver(ctx, live, &n.to, event, &msg, &view, fanned).await {
            tracing::warn!(to = %n.to, "notification not sent: {}", e.message);
        }
    }
}

/// To a webhook (`https://…`: the event as JSON) or a declared channel's transport.
async fn deliver(ctx: &Ctx, live: &Arc<Live>, to: &str, event: &str, msg: &Msg, s: &SessionView, fanned: bool) -> Result<()> {
    if to.starts_with("http://") || to.starts_with("https://") {
        let body = json!({ "event": event, "session": { "id": s.id, "title": s.title, "state": s.state, "cwd": s.cwd }, "title": msg.title, "text": msg.text });
        let net = wisp_kernel::services::net(ctx)?;
        let r = net
            .fetch(wisp_kernel::services::NetRequest {
                method: "POST".into(),
                url: to.to_owned(),
                headers: vec![("content-type".into(), "application/json".into())],
                body: body.to_string().into_bytes(),
                timeout_ms: 10_000,
            })
            .await?;
        return if (200..300).contains(&r.status) { Ok(()) } else { Err(WireError::unavailable(format!("{to} answered {}", r.status))) };
    }
    let transport = lock(&live.channels)
        .iter()
        .find(|(n, _)| n == to)
        .map(|(_, c)| c.transport.clone())
        .ok_or_else(|| WireError::invalid(format!("no channel named {to}")))?;
    let t = lock(&live.running)
        .get(&transport)
        .map(|(t, _)| t.clone())
        .ok_or_else(|| WireError::unavailable(format!("the channel {to} is off")))?;
    if fanned && report::covered(live, t.as_ref(), s) {
        return Ok(()); // the task came from there: its report already goes there (report.rs)
    }
    t.publish(msg, Some(s)).await
}

fn running(live: &Live) -> Vec<Arc<dyn Transport>> {
    lock(&live.running).values().map(|(t, _)| t.clone()).collect()
}

fn transport(live: &Live, name: &str) -> Result<Arc<dyn Transport>> {
    lock(&live.running).get(name).map(|(t, _)| t.clone()).ok_or_else(|| WireError::not_found(format!("the {name} channel isn't on")))
}

fn events(s: &mut Setup, live: &Arc<Live>) {
    let l = live.clone();
    s.on::<TurnEnded, _, _>(move |ctx, e| {
        let (live, e, c) = (l.clone(), e.clone(), ctx.clone());
        let event = match e.status {
            TurnStatus::Done => Some("finished"),
            TurnStatus::Error => Some("failed"),
            _ => None,
        };
        if let Some(event) = event {
            // a subagent's or wisp's own turn (compact) isn't news in the chat a task came from
            let fanned = !e.inner;
            if fanned {
                report::finished(&ctx, &l, e.session_id.as_str(), e.error_text.clone().unwrap_or_default());
            }
            ctx.spawn(async move {
                let why = e.error_text.clone().unwrap_or_else(|| "It's done.".into());
                let acts =
                    vec![Action { label: "Done".into(), kind: ActionKind::Done, reference: e.turn_id.as_str().to_owned(), index: 0 }];
                notify(&c, &live, event, e.session_id.as_str(), &why, acts, fanned).await;
            });
        }
        async {}
    });
    // a task the grid routed here: how it went goes back to that chat (routed.rs)
    let l = live.clone();
    s.on::<TurnFinished, _, _>(move |ctx, e| {
        let thread = hub::routed_thread(&l.st, e.session_id.as_str());
        if let Some(thread) = thread {
            let mark = match e.status {
                TurnStatus::Done => "✓",
                TurnStatus::Error => "✗",
                _ => "■",
            };
            let (title, text, c) = (format!("{mark} {}", e.summary.title), e.summary.preview.clone(), ctx.clone());
            ctx.spawn(async move { routed::report(&c, &thread, &title, &text).await });
        }
        async {}
    });
    let l = live.clone();
    // `task.asked` (runtime more/ask.rs): the one fact every ask raises
    s.on::<TaskAsked, _, _>(move |ctx, e| {
        let (live, e, c) = (l.clone(), e.0.clone(), ctx.clone());
        report::asked(&ctx, &l, e.session_id.as_str());
        ctx.spawn(async move { notify(&c, &live, "asks", e.session_id.as_str(), &e.text, Vec::new(), true).await });
        async {}
    });
    // a deleted task's origin goes with it (`chan_task`)
    let l = live.clone();
    s.on::<SessionDeleted, _, _>(move |_ctx, e| {
        if l.st.forget(e.id.as_str()) {
            kept::drop_task(&l.st, e.id.as_str());
        }
        async {}
    });
}

fn commands(s: &mut Setup, live: &Arc<Live>) {
    let l = live.clone();
    s.command::<View, _, _>(move |_ctx, _call, _a| {
        let live = l.clone();
        async move {
            let st = lock(&live.st.status).clone();
            let list: Vec<Value> = lock(&live.channels).iter().map(|(n, c)| json!({ "name": n, "transport": c.transport, "enabled": c.enabled == Some(true), "running": lock(&live.running).contains_key(&c.transport), "status": st.get(&c.transport) })).collect();
            Ok(json!({ "channels": list }))
        }
    });
    let l = live.clone();
    s.command::<SendNotice, _, _>(move |_ctx, _call, a| {
        let live = l.clone();
        async move {
            let mut sent = 0;
            for t in running(&live) {
                if t.publish(&a.msg, None).await.is_ok() {
                    sent += 1;
                }
            }
            Ok(Sent { sent })
        }
    });
    let l = live.clone();
    s.command::<Test, _, _>(move |_ctx, _call, a| {
        let live = l.clone();
        async move { setup::test(&live, &a).await }
    });
    let l = live.clone();
    s.command::<PhoneView, _, _>(move |ctx, _call, _a| {
        let live = l.clone();
        async move { Ok(setup::phone_status(&ctx, &live).await) }
    });
    let l = live.clone();
    s.command::<SetupChannel, _, _>(move |ctx, call, a| {
        let live = l.clone();
        async move { setup::setup(&ctx, &call, &live, a).await }
    });
    let l = live.clone();
    s.command::<Notify, _, _>(move |ctx, _call, a| {
        let live = l.clone();
        async move {
            let text = a.summary.as_ref().and_then(|s| s.preview.clone()).unwrap_or_default();
            notify(&ctx, &live, "finished", &a.session_id, &text, Vec::new(), false).await;
            Ok(wisp_channels_api::Empty {})
        }
    });
    s.command::<Act, _, _>(|ctx, _call, a| async move { Ok(Line { line: wisp_channels_api::Phone::act(&hub::KPhone(ctx), &a).await? }) });
    let l = live.clone();
    s.command::<Refresh, _, _>(move |ctx, _call, _a| {
        let live = l.clone();
        async move {
            act(&ctx, &live).await;
            Ok(wisp_channels_api::Empty {})
        }
    });
    more_commands(s, live);
}

fn more_commands(s: &mut Setup, live: &Arc<Live>) {
    let l = live.clone();
    s.command::<Inbound, _, _>(move |ctx, _call, a| {
        let live = l.clone();
        async move {
            use base64::Engine as _;
            let raw = base64::engine::general_purpose::STANDARD.decode(&a.body).map_err(|e| WireError::invalid(e.to_string()))?;
            let r = transport(&live, &a.channel)?.inbound(&raw, &a.headers, InboundOpts { at_ms: a.at, verified: a.verified }).await;
            if let Some(after) = r.after {
                ctx.spawn(after);
            }
            Ok(HttpOut { status: r.status, body: r.body })
        }
    });
    let l = live.clone();
    s.command::<Rotate, _, _>(move |_ctx, _call, a| {
        let live = l.clone();
        async move {
            let r = transport(&live, &a.channel)?.rotate().await;
            Ok(HttpOut { status: r.status, body: r.body })
        }
    });
    let l = live.clone();
    s.command::<Extra, _, _>(move |_ctx, _call, a| {
        let live = l.clone();
        async move { transport(&live, &a.channel)?.extra(&a.what).await }
    });
    let l = live.clone();
    s.command::<Update, _, _>(move |_ctx, _call, a| {
        let live = l.clone();
        async move {
            let name = a.get("channel").and_then(Value::as_str).unwrap_or_default().to_owned();
            transport(&live, &name)?.update(&a).await?;
            Ok(json!({ "ok": true }))
        }
    });
    let l = live.clone();
    s.command::<Routed, _, _>(move |ctx, _call, a| {
        let live = l.clone();
        async move {
            let hub: Arc<dyn wisp_channels_api::ChannelHub> = Arc::new(Hub { ctx: ctx.clone(), st: live.st.clone() });
            routed::handle(&ctx, hub, &a).await
        }
    });
}

impl Plugin for ChannelsPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let live = Arc::new(Live::default());
        let (l, ctx) = (live.clone(), s.ctx());
        let after: OnChange = Arc::new(move || {
            let (l, ctx) = (l.clone(), ctx.clone());
            Box::pin(async move { act(&ctx, &l).await })
        });
        let k = kinds::register(s, &after);
        let _ = live.kinds.set(k);
        events(s, &live);
        commands(s, &live);
        let l = live;
        s.on_start(move |ctx| async move {
            let secrets = wisp_kernel::services::secrets(&ctx)?;
            let key = if let Ok(Some(k)) = secrets.get("channels/sign").await {
                k
            } else {
                let k =
                    wisp_channels_core::sign::sha256_hex(format!("{}{}", wisp_kernel::ids::uuid7(), wisp_kernel::ids::uuid7()).as_bytes());
                let _ = secrets.set("channels/sign", &k).await;
                k
            };
            *lock(&l.st.key) = key;
            // what the hub kept before a restart: each channel task's origin, each transport's own state
            if let Ok(store) = ctx.service::<wisp_store::Store>() {
                let paths: Vec<(String, Vec<String>)> = ctx
                    .contributions(&TRANSPORTS)
                    .iter()
                    .map(|d| (d.name().to_owned(), d.secrets().iter().map(|p| (*p).to_owned()).collect()))
                    .collect();
                match kept::read_into(&ctx, &l.st, store.as_ref().clone(), &paths).await {
                    Ok(ids) => {
                        let (c, st) = (ctx.clone(), l.st.clone());
                        ctx.spawn(async move { kept::prune_tasks(&c, &st, ids).await });
                    }
                    Err(e) => tracing::warn!("channels: what was kept couldn't be read, so this run keeps it in memory: {e}"),
                }
            } else {
                tracing::warn!("channels: no store, so what a channel keeps lasts until a restart");
            }
            l.st.loaded.store(true, std::sync::atomic::Ordering::Release);
            act(&ctx, &l).await;
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        let m = ChannelsPlugin.manifest();
        assert_eq!(m.id, "wisp.channels");
        assert!(m.validate().is_ok());
    }

    #[test]
    fn a_follow_up_keeps_the_tasks_mode_unless_one_is_asked_and_that_one_is_held_to_the_chats_cap() {
        use wisp_channels_api::views::Mode::{Auto, Edits, Plan};
        assert_eq!(hub::follow_up_mode(None, Some(Edits)), None, "the cap alone never raises a Plan task");
        assert_eq!(hub::follow_up_mode(None, Some(Auto)), None, "nor does a private Telegram chat's");
        assert_eq!(hub::follow_up_mode(Some(Auto), Some(Edits)), Some(Edits));
        assert_eq!(hub::follow_up_mode(Some(Plan), Some(Edits)), Some(Plan));
        assert_eq!(hub::follow_up_mode(Some(Auto), None), Some(Auto));
    }

    #[test]
    fn every_channel_task_is_capped_at_edits_or_its_chats_lower_cap() {
        use wisp_channels_api::views::Mode::{Auto, Edits, Plan};
        assert_eq!(hub::channel_cap(None), Edits, "no cap named: Edits");
        assert_eq!(hub::channel_cap(Some(Auto)), Edits, "a private chat's Full auto still starts capped (F-chan-10)");
        assert_eq!(hub::channel_cap(Some(Plan)), Plan, "a lower cap stays");
    }

    #[test]
    fn a_notification_for_projects_only_covers_them() {
        assert!(in_projects(&[], "/any"));
        assert!(in_projects(&["/w/api/".into()], "/w/api/src"));
        assert!(!in_projects(&["/w/api".into()], "/w/apix"));
    }
}
