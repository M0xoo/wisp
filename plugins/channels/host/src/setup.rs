//! Settings → Phone (F-chan-13, v1 `GET/PUT /api/remote` and `POST /api/remote/test`): each channel's state, one
//! channel's setup saved, a test through its transport. A secret goes to `~/.wisp/secrets.json` only; the channel's
//! resource names it as `${secret:channels/<transport>/<field>}`, so no row, change or sync frame ever holds it.
//! The rules are pure, in `wisp_channels_core::setup`.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::{Map, Value, json};
use wisp_channels_api::{ChannelHub, ChannelSetup, PHONE_ORDER, PhoneStatus, SetupArgs, TRANSPORTS};
use wisp_channels_core::setup as rules;
use wisp_kernel::services::SecretsService;
use wisp_kernel::{Call, Ctx, Result, WireError};
use wisp_resources_api::{Apply, PlanArgs, Resource};

use crate::hub::Hub;
use crate::kinds::ChannelSpec;
use crate::{Live, lock};

const SECRET: &str = "${secret:";

/// The transports Settings → Phone lists: its six first, then any other a plugin serves.
fn names(ctx: &Ctx) -> Vec<String> {
    let mut out: Vec<String> = PHONE_ORDER.iter().map(|s| (*s).to_owned()).collect();
    for d in ctx.contributions(&TRANSPORTS) {
        if !out.iter().any(|n| n == d.name()) {
            out.push(d.name().to_owned());
        }
    }
    out
}

fn installed(ctx: &Ctx, transport: &str) -> bool {
    ctx.contributions(&TRANSPORTS).iter().any(|d| d.name() == transport)
}

fn cloud(ctx: &Ctx, live: &Live) -> bool {
    Hub { ctx: ctx.clone(), st: live.st.clone() }.grid().in_box()
}

/// The declared channel for `transport`, read fresh: (its resource's name, its spec).
async fn declared(live: &Live, transport: &str) -> Option<(String, ChannelSpec)> {
    let k = live.kinds.get()?;
    let specs = k.channels.specs().await.ok()?;
    specs.into_iter().find_map(|(n, v)| {
        let spec: ChannelSpec = serde_json::from_value(v).ok()?;
        (spec.transport == transport).then_some((n, spec))
    })
}

/// Where a secret field sits in a spec: `token` is the spec's own, the rest are in its `routing`.
fn field_of(spec: &ChannelSpec, field: &str) -> String {
    if field == "token" {
        return spec.token.clone();
    }
    spec.routing.as_ref().and_then(|r| r.get(field)).and_then(Value::as_str).unwrap_or_default().to_owned()
}

/// The secret fields that hold something: a `${secret:}` that secrets.json has, or (written by hand) a value.
async fn saved(ctx: &Ctx, transport: &str, spec: Option<&ChannelSpec>) -> Vec<String> {
    let Some(spec) = spec else { return Vec::new() };
    let secrets = wisp_kernel::services::secrets(ctx).ok();
    let mut out = Vec::new();
    for f in rules::secret_fields(transport) {
        let v = field_of(spec, f);
        let has = match v.strip_prefix(SECRET).and_then(|r| r.strip_suffix('}')) {
            Some(key) => match &secrets {
                Some(s) => s.get(key).await.ok().flatten().is_some_and(|x| !x.is_empty()),
                None => false,
            },
            None => !v.is_empty(),
        };
        if has {
            out.push((*f).to_owned());
        }
    }
    out
}

fn settings_of(transport: &str, spec: Option<&ChannelSpec>) -> BTreeMap<String, Value> {
    let routing = spec.and_then(|s| s.routing.as_ref()).and_then(Value::as_object);
    let mut out = BTreeMap::new();
    for (f, kind) in rules::setting_fields(transport) {
        let v = routing.and_then(|r| r.get(*f)).cloned();
        let v = match kind {
            rules::Kind::Bool => Value::Bool(v.and_then(|x| x.as_bool()).unwrap_or(false)),
            rules::Kind::Text => Value::String(v.and_then(|x| x.as_str().map(str::to_owned)).unwrap_or_default()),
        };
        out.insert((*f).to_owned(), v);
    }
    out
}

