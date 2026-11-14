//! wisp.later's calls to other plugins, through their typed commands (`wisp-runtime-api`, `wisp-budget-api`,
//! `wisp-telemetry-api`). What later only reports on (the list row's mirror, a reminder's note, a usage stat) is
//! logged when refused; what the caller answers with is returned.

use serde_json::{Map, Value};
use wisp_budget_api::{PlanHold, commands as b};
use wisp_kernel::{Call, Code, Ctx, Result, WireError};
use wisp_later_api::{LaterHeld, PLUGIN_ID};
use wisp_later_core::{Task, TaskState};
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands as r;
use wisp_runtime_api::model::{Attachment, Session, SessionState};
use wisp_runtime_api::paths::Folder;
use wisp_telemetry_api as tel;

/// A state as wisp.runtime names it on the wire (`running`, `waiting`, …).
fn state_name(s: SessionState) -> String {
    serde_json::to_value(s).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

/// What wisp.later needs of a task, as `runtime.get` answers it.
pub(crate) fn task_of_session(s: &Session) -> Task {
    let st = state_name(s.state);
    Task {
        id: s.id.0.clone(),
        title: s.title.clone(),
        agent: s.agent.clone(),
        account: s.account.as_deref().filter(|a| !a.is_empty()).unwrap_or("default").to_owned(),
        state: TaskState::parse(&st).unwrap_or(TaskState::Review),
        archived: s.archived,
        busy: s.state == SessionState::Running,
        asking: s.state == SessionState::Waiting || !s.ext_of("wisp.runtime")["ask"].is_null(),
        delegates: false,
        sub: s.parent_id.is_some(),
        tour: s.agent == "wisp",
    }
}

/// `runtime.get`: Ok(None) when the task is gone (not found); any other refusal (runtime starting, a read that
/// failed) is an Err, so a caller never takes a task that couldn't be read for one that went.
pub(crate) async fn task(ctx: &Ctx, call: &Call, id: &str) -> Result<Option<Task>> {
    match ctx.run::<r::Get>(call, r::IdArgs { id: SessionId(id.to_owned()) }).await {
        Ok(s) => Ok(Some(task_of_session(&s))),
        Err(e) if e.code == Code::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// `budget.hold` for `t`'s account (none, logged at debug, when refused: as if nothing held it).
pub(crate) async fn hold(ctx: &Ctx, call: &Call, t: &Task) -> Option<LaterHeld> {
    match ctx.run::<b::Hold>(call, b::AccountArgs { agent: t.agent.clone(), account: t.account.clone() }).await {
        Ok(h) => h.map(|h| held_of(&h)),
        Err(err) => {
            // asked on every look: a switched-off budget would flood the log at warn
            tracing::debug!(error = %err.message, "later: budget.hold");
            None
        }
    }
}

/// A budget hold as a later entry keeps it.
pub(crate) fn held_of(h: &PlanHold) -> LaterHeld {
    LaterHeld { why: h.why.clone(), until: h.until, load: h.load }
}

/// `runtime.setExt`: the task's list row shows what is scheduled (logged when refused). `now()` gives the row's value
/// from later's entries as they are, asked again if another write landed between the read and the write, so of two
/// mirrors at once the one computed from older entries never lands last.
pub(crate) async fn mirror(ctx: &Ctx, call: &Call, id: &str, mut now: impl FnMut() -> Option<Value> + Send) {
    if let Err(err) = wisp_runtime_api::ext::update_ext(ctx, call, id, PLUGIN_ID, |_, _| Ok(now())).await {
        tracing::warn!(error = %err.message, task = id, "later: runtime.setExt");
    }
}

/// `runtime.followUp` by `later`, with the entry's attachments (each one runtime's own shape).
pub(crate) async fn follow_up(ctx: &Ctx, call: &Call, id: &str, text: String, attachments: &[Value]) -> Result<r::FollowedUp> {
    let attachments = attachments_of(attachments)?;
    let a = r::FollowUpArgs { id: SessionId(id.to_owned()), text, attachments, by: Some("later".into()), ..r::FollowUpArgs::default() };
    ctx.run::<r::FollowUp>(call, a).await
}

/// An entry's attachments as runtime takes them; one that isn't runtime's shape refuses the send (as runtime did).
fn attachments_of(v: &[Value]) -> Result<Vec<Attachment>> {
    v.iter()
        .map(|a| serde_json::from_value(a.clone()).map_err(|e| WireError::invalid(format!("an attachment isn't one runtime knows: {e}"))))
        .collect()
}

/// `runtime.note`: the reminder's text in the task's transcript (logged when refused).
pub(crate) async fn note(ctx: &Ctx, call: &Call, id: &str, label: String) {
    let a = r::NoteArgs { id: SessionId(id.to_owned()), turn_id: None, tone: None, label };
    if let Err(err) = ctx.run::<r::Note>(call, a).await {
        tracing::warn!(error = %err.message, task = id, "later: runtime.note");
    }
}

/// `runtime.forLater`.
pub(crate) async fn for_later(ctx: &Ctx, call: &Call, id: &str, on: bool, at: Option<i64>) -> Result<()> {
    ctx.run::<r::ForLater>(call, r::ForLaterArgs { id: SessionId(id.to_owned()), for_later: on, at }).await.map(drop)
}

/// `runtime.setState` to `state` (a wire name: `review`, `done`, …).
pub(crate) async fn set_state(ctx: &Ctx, call: &Call, id: &str, state: &str) -> Result<()> {
    let state: SessionState =
        serde_json::from_value(Value::String(state.to_owned())).map_err(|_| WireError::invalid(format!("{state} isn't a task state.")))?;
    ctx.run::<r::SetState>(call, r::SetStateArgs { id: SessionId(id.to_owned()), state }).await.map(drop)
}

/// The task a plan starts: its launch body as runtime's `StartArgs`, by `later`. A `cwd` that isn't a full path
/// (empty, `.`, relative) is left out, so the runtime picks its own folder instead of resolving it against the
/// server's.
pub(crate) fn start_args(body: Option<&Value>) -> Result<r::StartArgs> {
    let mut a: r::StartArgs = serde_json::from_value(body.cloned().unwrap_or_else(|| Value::Object(Map::new())))
        .map_err(|e| WireError::invalid(format!("a plan's task isn't one runtime can start: {e}")))?;
    a.by = Some("later".into());
    a.cwd = a.cwd.and_then(|c| match Folder::of(&c) {
        Ok(f) => Some(f.to_string()),
        Err(e) => {
            tracing::warn!(error = %e, "later: a plan's folder");
            None
        }
    });
    Ok(a)
}

/// `runtime.create` for a plan's launch body.
pub(crate) async fn create(ctx: &Ctx, call: &Call, body: Option<&Value>) -> Result<String> {
    let a = start_args(body)?;
    ctx.run::<r::Create>(call, a).await.map(|c| c.id.0)
}

/// `telemetry.track` (logged when refused).
pub(crate) async fn track(ctx: &Ctx, event: &str, props: Map<String, Value>) {
    if let Err(err) = ctx.run::<tel::Track>(&ctx.root_call(), tel::TrackArgs { event: event.into(), props }).await {
        tracing::warn!(error = %err.message, event, "later: telemetry.track");
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(v: &Value) -> Session {
        let mut base = json!({ "id": "t1", "title": "Fix it", "agent": "claude", "model": "", "effort": "", "mode": "auto", "cwd": "/r",
            "state": "review", "createdAt": 0, "updatedAt": 0 });
        base.as_object_mut().unwrap().extend(v.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    /// The task later reads off `runtime.get`'s typed answer: busy while it runs, asking while it waits or holds a
    /// question, its account `default` when blank, a sub when it has a lead.
    #[test]
    fn a_task_is_read_from_the_typed_session() {
        let t = task_of_session(&session(&json!({ "state": "running", "account": "" })));
        assert_eq!(
            (t.busy, t.asking, t.account.as_str(), t.state, t.sub, t.tour),
            (true, false, "default", TaskState::Running, false, false)
        );
        let t = task_of_session(&session(&json!({ "state": "waiting", "parentId": "lead", "agent": "wisp", "account": "work" })));
        assert_eq!((t.busy, t.asking, t.account.as_str(), t.state, t.sub, t.tour), (false, true, "work", TaskState::Review, true, true));
        let t = task_of_session(&session(&json!({ "ext": { "wisp.runtime": { "ask": { "q": "?" } } }, "archived": true })));
        assert!(t.asking && t.archived && !t.busy);
    }

    /// A plan's task with a blank or relative folder starts without one (the runtime's default), never with a path
    /// the server would resolve against its own folder; it always goes by `later`.
    #[test]
    fn a_plan_never_starts_a_task_in_a_folder_that_isnt_a_full_path() {
        let cwd = |c: Value| start_args(Some(&json!({ "prompt": "p", "cwd": c }))).unwrap().cwd;
        assert_eq!(cwd(json!("/repo")), Some("/repo".to_owned()));
        assert_eq!(cwd(json!("")), None);
        assert_eq!(cwd(json!(".")), None);
        assert_eq!(cwd(json!("src")), None);
        let a = start_args(Some(&json!({ "prompt": "p", "by": "you" }))).unwrap();
        assert_eq!((a.by.as_deref(), a.cwd), (Some("later"), None));
        assert!(start_args(Some(&json!({ "prompt": 3 }))).is_err(), "a body runtime can't start is refused here");
    }

    /// A reminder's note is runtime.note's shape (`label`), not v1's `text`, which runtime refused.
    #[test]
    fn a_reminder_note_carries_a_label() {
        let a = r::NoteArgs { id: SessionId("t1".into()), turn_id: None, tone: None, label: "call back".into() };
        assert_eq!(serde_json::to_value(a).unwrap()["label"], "call back");
        assert!(
            serde_json::from_value::<r::NoteArgs>(json!({ "id": "t1", "text": "call back" })).is_err(),
            "the old shape never reached the task"
        );
    }

    #[test]
    fn a_state_that_isnt_one_is_refused() {
        assert!(serde_json::from_value::<SessionState>(json!("review")).is_ok());
        assert!(serde_json::from_value::<SessionState>(json!("nope")).is_err());
    }

    /// Two mirrors at once: the one computed from older entries (one scheduled) reads, the newer one (two) lands
    /// first; the older is refused, asks the entries again, and the row says two, never the stale one.
    #[tokio::test]
    async fn a_mirror_from_older_entries_never_lands_last() {
        use wisp_runtime_api::testing::{SlotRuntime, caller};
        let rt = SlotRuntime::new(Session { id: "t1".into(), ..Session::default() });
        let k = wisp_testkit::TestApp::new().with(rt.clone()).with(caller(PLUGIN_ID)).start().await;
        let ctx = k.ctx(PLUGIN_ID).unwrap();
        rt.race(PLUGIN_ID, json!({ "count": 2 }));
        // the entries as they are at each ask: one when it first read, two once the other mirror's change landed
        let mut asked = 0;
        mirror(&ctx, &ctx.root_call(), "t1", || {
            asked += 1;
            Some(json!({ "count": if asked == 1 { 1 } else { 2 } }))
        })
        .await;
        assert_eq!((rt.ext(PLUGIN_ID), asked), (json!({ "count": 2 }), 2));
    }
}
