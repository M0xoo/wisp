//! The Share dialog and the New task card (v1 /sessions/:id/share, /shares/peek), over `share.send` and
//! wisp Cloud's own commands: `share.create` sends the task (a spec, or a report with the work) to the
//! first ready destination and keeps its link on the task (`ext["wisp.share"]`, the list row's `shared`);
//! `share.stop` takes the link back (`grid-client.revoke`) and forgets it; `share.peek` fetches a pasted
//! link (`grid-client.fetch`) and describes it as the card shows it, locked or not.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::{Call, Code, Command, Ctx, Result, Setup, WireError};
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
    // the link kept before this one: taken back once the new one is made (unless the grid answered the same link)
    let before = calls::task(ctx, call, &a.session).await.map_or(Value::Null, |s| s.ext_of(PLUGIN_ID).clone());
    let again = before.get("url").is_some();
    let sent = ctx.run::<SendCmd>(call, args).await?;
    let at = ctx.clock().map_or(0, |c| c.now_ms());
    let keep = kept(&sent, locked, at);
    replace(ctx, call, &a.session, &before, &keep).await?;
    let props = json!({ "locked": locked, "work": if a.work { "report" } else { "none" }, "again": again });
    calls::warn("task_share not tracked", calls::track(ctx, "task_share", props).await);
    Ok(json!({ "url": keep["url"], "locked": locked, "at": at, "notes": [] }))
}

async fn stop(ctx: &Ctx, call: &Call, a: SessionArgs) -> Result<Value> {
    let task = calls::task(ctx, call, &a.session).await?;
    let Some(id) = task.ext_of(PLUGIN_ID).get("id").and_then(Value::as_str).map(str::to_owned) else {
        return Err(WireError::invalid("This task isn't shared."));
    };
    calls::revoke(ctx, call, id.clone()).await?;
    forget(ctx, call, &a.session, &id).await?;
    Ok(json!({ "ok": true }))
}