/// One channel as Settings shows it.
pub async fn status_of(ctx: &Ctx, live: &Live, transport: &str, cloud: bool) -> ChannelSetup {
    let found = declared(live, transport).await;
    let spec = found.as_ref().map(|(_, s)| s);
    let saved = saved(ctx, transport, spec).await;
    let settings = settings_of(transport, spec);
    let as_map: Map<String, Value> = settings.clone().into_iter().collect();
    let refs: Vec<&str> = saved.iter().map(String::as_str).collect();
    let missing = rules::missing(transport, cloud, &refs, &as_map);
    // what the transport keeps for itself: only the plain parts are read here, never its secrets
    let cfg = lock(&live.st.cfg).get(transport).cloned().unwrap_or(Value::Null);
    let text = |k: &str| {
        cfg.get(k).and_then(|v| v.as_str().map(str::to_owned).or_else(|| v.as_i64().map(|n| n.to_string()))).filter(|s| !s.is_empty())
    };
    let linked = match transport {
        "telegram" => u32::from(text("chatId").is_some()),
        _ => cfg.get("senders").and_then(Value::as_array).map_or(0, |a| u32::try_from(a.len()).unwrap_or(u32::MAX)),
    };
    let st = lock(&live.st.status).get(transport).cloned();
    let enabled = spec.is_some_and(|s| s.enabled == Some(true));
    let health = rules::Health {
        running: lock(&live.running).contains_key(transport),
        ok: st.as_ref().and_then(|s| s.ok),
        unlinked: rules::link_field(transport).is_some() && linked == 0,
    };
    let state = rules::state(enabled, &missing, health);
    let link_code = (rules::link_field(transport).is_some() && enabled && linked == 0).then(|| text("linkCode")).flatten();
    let who = match transport {
        "telegram" => text("chatName"),
        "email" => text("address"),
        _ => None,
    };
    let notify = match &found {
        Some((name, _)) => {
            let notes = lock(&live.notes);
            rules::notify_of(notes.iter().filter(|(_, n)| &n.to == name).map(|(_, n)| n.on.as_slice()))
        }
        None => Vec::new(),
    };
    // Discord on a cloud computer: the URL to paste as its Interactions Endpoint URL
    let endpoint = (transport == "discord" && cloud).then(|| text("endpoint")).flatten();
    ChannelSetup {
        transport: transport.to_owned(),
        installed: installed(ctx, transport),
        enabled,
        state,
        saved,
        settings,
        missing: missing.into_iter().map(str::to_owned).collect(),
        error: st
            .and_then(|s| s.error)
            .filter(|_| enabled && state == wisp_channels_api::SetupState::Failing)
            .map(|e| scrub(live, transport, e)),
        link_code,
        linked,
        who,
        notify,
        endpoint,
    }
}

pub async fn phone_status(ctx: &Ctx, live: &Live) -> PhoneStatus {
    let cloud = cloud(ctx, live);
    let mut channels = Vec::new();
    for t in names(ctx) {
        channels.push(status_of(ctx, live, &t, cloud).await);
    }
    PhoneStatus { cloud, channels }
}

fn invalid(path: &str, msg: &str) -> WireError {
    WireError::invalid(format!("{path}: {msg}"))
}

/// Every field checked before anything is written: a refusal leaves secrets and the resource as they were.
fn check(a: &SetupArgs) -> Result<BTreeMap<String, Value>> {
    if !PHONE_ORDER.contains(&a.transport.as_str()) {
        return Err(invalid("transport", &format!("Settings → Phone sets up {}", PHONE_ORDER.join(", "))));
    }
    for (f, v) in &a.secrets {
        rules::check_secret(&a.transport, f, v).map_err(|m| invalid(&format!("secrets.{f}"), &m))?;
    }
    if let Some(n) = &a.notify {
        rules::check_notify(&a.transport, n).map_err(|m| invalid("notify", &m))?;
    }
    if a.unlink && rules::link_field(&a.transport).is_none() {
        return Err(invalid("unlink", &format!("{} links nobody", a.transport)));
    }
    let mut settings = BTreeMap::new();
    for (f, v) in &a.settings {
        settings.insert(f.clone(), rules::check_setting(&a.transport, f, v).map_err(|m| invalid(&format!("settings.{f}"), &m))?);
    }
    Ok(settings)
}

pub(crate) fn random() -> u64 {
    rand::random::<u64>()
}

/// A secret written by this save, and what its key held before (`None`: nothing): what a refused apply puts back.
type Written = Vec<(String, Option<String>)>;

