//! A task's life through the host, end to end on the simulated proc service: v1 e2e.test.js's cases
//! ("a task is named after its first answer's topic", "stopping a running session marks the turn stopped",
//! "an interrupting follow-up keeps the task in Working", "queued follow-ups can be changed and
//! reordered"), the `before:run` interceptor holding or vetoing a run, and a restart's unfinished turns.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{rig, rig_with, until};
use wisp_runtime::{Emitted, Recorder};
use wisp_runtime_api::commands::{FollowUpArgs, ListArgs, QueueEditArgs, StartArgs};
use wisp_runtime_api::model::{Activity, QueueItem, SessionState, TurnStatus};

fn start(prompt: &str) -> StartArgs {
    StartArgs {
        prompt: prompt.into(),
        cwd: Some("/tmp".into()),
        ..StartArgs::default()
    }
}

fn follow(id: &wisp_runtime_api::SessionId, text: &str, queue: bool) -> FollowUpArgs {
    FollowUpArgs {
        id: id.clone(),
        text: text.into(),
        queue: Some(queue),
        ..FollowUpArgs::default()
    }
}

async fn last_status(r: &common::Rig, id: &str) -> Option<TurnStatus> {
    r.rt.turns(id, None, Some(1))
        .await
        .unwrap()
        .pop()
        .map(|t| t.status)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_runs_its_first_turn_and_is_named_after_its_topic() {
    let r = rig().await;
    let c = r.rt.create(start("fix the login")).await.unwrap();
    let id = c.id.0.clone();
    until("the turn to end", || async {
        last_status(&r, &id).await == Some(TurnStatus::Done)
    })
    .await;
    until("the run to let go", || async {
        r.sim.spawned().len() == 1
            && r.rt.list(&ListArgs::default())[0].state == SessionState::Review
    })
    .await;
    let s = r.rt.get(&id).await.unwrap();
    assert_eq!(s.title, "Topic of fix the login");
    assert_eq!(s.resume_id.as_deref(), Some("conv-1"));
    assert!(s.unread);
    let t = r.rt.turns(&id, None, None).await.unwrap().pop().unwrap();
    assert_eq!(
        t.presentation.as_ref().unwrap().blocks[0]["summary"],
        "done: fix the login"
    );
    assert_eq!(t.changed_files, Some(1));
    assert_eq!(t.stats.as_ref().unwrap().cost_usd, Some(0.01));
    let steps = r.rt.activity(t.id.as_str(), None).await.unwrap().items;
    assert!(matches!(&steps[0].activity, Activity::Tool { label, .. } if label == "Run tests"));
    assert!(steps.windows(2).all(|w| w[0].seq < w[1].seq));
    let row = &r.rt.list(&ListArgs::default())[0];
    assert_eq!(
        (row.status.as_str(), row.preview.as_str(), row.turn_count),
        ("done", "done: fix the login", 1)
    );
    let names = r.host.names();
    let pos = |n: &str| {
        names
            .iter()
            .position(|x| *x == n)
            .unwrap_or_else(|| panic!("{n} in {names:?}"))
    };
    assert!(
        pos("session.created") < pos("turn.started")
            && pos("turn.started") < pos("turn.activity")
            && pos("turn.activity") < pos("turn.ended")
    );
    assert!(names.contains(&"turn.finished"));
    // the system prompt went to the harness, the prompt as its argument
    assert_eq!(r.sim.spawned()[0].args[0], "fix the login");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_run_shows_the_harness_error() {
    let r = rig().await;
    let id = r.rt.create(start("fail now")).await.unwrap().id.0;
    until("the turn to fail", || async {
        last_status(&r, &id).await == Some(TurnStatus::Error)
    })
    .await;
    let t = r.rt.turns(&id, None, None).await.unwrap().pop().unwrap();
    let hero = &t.presentation.unwrap().blocks[0];
    assert_eq!(
        (hero["title"].as_str(), hero["summary"].as_str()),
        (Some("Fake CLI failed"), Some("Error: boom"))
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_follow_up_while_running_interrupts_and_runs_next_without_a_notification() {
    let r = rig().await;
    let id = r.rt.create(start("slow work")).await.unwrap().id;
    until("the run to report its conversation", || async {
        !r.rt
            .activity(
                &r.rt.turns(id.as_str(), None, Some(1)).await.unwrap()[0]
                    .id
                    .0,
                None,
            )
            .await
            .unwrap()
            .items
            .is_empty()
    })
    .await;
    r.host.taken();
    r.rt.follow_up(follow(&id, "do this instead", false))
        .await
        .unwrap();
    until("the follow-up's turn to end", || async {
        r.rt.turns(id.as_str(), None, None).await.unwrap().len() == 2
            && last_status(&r, id.as_str()).await == Some(TurnStatus::Done)
    })
    .await;
    let turns = r.rt.turns(id.as_str(), None, None).await.unwrap();
    assert_eq!(turns[0].status, TurnStatus::Stopped);
    assert_eq!(
        turns[0].presentation.as_ref().unwrap().blocks[0]["title"],
        "Interrupted"
    );
    // the follow-up resumed the conversation
    assert!(
        r.sim.spawned()[1]
            .args
            .iter()
            .any(|a| a == "--resume=conv-1")
    );
    let finished: Vec<_> = r
        .host
        .taken()
        .into_iter()
        .filter_map(|e| {
            if let Emitted::Finished(f) = e {
                Some(f.turn_id)
            } else {
                None
            }
        })
        .collect();
    assert_eq!(
        finished,
        vec![turns[1].id.clone()],
        "no notification for the run it replaced"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_holds_the_queue_and_your_next_message_carries_it_on() {
    let r = rig().await;
    let id = r.rt.create(start("slow work")).await.unwrap().id;
    until("the run to start", || async { r.sim.spawned().len() == 1 }).await;
    r.rt.follow_up(follow(&id, "queued one", true))
        .await
        .unwrap();
    r.rt.stop(id.as_str(), false).await.unwrap();
    until("the turn to stop", || async {
        last_status(&r, id.as_str()).await == Some(TurnStatus::Stopped)
    })
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let s = r.rt.get(id.as_str()).await.unwrap();
    assert!(s.queue_held);
    assert_eq!(s.queue.len(), 1, "a Stop never discards queued follow-ups");
    assert_eq!(
        r.sim.spawned().len(),
        1,
        "nothing goes out by itself after a Stop"
    );
    let t =
        r.rt.turns(id.as_str(), None, None)
            .await
            .unwrap()
            .pop()
            .unwrap();
    assert_eq!(t.presentation.unwrap().blocks[0]["title"], "Stopped");
    // your next message goes now, and the held one after it
    r.rt.follow_up(follow(&id, "carry on", true)).await.unwrap();
    until("both to run", || async {
        r.rt.turns(id.as_str(), None, None).await.unwrap().len() == 3
            && last_status(&r, id.as_str()).await == Some(TurnStatus::Done)
    })
    .await;
    let prompts: Vec<String> =
        r.rt.turns(id.as_str(), None, None)
            .await
            .unwrap()
            .into_iter()
            .map(|t| t.prompt)
            .collect();
    assert_eq!(prompts, ["slow work", "carry on", "queued one"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn queued_follow_ups_can_be_edited_reordered_merged_and_taken_back() {
    let r = rig().await;
    let id = r.rt.create(start("slow work")).await.unwrap().id;
    until("the run to start", || async { r.sim.spawned().len() == 1 }).await;
    for t in ["one", "two", "three"] {
        r.rt.follow_up(follow(&id, t, true)).await.unwrap();
    }
    let q = r.rt.get(id.as_str()).await.unwrap().queue;
    let ids: Vec<String> = q.iter().map(|x| x.id.clone()).collect();
    r.rt.queue_text(id.as_str(), &ids[0], "one, edited")
        .await
        .unwrap();
    let order = vec![QueueItem {
        id: ids[2].clone(),
        text: "three".into(),
        ..QueueItem::default()
    }];
    r.rt.queue_edit(QueueEditArgs {
        id: id.clone(),
        items: order,
        remove: vec![],
        held: None,
    })
    .await
    .unwrap();
    let texts = |q: Vec<QueueItem>| q.into_iter().map(|x| x.text).collect::<Vec<_>>();
    assert_eq!(
        texts(r.rt.get(id.as_str()).await.unwrap().queue),
        ["three", "one, edited", "two"]
    );
    r.rt.queue_merge(id.as_str(), &[ids[0].clone(), ids[1].clone()])
        .await
        .unwrap();
    assert_eq!(
        texts(r.rt.get(id.as_str()).await.unwrap().queue),
        ["three", "one, edited\n\ntwo"]
    );
    r.rt.queue_edit(QueueEditArgs {
        id: id.clone(),
        items: vec![],
        remove: vec![ids[2].clone()],
        held: None,
    })
    .await
    .unwrap();
    assert_eq!(r.rt.get(id.as_str()).await.unwrap().queue.len(), 1);
    r.rt.stop(id.as_str(), true).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn before_run_can_veto_or_hold_a_run() {
    let r = rig_with(Recorder {
        veto: Some("Daily budget $20 reached ($20.40)".into()),
        ..Recorder::default()
    })
    .await;
    let id = r.rt.create(start("anything")).await.unwrap().id;
    let t =
        r.rt.turns(id.as_str(), None, None)
            .await
            .unwrap()
            .pop()
            .unwrap();
    assert_eq!(t.status, TurnStatus::Error);
    assert_eq!(
        t.presentation.unwrap().blocks[0]["summary"],
        "Daily budget $20 reached ($20.40)"
    );
    assert_eq!(r.sim.spawned().len(), 0, "nothing spawned");
    let r = rig_with(Recorder {
        hold: Some("limit".into()),
        ..Recorder::default()
    })
    .await;
    let id = r.rt.create(start("held work")).await.unwrap().id;
    let t =
        r.rt.turns(id.as_str(), None, None)
            .await
            .unwrap()
            .pop()
            .unwrap();
    assert_eq!(t.status, TurnStatus::Held);
    assert!(r.host.names().contains(&"turn.held"));
    assert_eq!(r.rt.list(&ListArgs::default())[0].status, "held");
    // Skip: it stays, stopped, saying why
    r.rt.release(id.as_str(), t.id.as_str(), false)
        .await
        .unwrap();
    assert_eq!(
        last_status(&r, id.as_str()).await,
        Some(TurnStatus::Stopped)
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn edits_reads_and_delete() {
    let r = rig().await;
    let id = r.rt.create(start("x")).await.unwrap().id.0;
    until("the turn to end", || async {
        last_status(&r, &id).await == Some(TurnStatus::Done)
    })
    .await;
    r.rt.rename(&id, "  Named  ").await.unwrap();
    r.rt.archive(&id, true).await.unwrap();
    r.rt.set_ext(&id, "wisp.goal", serde_json::json!({"text": "green"}))
        .await
        .unwrap();
    let s = r.rt.get(&id).await.unwrap();
    assert_eq!((s.title.as_str(), s.archived), ("Named", true));
    assert_eq!(s.ext["wisp.goal"]["text"], "green");
    assert_eq!(
        r.rt.list(&ListArgs {
            archived: Some(false),
            limit: None
        })
        .len(),
        0
    );
    assert!(r.rt.rename(&id, " ").await.is_err());
    let hits = r.rt.search("Named", 10).await.unwrap();
    assert_eq!(hits.len(), 1);
    r.rt.delete(&id).await.unwrap();
    assert!(r.rt.get(&id).await.is_err());
    assert_eq!(r.rt.list(&ListArgs::default()).len(), 0);
    assert!(r.host.names().contains(&"session.deleted"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_marks_turns_it_left_running_as_stopped() {
    let r = rig().await;
    let id = r.rt.create(start("slow work")).await.unwrap().id.0;
    until("the run to start", || async { r.sim.spawned().len() == 1 }).await;
    // a second runtime over the same store, as after a crash
    let rt2 = wisp_runtime::Runtime::new(
        wisp_runtime::repo::Repo::new(r.store.clone()),
        r.host.clone(),
        std::sync::Arc::new(wisp_proc::sim::SimProc::new()),
        std::sync::Arc::new(wisp_store::SystemClock),
    );
    rt2.start().await.unwrap();
    let t = rt2.turns(&id, None, None).await.unwrap().pop().unwrap();
    assert_eq!(t.status, TurnStatus::Stopped);
    assert!(
        t.presentation.unwrap().blocks[0]["summary"]
            .as_str()
            .unwrap()
            .contains("wisp restarted")
    );
    r.rt.stop(&id, true).await.unwrap();
}

/// The task page's own controls: mode and harness pickers, For later, the composer queue's drag order and ✕, and
/// Later's Start/Skip when no turn id is at hand (`runtime.held` finds the held turn; nothing held is a conflict).
#[tokio::test(flavor = "multi_thread")]
async fn mode_agent_for_later_and_queue_order_and_cancel_change_the_task() {
    use wisp_runtime_api::model::Mode;
    let r = rig().await;
    let id = r.rt.create(start("slow work")).await.unwrap().id;
    until("the run to start", || async { r.sim.spawned().len() == 1 }).await;
    r.rt.set_mode(id.as_str(), Mode::Plan).await.unwrap();
    r.rt.set_agent(id.as_str(), "codex").await.unwrap();
    assert!(r.rt.set_agent(id.as_str(), "  ").await.is_err(), "an empty harness is refused");
    r.rt.for_later(id.as_str(), true, None).await.unwrap();
    let s = r.rt.get(id.as_str()).await.unwrap();
    assert_eq!(s.mode, Mode::Plan);
    assert_eq!(s.agent, "codex");
    assert_eq!(s.ext["wisp.runtime"]["forLater"]["by"], "you");
    r.rt.for_later(id.as_str(), false, None).await.unwrap();
    assert!(r.rt.get(id.as_str()).await.unwrap().ext["wisp.runtime"].get("forLater").is_none());
    for t in ["one", "two", "three"] {
        r.rt.follow_up(follow(&id, t, true)).await.unwrap();
    }
    let ids: Vec<String> = r.rt.get(id.as_str()).await.unwrap().queue.iter().map(|x| x.id.clone()).collect();
    r.rt.queue_order(id.as_str(), &[ids[2].clone(), ids[0].clone(), ids[1].clone()]).await.unwrap();
    r.rt.queue_cancel(id.as_str(), &ids[0]).await.unwrap();
    let texts: Vec<String> = r.rt.get(id.as_str()).await.unwrap().queue.into_iter().map(|x| x.text).collect();
    assert_eq!(texts, ["three", "two"]);
    assert!(r.rt.held(id.as_str(), true).await.is_err(), "nothing is held: a conflict, not a silent no-op");
    r.rt.stop(id.as_str(), true).await.unwrap();
}

/// What a plugin keeps on a turn just before it runs (`RunPart::before_turn`: git's checkpoint for the
/// turn's rollback) is on the turn as saved.
#[tokio::test(flavor = "multi_thread")]
async fn a_turn_keeps_what_run_parts_give_it_before_it_runs() {
    struct Keep;
    impl wisp_runtime_api::points::RunPart for Keep {
        fn id(&self) -> &'static str {
            "wisp.git"
        }
        fn before_turn(&self, s: &wisp_runtime_api::model::Session) -> wisp_kernel::BoxFuture<'static, Option<(String, serde_json::Value)>> {
            let cwd = s.cwd.clone();
            Box::pin(async move { Some(("wisp.git".to_owned(), serde_json::json!({ "checkpoint": { "to": "snap", "head": "head" }, "cwd": cwd }))) })
        }
    }
    let r = rig_with(Recorder { parts: vec![std::sync::Arc::new(Keep)], ..Recorder::default() }).await;
    let id = r.rt.create(start("slow work")).await.unwrap().id;
    until("the run to start", || async { r.sim.spawned().len() == 1 }).await;
    let turns = r.rt.turns(id.as_str(), None, None).await.unwrap();
    assert_eq!(turns[0].ext["wisp.git"]["checkpoint"]["to"], "snap");
    r.rt.stop(id.as_str(), true).await.unwrap();
}

/// An `app` block's state lands on its own turn, next to other blocks'; a turn of another task is refused.
/// `runtime.exec` refuses an empty command before running anything.
#[tokio::test(flavor = "multi_thread")]
async fn an_app_blocks_state_is_kept_on_its_turn_and_exec_needs_a_command() {
    let r = rig().await;
    let id = r.rt.create(start("slow work")).await.unwrap().id;
    until("the run to start", || async { r.sim.spawned().len() == 1 }).await;
    let turn = r.rt.turns(id.as_str(), None, None).await.unwrap()[0].id.clone();
    r.rt.app_state(id.as_str(), turn.as_str(), "b1", serde_json::json!({ "n": 1 })).await.unwrap();
    r.rt.app_state(id.as_str(), turn.as_str(), "b2", serde_json::json!("x")).await.unwrap();
    let t = &r.rt.turns(id.as_str(), None, None).await.unwrap()[0];
    assert_eq!(t.ext["wisp.apps"]["b1"]["n"], 1);
    assert_eq!(t.ext["wisp.apps"]["b2"], "x");
    let other = r.rt.create(start("other")).await.unwrap().id;
    assert!(r.rt.app_state(other.as_str(), turn.as_str(), "b1", serde_json::json!(0)).await.is_err(), "not that task's turn");
    assert!(r.rt.app_state(id.as_str(), turn.as_str(), " ", serde_json::json!(0)).await.is_err(), "a block id is needed");
    assert!(r.rt.exec(id.as_str(), "  ").await.is_err());
    r.rt.stop(id.as_str(), true).await.unwrap();
    r.rt.stop(other.as_str(), true).await.unwrap();
}

/// A stand-in Auto: picks `fake · m1 · high` and keeps what it was told.
#[derive(Default)]
struct Auto {
    picks: std::sync::Mutex<u32>,
    told: std::sync::Mutex<Vec<String>>,
}

impl wisp_router_api::service::RouterApi for Auto {
    fn pick(&self, _call: &wisp_kernel::Call, req: wisp_router_api::service::PickRequest) -> wisp_kernel::Result<Option<wisp_router_api::Pick>> {
        *self.picks.lock().unwrap() += 1;
        assert_eq!(req.choose.prompt, "fix the login");
        let route = wisp_router_api::Route { key: "fake:m1:high".into(), kind: "bug".into(), ..wisp_router_api::Route::default() };
        Ok(Some(wisp_router_api::Pick { agent: "fake".into(), model: "m1".into(), effort: "high".into(), key: "fake:m1:high".into(), label: "Fake".into(), route }))
    }
    fn classify(&self, _call: &wisp_kernel::Call, _err: &wisp_router_api::service::RunError) -> wisp_kernel::Result<Option<wisp_router_api::Limit>> {
        Ok(None)
    }
    fn report(&self, _call: &wisp_kernel::Call, o: wisp_router_api::service::Outcome) -> wisp_kernel::Result<()> {
        let kind = serde_json::to_value(&o).unwrap()["kind"].as_str().unwrap_or_default().to_owned();
        self.told.lock().unwrap().push(kind);
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_on_auto_runs_on_the_routers_pick_and_teaches_it() {
    let auto = std::sync::Arc::new(Auto::default());
    let r = rig_with(Recorder { router: Some(auto.clone()), ..Recorder::default() }).await;
    let c = r.rt.create(StartArgs { agent: Some("auto".into()), ..start("fix the login") }).await.unwrap();
    let s = r.rt.get(c.id.as_str()).await.unwrap();
    assert_eq!((s.agent.as_str(), s.model.as_str(), s.effort.as_str()), ("fake", "m1", "high"));
    assert_eq!(s.ext_of("wisp.router")["route"]["key"], "fake:m1:high", "the route stays on the task");
    assert_eq!(auto.told.lock().unwrap().as_slice(), ["launched"]);
    // your own pick, after Auto's preview showed another: no pick asked, your taste and the override learned
    let o = wisp_runtime_api::commands::AutoOverride { key: "other:x".into(), kind: Some("bug".into()) };
    r.rt.create(StartArgs { agent: Some("fake".into()), auto_override: Some(o), ..start("fix the login") }).await.unwrap();
    assert_eq!(*auto.picks.lock().unwrap(), 1);
    assert_eq!(auto.told.lock().unwrap().as_slice(), ["launched", "manual", "override"]);
}

/// What the CLI was on a turn (its `cli` event: version, catalog) is kept on the turn, so the page can say what
/// moved since the last turn (v1 what-changed.js).
#[tokio::test(flavor = "multi_thread")]
async fn a_turn_keeps_what_the_cli_was() {
    let r = rig().await;
    let id = r.rt.create(start("cli 2.1.0")).await.unwrap().id;
    until("the turn to end", || async { r.rt.turns(id.as_str(), None, None).await.unwrap().first().is_some_and(|t| t.ended_at.is_some()) }).await;
    let t = &r.rt.turns(id.as_str(), None, None).await.unwrap()[0];
    assert_eq!(t.ext["wisp.runtime"]["cli"]["version"], "2.1.0");
}
