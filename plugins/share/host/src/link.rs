//! The Share dialog and the New task card (v1 /sessions/:id/share, /shares/peek), over `share.send` and
//! wisp Cloud's own commands: `share.create` sends the task (a spec, or a report with the work) to the
//! first ready destination and keeps its link on the task (`ext["wisp.share"]`, the list row's `shared`);
//! `share.stop` takes the link back (`grid-client.revoke`) and forgets it; `share.peek` fetches a pasted
//! link (`grid-client.fetch`) and describes it as the card shows it, locked or not.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::{Call, Command, Ctx, Result, Setup, WireError};
use wisp_runtime_api::model::{Session, Turn};
use wisp_runtime_api::points::{SUMMARY, SummaryField};
use wisp_share_api::{Bundle, Destinations, Level, NoArgs, PLUGIN_ID, SendArgs, SendCmd};

use crate::calls;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreateArgs {
    /// the task
    pub session: String,
    /// '' or none: anyone with the link
    #[serde(default)]
    pub passkey: Option<String>,
    /// the answers and the files changed go too (a report), not only the ask
    #[serde(default)]
    pub work: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionArgs {
    pub session: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeekArgs {
    pub url: String,
    #[serde(default)]
    pub passkey: Option<String>,
}

macro_rules! command {
    ($name:ident = $id:literal [$perm:literal] $(read $ro:ident)? : $args:ty => $out:ty) => {
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some($perm);
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            type Out = $out;
        }
    };
}

command!(Create = "share.create" ["share:make"] : CreateArgs => Value);
command!(Stop = "share.stop" ["share:make"] : SessionArgs => Value);
command!(Peek = "share.peek" ["share:open"] read yes : PeekArgs => Value);

/// What the task keeps of its link: the grid's id (to take it back), the url, locked, when.
pub fn kept(sent: &Value, locked: bool, at: i64) -> Value {
    json!({ "id": sent.get("id").cloned().unwrap_or(Value::Null), "url": sent.get("url").cloned().unwrap_or(Value::Null), "locked": locked, "at": at })
}

/// Who may open it: a passkey is a password share, else anyone with the link.
pub fn access_of(passkey: Option<&str>) -> Value {
    match passkey.map(str::trim).filter(|p| !p.is_empty()) {
        Some(p) => json!({ "kind": "password", "password": p }),
        None => json!({ "kind": "anyone" }),
    }
}

/// The New task card for a fetched share (`content` a `.wisp-task` bundle), as v1's peek answered.
pub fn card_of(content: &Value, card: &Value, verified: bool) -> Value {
    let b: Bundle = serde_json::from_value(content.clone()).unwrap_or_default();
    let turns = b.history.as_ref().and_then(Value::as_array).map_or(0, Vec::len);
    let agent = b.needs.iter().find_map(|n| n.strip_prefix("harness:")).unwrap_or_default().to_owned();
    let name = card.get("owner").and_then(|o| o.get("name")).and_then(Value::as_str).map_or_else(|| b.from.name.clone(), str::to_owned);
    json!({
        "open": true,
        "title": if b.title.is_empty() { card.get("title").cloned().unwrap_or(Value::Null) } else { json!(b.title) },
        "from": { "name": name },
        "agent": agent,
        "turns": turns,
        "work": if b.report.is_some() { json!({}) } else { Value::Null },
        "verified": verified,
        "run": if agent.is_empty() { Value::Null } else { json!({ "agent": agent }) },
    })
}

/// A locked link: only that it is, and whether the passkey tried was wrong.
pub fn locked_card(tried: bool) -> Value {
    json!({ "open": false, "locked": true, "wrong": tried, "run": null })
}

async fn create(ctx: &Ctx, call: &Call, a: CreateArgs) -> Result<Value> {
    let dests = ctx.run::<Destinations>(call, NoArgs {}).await?;
    let to = dests
        .as_array()
        .into_iter()
        .flatten()
        .find(|d| d.get("ready") == Some(&json!(true)))
        .and_then(|d| d.get("id"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let Some(to) = to else {
        let why = dests
            .as_array()
            .and_then(|d| d.first())
            .and_then(|d| d.get("why"))
            .and_then(Value::as_str)
            .unwrap_or("Sign in to wisp Cloud to share a link.")
            .to_owned();
        return Err(WireError::invalid(why));
    };
    let locked = a.passkey.as_deref().is_some_and(|p| !p.trim().is_empty());
    let args = SendArgs {
        to,
        id: Some(a.session.clone()),
        level: if a.work { Level::Report } else { Level::Spec },
        access: Some(access_of(a.passkey.as_deref())),
        ..SendArgs::default()
    };
    let sent = ctx.run::<SendCmd>(call, args).await?;
    let at = ctx.clock().map_or(0, |c| c.now_ms());
    let keep = kept(&sent, locked, at);
    let again = calls::task(ctx, call, &a.session).await.is_ok_and(|s| s.ext_of(PLUGIN_ID).get("url").is_some());
    calls::set_ext(ctx, call, &a.session, keep.clone()).await?;
    let props = json!({ "locked": locked, "work": if a.work { "report" } else { "none" }, "again": again });
    calls::warn("task_share not tracked", calls::track(ctx, "task_share", props).await);
    Ok(json!({ "url": keep["url"], "locked": locked, "at": at, "notes": [] }))
}

async fn stop(ctx: &Ctx, call: &Call, a: SessionArgs) -> Result<Value> {
    let task = calls::task(ctx, call, &a.session).await?;
    let Some(id) = task.ext_of(PLUGIN_ID).get("id").and_then(Value::as_str).map(str::to_owned) else {
        return Err(WireError::invalid("This task isn't shared."));
    };
    calls::revoke(ctx, call, id).await?;
    calls::set_ext(ctx, call, &a.session, Value::Null).await?;
    Ok(json!({ "ok": true }))
}

async fn peek(ctx: &Ctx, call: &Call, a: PeekArgs) -> Result<Value> {
    let tried = a.passkey.as_deref().is_some_and(|p| !p.is_empty());
    match calls::fetch(ctx, call, a.url, a.passkey).await {
        Ok(f) => Ok(card_of(&f.content, &f.card, f.verified)),
        Err(e) if e.message.contains("password") || e.message.contains("people only") || e.message.contains("for a team") => {
            Ok(locked_card(tried))
        }
        Err(e) => Err(e),
    }
}

/// The list row's `shared`: the link, when the task has one.
struct Shared;

impl SummaryField for Shared {
    fn plugin(&self) -> &str {
        PLUGIN_ID
    }
    fn fields(&self, session: &Session, _last: Option<&Turn>, out: &mut std::collections::BTreeMap<String, Value>) {
        if let Some(v) = session.ext.get(PLUGIN_ID).filter(|v| v.get("url").is_some_and(Value::is_string)) {
            out.insert("shared".into(), json!({ "url": v["url"], "locked": v.get("locked").cloned().unwrap_or(json!(false)), "at": v.get("at").cloned().unwrap_or(Value::Null) }));
        }
    }
}

pub(crate) fn register(s: &mut Setup) {
    let f: std::sync::Arc<dyn SummaryField> = std::sync::Arc::new(Shared);
    s.contribute(&SUMMARY, f);
    s.command::<Create, _, _>(|ctx, call, a| async move { create(&ctx, &call, a).await });
    s.command::<Stop, _, _>(|ctx, call, a| async move { stop(&ctx, &call, a).await });
    s.command::<Peek, _, _>(|ctx, call, a| async move { peek(&ctx, &call, a).await });
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// A passkey makes a password share; the task keeps the grid's id (to take it back) and the url; a
    /// fetched bundle reads as the card, and a locked link as locked (wrong when a passkey was tried).
    #[test]
    fn a_share_link_is_kept_on_its_task_and_a_pasted_one_reads_as_its_card() {
        assert_eq!(access_of(Some("  ")), json!({ "kind": "anyone" }));
        assert_eq!(access_of(Some("pw")), json!({ "kind": "password", "password": "pw" }));
        let k = kept(&json!({ "id": "s1", "url": "https://g/s/s1" }), true, 5);
        assert_eq!(k, json!({ "id": "s1", "url": "https://g/s/s1", "locked": true, "at": 5 }));
        let bundle = json!({ "wispTask": 1, "id": "share-t", "level": "full", "title": "Fix login", "version": "2", "needs": ["harness:codex"], "spec": {}, "history": [{}, {}], "from": { "name": "ada", "key": "" } });
        let c = card_of(&bundle, &json!({}), true);
        assert_eq!(c["title"], "Fix login");
        assert_eq!(c["turns"], 2);
        assert_eq!(c["agent"], "codex");
        assert_eq!(c["from"]["name"], "ada");
        assert_eq!(locked_card(true)["wrong"], true);
        let mut out = std::collections::BTreeMap::new();
        let s = Session { ext: serde_json::from_value(json!({ PLUGIN_ID: k })).unwrap(), ..Session::default() };
        Shared.fields(&s, None, &mut out);
        assert_eq!(out["shared"]["url"], "https://g/s/s1");
    }
}