/// Writes the secrets that changed and names them in the spec. → what was written, and whether the bot changed.
async fn write_secrets(
    sec: &SecretsService,
    t: &str,
    asked: &BTreeMap<String, String>,
    spec: &mut ChannelSpec,
    routing: &mut Map<String, Value>,
) -> Result<(Written, bool)> {
    let (mut written, mut relink) = (Written::new(), false);
    for (f, v) in asked {
        let (v, key) = (v.trim(), rules::secret_key(t, f));
        let before =
            if f == "token" { spec.token.clone() } else { routing.get(f.as_str()).and_then(Value::as_str).unwrap_or_default().to_owned() };
        let had = match before.strip_prefix(SECRET).and_then(|r| r.strip_suffix('}')) {
            Some(k) => sec.get(k).await?.unwrap_or_default(),
            None => before,
        };
        if had == v {
            continue;
        }
        relink |= rules::link_field(t) == Some(f.as_str());
        written.push((key.clone(), sec.get(&key).await?));
        let reference = if v.is_empty() {
            sec.delete(&key).await?;
            String::new()
        } else {
            sec.set(&key, v).await?;
            format!("{SECRET}{key}}}")
        };
        // a removed one is written empty: `resources.apply` merges a spec over the one before, so a field left out stays
        if f == "token" {
            spec.token = reference;
        } else {
            routing.insert(f.clone(), Value::String(reference));
        }
    }
    Ok((written, relink))
}

/// Puts back what a refused save wrote.
async fn put_back(sec: &SecretsService, written: Written) {
    for (key, was) in written {
        let r = match was {
            Some(v) => sec.set(&key, &v).await,
            None => sec.delete(&key).await,
        };
        if let Err(e) = r {
            tracing::warn!(%key, "channels: a secret a refused setup wrote couldn't be put back: {}", e.message);
        }
    }
}

/// Saves one channel's setup: its secrets to secrets.json, its spec (secrets named, never held) through
/// `resources.apply`, then a link code where linking needs one. → the channel as Settings shows it now. One save at a
/// time: each reads the spec and writes it whole, so two at once would undo each other.
pub async fn setup(ctx: &Ctx, call: &Call, live: &Arc<Live>, a: SetupArgs) -> Result<ChannelSetup> {
    let settings = check(&a)?;
    if !installed(ctx, &a.transport) {
        return Err(WireError::unavailable(format!("no plugin serves {} on this wisp", a.transport)));
    }
    // until what the store kept is read, a save would start a transport over it (its link, its offset)
    if !live.st.loaded.load(std::sync::atomic::Ordering::Acquire) {
        return Err(WireError::unavailable("wisp is still starting its channels: try again in a moment"));
    }
    let _turn = live.setup_turn.lock().await;
    let t = a.transport.as_str();
    let (name, mut spec) =
        declared(live, t).await.unwrap_or_else(|| (t.to_owned(), ChannelSpec { transport: t.to_owned(), ..ChannelSpec::default() }));
    let sec = wisp_kernel::services::secrets(ctx)?;
    let mut routing = spec.routing.take().and_then(|r| r.as_object().cloned()).unwrap_or_default();
    let (written, relink) = write_secrets(&sec, t, &a.secrets, &mut spec, &mut routing).await?;
    routing.extend(settings);
    let was_on = spec.enabled == Some(true);
    if let Some(on) = a.enabled {
        spec.enabled = Some(on);
    }
    // v1: switched on the first time, ntfy gets a long random topic, so it isn't guessable
    if t == "ntfy" && spec.enabled == Some(true) && routing.get("topic").and_then(Value::as_str).unwrap_or_default().is_empty() {
        routing.insert("topic".into(), Value::String(rules::fresh_topic(random())));
    }
    spec.routing = (!routing.is_empty()).then_some(Value::Object(routing));
    let mut body = serde_json::to_value(&spec).map_err(|e| WireError::internal(e.to_string()))?;
    body["token"] = Value::String(spec.token.clone());
    let mut resources = vec![Resource::new("channel", name.clone(), body)];
    if let Some(on) = send_me(live, t, &name, a.notify.as_deref(), !was_on && spec.enabled == Some(true)) {
        resources.push(Resource::new("notification", rules::notification_name(t), json!({ "on": on, "to": name })));
    }
    // what it said was about the old setup; cleared before the apply restarts it, so its first word isn't lost
    let said = lock(&live.st.status).remove(t);
    let applied = match ctx.run::<Apply>(call, PlanArgs { resources, ..PlanArgs::default() }).await {
        Ok(x) => x,
        Err(e) => {
            put_back(&sec, written).await;
            if let Some(said) = said {
                lock(&live.st.status).entry(t.to_owned()).or_insert(said);
            }
            return Err(e);
        }
    };
    // a new value under the same `${secret:}` leaves the spec as it was, so nothing was applied: the transport reads it now
    if applied.applied == 0 && !written.is_empty() {
        crate::act(ctx, live).await;
    } else if applied.applied == 0
        && let Some(said) = said
    {
        // nothing restarted it (an Unlink, the same settings again): what it last said still holds
        lock(&live.st.status).entry(t.to_owned()).or_insert(said);
    }
    if a.unlink {
        unlink(ctx, live, t);
    } else {
        link_code(ctx, live, t, relink);
    }
    crate::rows::poke(ctx, live);
    Ok(status_of(ctx, live, t, cloud(ctx, live)).await)
}