fn link_id(slot: &Value) -> Option<String> {
    slot.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// A link the grid no longer has is as good as taken back.
fn gone(r: Result<()>) -> Result<()> {
    match r {
        Err(e) if e.code == Code::NotFound => Ok(()),
        r => r,
    }
}

/// `keep` (a link just made) kept on the task in place of `before` (the slot as read before it was made). The old
/// link is taken back first (`grid-client.revoke`, as Stop sharing does), then the slot is written over what it held
/// (compare-and-set), so no live link is left that the task doesn't list:
/// - the grid answered the same link (the same task shared again is a new version of it): nothing is taken back;
/// - the old link can't be taken back: the new one is and the slot keeps the old one, still live;
/// - the slot can't be written: the new link is taken back (unless it is the same link, still listed) and the old
///   one (already taken back) forgotten;
/// - Stop sharing ran meanwhile (the slot held a link and now holds none): Stop wins. The grid keys a task's share
///   by the task, so its revoke may have landed after this Share's send and killed the very link answered here;
///   writing it back would list a link that answers 410. The link is taken back (again) and nothing is written;
/// - another Share wrote the slot meanwhile: its link, replaced here, is taken back too.
///
/// Whenever taking back a link made here fails, the error says it may still be live: never silently unlisted.
pub(crate) async fn replace(ctx: &Ctx, call: &Call, session: &str, before: &Value, keep: &Value) -> Result<()> {
    let new = link_id(keep);
    let was = link_id(before);
    let old = was.clone().filter(|o| new.as_ref() != Some(o));
    // the link this Share made: the same link answered again was made before it and is still listed, never taken back
    let made = new.clone().filter(|n| was.as_ref() != Some(n));
    if let Some(o) = &old
        && let Err(e) = gone(calls::revoke(ctx, call, o.clone()).await)
    {
        return Err(taken_back(ctx, call, made.as_deref(), keep, e).await);
    }
    let mut displaced = Value::Null;
    let mut stopped = false;
    let wrote = wisp_runtime_api::ext::update_ext(ctx, call, session, PLUGIN_ID, |slot: &Value, _: &Session| {
        displaced = slot.clone();
        stopped = was.is_some() && link_id(slot).is_none();
        Ok((!stopped).then(|| keep.clone()))
    })
    .await;
    if let Err(e) = wrote {
        let e = taken_back(ctx, call, made.as_deref(), keep, e).await;
        if let Some(o) = &old {
            calls::warn("the old link not forgotten", forget(ctx, call, session, o).await);
        }
        return Err(e);
    }
    if stopped {
        let e = WireError::conflict(
            "Sharing was stopped while this link was being made, so the task isn't shared. Share it again for a new link.",
        );
        return Err(taken_back(ctx, call, new.as_deref(), keep, e).await);
    }
    if let Some(d) = link_id(&displaced).filter(|d| new.as_ref() != Some(d) && old.as_ref() != Some(d)) {
        calls::warn("a replaced link not taken back", gone(calls::revoke(ctx, call, d).await));
    }
    Ok(())
}

/// `e`, once `link` (made here, never listed) is taken back; when it can't be, `e` also says the link may still be
/// live, so the user can stop it from wisp Cloud instead of it working unlisted.
async fn taken_back(ctx: &Ctx, call: &Call, link: Option<&str>, keep: &Value, mut e: WireError) -> WireError {
    let Some(n) = link else { return e };
    if let Err(r) = gone(calls::revoke(ctx, call, n.to_owned()).await) {
        let url = keep.get("url").and_then(Value::as_str).unwrap_or(n);
        e.message =
            format!("{} The link {url} may still be live: taking it back failed ({}). Stop it from wisp Cloud.", e.message, r.message);
    }
    e
}

/// The task's link `link` forgotten, in one compare-and-set: only while the slot still holds that link, so one
/// made meanwhile (Share again while Stop sharing ran) stays on the task instead of being forgotten unrevoked.
pub(crate) async fn forget(ctx: &Ctx, call: &Call, session: &str, link: &str) -> Result<()> {
    let still = |slot: &Value, _: &Session| Ok((slot.get("id").and_then(Value::as_str) == Some(link)).then_some(Value::Null));
    wisp_runtime_api::ext::update_ext(ctx, call, session, PLUGIN_ID, still).await.map(|_| ())
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

    /// wisp.grid-client's `revoke` only: records each id asked, refuses the ids in `fail` (unavailable) and `unknown`
    /// (not found). `dead` is the grid's own state, as apps/grid/src/shares.rs keeps it: a revoke kills a link, and a
    /// send for the same task (`send`, the share keyed by the task id) brings it back.
    #[derive(Debug, Clone, Default)]
    struct FakeGrid {
        asked: std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        fail: std::sync::Arc<std::sync::Mutex<Vec<&'static str>>>,
        unknown: Option<&'static str>,
        dead: std::sync::Arc<std::sync::Mutex<std::collections::BTreeSet<String>>>,
    }

    impl FakeGrid {
        fn failing(ids: &[&'static str]) -> Self {
            let g = Self::default();
            g.fail.lock().unwrap().extend_from_slice(ids);
            g
        }
        /// `share.send` reaching the grid: the task's link, live again.
        fn send(&self, id: &str) {
            self.dead.lock().unwrap().remove(id);
        }
        fn live(&self, id: &str) -> bool {
            !self.dead.lock().unwrap().contains(id)
        }
    }

    impl wisp_kernel::Plugin for FakeGrid {
        fn manifest(&self) -> wisp_kernel::Manifest {
            wisp_kernel::Manifest::from_value(
                json!({ "wispPlugin": 1, "id": "wisp.grid-client", "version": "2.0.0", "api": "^1", "activation": ["onStartup"] }),
            )
            .unwrap()
        }
        fn setup(&self, s: &mut Setup) -> Result<()> {
            let me = self.clone();
            s.command::<wisp_grid_client_api::Revoke, _, _>(move |_c, _call, a: wisp_grid_client_api::IdArgs| {
                me.asked.lock().unwrap().push(a.id.clone());
                let r = if me.fail.lock().unwrap().contains(&a.id.as_str()) {
                    Err(WireError::unavailable("the grid said 502"))
                } else if me.unknown == Some(a.id.as_str()) {
                    Err(WireError::not_found("You have no share with that id."))
                } else {
                    me.dead.lock().unwrap().insert(a.id.clone());
                    Ok(json!({ "id": a.id, "revoked": true }))
                };
                async move { r }
            });
            Ok(())
        }
    }

    fn link(id: &str) -> Value {
        json!({ "id": id, "url": format!("https://g/s/{id}"), "locked": false, "at": 1 })
    }

    /// The share plugin (its runtime and grid permissions) over `rt` and `grid`.
    async fn app(rt: impl wisp_kernel::Plugin + 'static, grid: FakeGrid) -> wisp_kernel::Kernel {
        let me = wisp_kernel::Declarative(
            wisp_kernel::Manifest::from_value(json!({ "wispPlugin": 1, "id": PLUGIN_ID, "version": "2.0.0", "api": "^1", "activation": ["onStartup"], "permissions": ["runtime:get", "runtime:setExt", "grid-client:revoke"] })).unwrap(),
        );
        wisp_testkit::TestApp::new().with(rt).with(grid).with(me).start().await
    }

    /// `replace` on task t1 holding `held`, with `grid` and a write landing first when `race` is set: the slot after,
    /// the ids revoked in order, and what it answered.
    async fn replaced(held: Value, keep: &Value, grid: FakeGrid, race: Option<Value>) -> (Value, Vec<String>, Result<()>) {
        use wisp_runtime_api::testing::SlotRuntime;
        let rt = SlotRuntime::new(Session { id: "t1".into(), ..Session::default() });
        if !held.is_null() {
            rt.set(PLUGIN_ID, held.clone());
        }
        let k = app(rt.clone(), grid.clone()).await;
        let ctx = k.ctx(PLUGIN_ID).unwrap();
        if let Some(r) = race {
            rt.race(PLUGIN_ID, r);
        }
        let r = replace(&ctx, &ctx.root_call(), "t1", &held, keep).await;
        let asked = grid.asked.lock().unwrap().clone();
        (rt.ext(PLUGIN_ID), asked, r)
    }

    /// Share again on a task that kept link s1: when the grid made a new link s2, s1 is taken back before s2 is kept
    /// (it kept working, unlisted, before); the same link answered again (a new version) is never taken back; a link
    /// the grid no longer has counts as taken back. If s1 can't be taken back, s2 is, and s1 stays listed and live
    /// (never two live links, never one unlisted); a link another Share kept meanwhile (s3) is taken back too.
    #[tokio::test]
    async fn a_link_replaced_by_share_again_is_taken_back() {
        let (s1, s2, s3) = (link("s1"), link("s2"), link("s3"));
        let (slot, asked, r) = replaced(s1.clone(), &s2, FakeGrid::default(), None).await;
        assert!(r.is_ok());
        assert_eq!((slot, asked), (s2.clone(), vec!["s1".to_owned()]));

        let (slot, asked, r) = replaced(s1.clone(), &link("s1"), FakeGrid::default(), None).await;
        assert!(r.is_ok());
        assert_eq!((slot["id"].clone(), asked.len()), (json!("s1"), 0), "the same link shared again stays live");

        let (slot, asked, r) = replaced(Value::Null, &s2, FakeGrid::default(), None).await;
        assert!(r.is_ok());
        assert_eq!((slot, asked.len()), (s2.clone(), 0), "a first share takes nothing back");

        let unknown = FakeGrid { unknown: Some("s1"), ..FakeGrid::default() };
        let (slot, _, r) = replaced(s1.clone(), &s2, unknown, None).await;
        assert!(r.is_ok());
        assert_eq!(slot, s2, "a link the grid no longer has is as good as taken back");

        let down = FakeGrid::failing(&["s1"]);
        let (slot, asked, r) = replaced(s1.clone(), &s2, down, None).await;
        assert_eq!(r.unwrap_err().code, Code::Unavailable);
        assert_eq!((slot, asked), (s1.clone(), vec!["s1".to_owned(), "s2".to_owned()]), "s1 stays listed, s2 is taken back");

        let (slot, asked, r) = replaced(s1.clone(), &s2, FakeGrid::default(), Some(s3)).await;
        assert!(r.is_ok());
        assert_eq!((slot, asked), (s2, vec!["s1".to_owned(), "s3".to_owned()]), "the link kept meanwhile goes too");
    }

    /// wisp.runtime whose task t1 holds `held` and whose `runtime.setExt` is always refused (the store is down).
    #[derive(Debug, Clone)]
    struct Unwritable(Value);

    impl wisp_kernel::Plugin for Unwritable {
        fn manifest(&self) -> wisp_kernel::Manifest {
            wisp_kernel::Manifest::from_value(
                json!({ "wispPlugin": 1, "id": "wisp.runtime", "version": "2.0.0", "api": "^1", "activation": ["onStartup"] }),
            )
            .unwrap()
        }
        fn setup(&self, s: &mut Setup) -> Result<()> {
            let held = self.0.clone();
            s.command::<wisp_runtime_api::commands::Get, _, _>(move |_c, _call, _a: wisp_runtime_api::commands::IdArgs| {
                let mut t = Session { id: "t1".into(), ..Session::default() };
                t.ext.insert(PLUGIN_ID.to_owned(), held.clone());
                async move { Ok(t) }
            });
            s.command::<wisp_runtime_api::commands::SetExt, _, _>(|_c, _call, _a: wisp_runtime_api::commands::SetExtArgs| async {
                Err::<wisp_runtime_api::commands::Ack, _>(WireError::unavailable("the store is down"))
            });
            Ok(())
        }
    }

    /// Share again where the grid answers the same link s1 (a new version) and the slot can't be written: s1 is still
    /// the task's listed link, so it is never taken back (it was, leaving the task listing a dead link). A new link s2
    /// in the same spot is taken back (it was never listed).
    #[tokio::test]
    async fn a_failed_write_never_takes_back_the_link_still_listed() {
        for (keep, revoked) in [(link("s1"), vec![]), (link("s2"), vec!["s1".to_owned(), "s2".to_owned()])] {
            let grid = FakeGrid::default();
            let k = app(Unwritable(link("s1")), grid.clone()).await;
            let ctx = k.ctx(PLUGIN_ID).unwrap();
            let r = replace(&ctx, &ctx.root_call(), "t1", &link("s1"), &keep).await;
            assert_eq!(r.unwrap_err().code, Code::Unavailable);
            assert_eq!(grid.asked.lock().unwrap().clone(), revoked, "kept {}", keep["id"]);
        }
    }

    /// Stop sharing takes link s1 back while Share again keeps s2 on the task: s2 stays (it's live, not revoked),
    /// where the plain write forgot it. With nothing newer, the slot is cleared.
    #[tokio::test]
    async fn a_link_made_while_stop_sharing_runs_is_not_forgotten() {
        use wisp_runtime_api::testing::{SlotRuntime, caller};
        let rt = SlotRuntime::new(Session { id: "t1".into(), ..Session::default() });
        rt.set(PLUGIN_ID, json!({ "id": "s1", "url": "https://g/s/s1" }));
        let k = wisp_testkit::TestApp::new().with(rt.clone()).with(caller(PLUGIN_ID)).start().await;
        let ctx = k.ctx(PLUGIN_ID).unwrap();
        rt.race(PLUGIN_ID, json!({ "id": "s2", "url": "https://g/s/s2" }));
        forget(&ctx, &ctx.root_call(), "t1", "s1").await.unwrap();
        assert_eq!(rt.ext(PLUGIN_ID)["id"], "s2");
        forget(&ctx, &ctx.root_call(), "t1", "s2").await.unwrap();
        assert_eq!(rt.ext(PLUGIN_ID), Value::Null);
    }

    /// Share again on t1 (link s1; the grid keys a task's share by the task, so it answers s1 again) with Stop sharing
    /// run between Share's send and its write, its revoke landing before or after the send reaches the grid. After
    /// both, the task lists a link only if it works: Stop wins, nothing is listed and s1 answers 410 (the task listed
    /// s1 while the grid answered 410). Share says why.
    #[tokio::test]
    async fn stop_sharing_inside_share_again_never_leaves_a_dead_link_listed() {
        use wisp_runtime_api::testing::SlotRuntime;
        for stop_lands_first in [false, true] {
            let rt = SlotRuntime::new(Session { id: "t1".into(), ..Session::default() });
            rt.set(PLUGIN_ID, link("s1"));
            let grid = FakeGrid::default();
            let k = app(rt.clone(), grid.clone()).await;
            let ctx = k.ctx(PLUGIN_ID).unwrap();
            let call = ctx.root_call();
            let before = rt.ext(PLUGIN_ID);
            if stop_lands_first {
                stop(&ctx, &call, SessionArgs { session: "t1".into() }).await.unwrap();
                grid.send("s1");
            } else {
                grid.send("s1");
                stop(&ctx, &call, SessionArgs { session: "t1".into() }).await.unwrap();
            }
            let r = replace(&ctx, &call, "t1", &before, &link("s1")).await;
            let listed = link_id(&rt.ext(PLUGIN_ID));
            assert_eq!(listed.is_some(), grid.live("s1"), "listed iff live (Stop's revoke first: {stop_lands_first})");
            assert_eq!((listed, grid.live("s1")), (None, false), "Stop wins (Stop's revoke first: {stop_lands_first})");
            assert_eq!(r.unwrap_err().code, Code::Conflict);
        }
    }

    /// Cleanup that can't take back a link made here says so: the error names the link as maybe still live (it was
    /// only logged, leaving it working and unlisted). Old s1 can't be taken back, nor can new s2; the slot can't be
    /// written and s2 can't be taken back; Stop sharing ran meanwhile and the link can't be taken back again.
    #[tokio::test]
    async fn a_link_cleanup_cannot_take_back_is_reported_as_maybe_live() {
        use wisp_runtime_api::testing::SlotRuntime;
        let live = |e: WireError, url: &str| e.message.contains("may still be live") && e.message.contains(url);
        let (_, asked, r) = replaced(link("s1"), &link("s2"), FakeGrid::failing(&["s1", "s2"]), None).await;
        assert_eq!(asked, vec!["s1".to_owned(), "s2".to_owned()]);
        assert!(live(r.unwrap_err(), "https://g/s/s2"));

        let k = app(Unwritable(link("s1")), FakeGrid::failing(&["s2"])).await;
        let ctx = k.ctx(PLUGIN_ID).unwrap();
        let e = replace(&ctx, &ctx.root_call(), "t1", &link("s1"), &link("s2")).await.unwrap_err();
        assert_eq!(e.code, Code::Unavailable);
        assert!(live(e, "https://g/s/s2"));

        let rt = SlotRuntime::new(Session { id: "t1".into(), ..Session::default() });
        rt.set(PLUGIN_ID, link("s1"));
        let grid = FakeGrid::default();
        let k = app(rt.clone(), grid.clone()).await;
        let ctx = k.ctx(PLUGIN_ID).unwrap();
        stop(&ctx, &ctx.root_call(), SessionArgs { session: "t1".into() }).await.unwrap();
        grid.send("s1");
        grid.fail.lock().unwrap().push("s1");
        let e = replace(&ctx, &ctx.root_call(), "t1", &link("s1"), &link("s1")).await.unwrap_err();
        assert_eq!(e.code, Code::Conflict);
        assert!(live(e, "https://g/s/s1"));
        assert_eq!(rt.ext(PLUGIN_ID), Value::Null);

        let (_, _, r) = replaced(link("s1"), &link("s2"), FakeGrid::failing(&["s1"]), None).await;
        assert!(!r.unwrap_err().message.contains("may still be live"), "s2 taken back: nothing live to report");
    }
}