/// What Send me writes now: as asked; or, switched on the first time with nothing told to notify it, v1's default
/// (questions and finished tasks). `None`: nothing to write.
fn send_me(live: &Live, t: &str, name: &str, asked: Option<&[String]>, first_on: bool) -> Option<Vec<String>> {
    if let Some(asked) = asked {
        // events written into `phone-<t>` by hand (`failed`, `limit`) stay; Send me sets only its own two
        let own = rules::notification_name(t);
        let kept: Vec<String> = lock(&live.notes)
            .iter()
            .filter(|(n, _)| *n == own)
            .flat_map(|(_, x)| x.on.iter().filter(|e| !wisp_channels_api::NOTIFY_EVENTS.contains(&e.as_str())).cloned())
            .collect();
        return rules::check_notify(t, asked).ok().map(|mut on| {
            on.extend(kept);
            on
        });
    }
    let told = lock(&live.notes).iter().any(|(n, x)| x.to == name || *n == rules::notification_name(t));
    (first_on && rules::notifies(t) && !told).then(|| wisp_channels_api::NOTIFY_EVENTS.iter().map(|e| (*e).to_owned()).collect())
}

/// Unlinks whoever is linked (v1 `unlink`): Telegram's chat, Slack's and Discord's people, and a fresh code to link
/// with again. What the transport keeps, so it lasts a restart (`kept.rs`).
fn unlink(ctx: &Ctx, live: &Live, t: &str) {
    let code = rules::fresh_code(random());
    let cfg = match t {
        "telegram" => json!({ "chatId": Value::Null, "chatName": "", "linkCode": code }),
        _ => json!({ "senders": [], "linkGuess": Value::Null, "linkCode": code }),
    };
    Hub { ctx: ctx.clone(), st: live.st.clone() }.set_cfg(t, cfg);
}

/// Telegram, linked to a chat: it took its code and needs none until another bot.
fn tg_linked(cfg: Option<&Value>) -> bool {
    cfg.and_then(|c| c.get("chatId")).is_some_and(|v| v.as_str().map_or(!v.is_null(), |s| !s.is_empty()))
}

/// Another bot, or none yet: a fresh code to link with (v1 `newLinkCode`). It's the transport's own state, as the
/// code a transport changes after wrong guesses is: kept beside its config (in secrets), never declared.
fn link_code(ctx: &Ctx, live: &Live, t: &str, relink: bool) {
    if rules::link_field(t).is_none() {
        return;
    }
    let (has, linked) = {
        let all = lock(&live.st.cfg);
        let c = all.get(t);
        (c.and_then(|c| c.get("linkCode")).and_then(Value::as_str).is_some_and(|s| !s.is_empty()), t == "telegram" && tg_linked(c))
    };
    if relink || !(has || linked) {
        let hub = Hub { ctx: ctx.clone(), st: live.st.clone() };
        hub.set_cfg(t, json!({ "linkCode": rules::fresh_code(random()) }));
    }
}

/// `text` with every secret the channel's config holds taken out: a service's error can quote its request (Telegram's
/// URL has the token in it), and what Settings shows never holds one.
pub(crate) fn scrub(live: &Live, t: &str, text: String) -> String {
    let cfg = lock(&live.st.cfg).get(t).cloned().unwrap_or(Value::Null);
    let mut out = text;
    for f in rules::secret_fields(t).iter().chain(&["linkCode"]) {
        if let Some(v) = cfg.get(*f).and_then(Value::as_str).filter(|v| v.len() >= 4) {
            out = out.replace(v, "…");
        }
    }
    out
}
