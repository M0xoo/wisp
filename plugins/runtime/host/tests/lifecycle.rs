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
    StartArgs { prompt: prompt.into(), cwd: Some("/tmp".into()), ..StartArgs::default() }
}

fn follow(id: &wisp_runtime_api::SessionId, text: &str, queue: bool) -> FollowUpArgs {
    FollowUpArgs { id: id.clone(), text: text.into(), queue: Some(queue), ..FollowUpArgs::default() }
}

async fn last_status(r: &common::Rig, id: &str) -> Option<TurnStatus> {
    r.rt.turns(id, None, Some(1)).await.unwrap().pop().map(|t| t.status)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_runs_its_first_turn_and_is_named_after_its_topic() {
    let r = rig().await;
    let c = r.rt.create(start("fix the login")).await.unwrap();
    let id = c.id.0.clone();
    until("the turn to end", || async { last_status(&r, &id).await == Some(TurnStatus::Done) }).await;
    until("the run to let go", || async { r.sim.spawned().len() == 1 && r.rt.list(&ListArgs::default())[0].state == SessionState::Review }).await;
    let s = r.rt.get(&id).await.unwrap();
    assert_eq!(s.title, "Topic of fix the login");
    assert_eq!(s.resume_id.as_deref(), Some("conv-1"));
    assert!(s.unread);
    let t = r.rt.turns(&id, None, None).await.unwrap().pop().unwrap();
    assert_eq!(t.presentation.as_ref().unwrap().blocks[0]["summary"], "done: fix the login");
    assert_eq!(t.changed_files, Some(1));
    assert_eq!(t.stats.as_ref().unwrap().cost_usd, Some(0.01));
    let steps = r.rt.activity(t.id.as_str(), None).await.unwrap().items;
    assert!(matches!(&steps[0].activity, Activity::Tool { label, .. } if label == "Run tests"));
    assert!(steps.windows(2).all(|w| w[0].seq < w[1].seq));
    let row = &r.rt.list(&ListArgs::default())[0];
    assert_eq!((row.status.as_str(), row.preview.as_str(), row.turn_count), ("done", "done: fix the login", 1));
    let names = r.host.names();
    let pos = |n: &str| names.iter().position(|x| *x == n).unwrap_or_else(|| panic!("{n} in {names:?}"));
    assert!(pos("session.created") < pos("turn.started") && pos("turn.started") < pos("turn.activity") && pos("turn.activity") < pos("turn.ended"));
    assert!(names.contains(&"turn.finished"));
    // the system prompt went to the harness, the prompt as its argument
    assert_eq!(r.sim.spawned()[0].args[0], "fix the login");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_failed_run_shows_the_harness_error() {
    let r = rig().await;
    let id = r.rt.create(start("fail now")).await.unwrap().id.0;
    until("the turn to fail", || async { last_status(&r, &id).await == Some(TurnStatus::Error) }).await;
    let t = r.rt.turns(&id, None, None).await.unwrap().pop().unwrap();
    let hero = &t.presentation.unwrap().blocks[0];
    assert_eq!((hero["title"].as_str(), hero["summary"].as_str()), (Some("Fake CLI failed"), Some("Error: boom")));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_follow_up_while_running_interrupts_and_runs_next_without_a_notification() {
    let r = rig().await;
    let id = r.rt.create(start("slow work")).await.unwrap().id;
    until("the run to report its conversation", || async { !r.rt.activity(&r.rt.turns(id.as_str(), None, Some(1)).await.unwrap()[0].id.0, None).await.unwrap().items.is_empty() }).await;
    r.host.taken();
    r.rt.follow_up(follow(&id, "do this instead", false)).await.unwrap();
    until("the follow-up's turn to end", || async { r.rt.turns(id.as_str(), None, None).await.unwrap().len() == 2 && last_status(&r, id.as_str()).await == Some(TurnStatus::Done) }).await;
    let turns = r.rt.turns(id.as_str(), None, None).await.unwrap();
    assert_eq!(turns[0].status, TurnStatus::Stopped);
    assert_eq!(turns[0].presentation.as_ref().unwrap().blocks[0]["title"], "Interrupted");
    // the follow-up resumed the conversation
    assert!(r.sim.spawned()[1].args.iter().any(|a| a == "--resume=conv-1"));
    let finished: Vec<_> = r.host.taken().into_iter().filter_map(|e| if let Emitted::Finished(f) = e { Some(f.turn_id) } else { None }).collect();
    assert_eq!(finished, vec![turns[1].id.clone()], "no notification for the run it replaced");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_stop_holds_the_queue_and_your_next_message_carries_it_on() {
    let r = rig().await;
    let id = r.rt.create(start("slow work")).await.unwrap().id;
    until("the run to start", || async { r.sim.spawned().len() == 1 }).await;
    r.rt.follow_up(follow(&id, "queued one", true)).await.unwrap();
    r.rt.stop(id.as_str(), false).await.unwrap();
    until("the turn to stop", || async { last_status(&r, id.as_str()).await == Some(TurnStatus::Stopped) }).await;
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let s = r.rt.get(id.as_str()).await.unwrap();
    assert!(s.queue_held);
    assert_eq!(s.queue.len(), 1, "a Stop never discards queued follow-ups");
    assert_eq!(r.sim.spawned().len(), 1, "nothing goes out by itself after a Stop");
    let t = r.rt.turns(id.as_str(), None, None).await.unwrap().pop().unwrap();
    assert_eq!(t.presentation.unwrap().blocks[0]["title"], "Stopped");
    // your next message goes now, and the held one after it
    r.rt.follow_up(follow(&id, "carry on", true)).await.unwrap();
    until("both to run", || async { r.rt.turns(id.as_str(), None, None).await.unwrap().len() == 3 && last_status(&r, id.as_str()).await == Some(TurnStatus::Done) }).await;
    let prompts: Vec<String> = r.rt.turns(id.as_str(), None, None).await.unwrap().into_iter().map(|t| t.prompt).collect();
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
    r.rt.queue_text(id.as_str(), &ids[0], "one, edited").await.unwrap();
    let order = vec![QueueItem { id: ids[2].clone(), text: "three".into(), ..QueueItem::default() }];
    r.rt.queue_edit(QueueEditArgs { id: id.clone(), items: order, remove: vec![], held: None }).await.unwrap();
    let texts = |q: Vec<QueueItem>| q.into_iter().map(|x| x.text).collect::<Vec<_>>();
    assert_eq!(texts(r.rt.get(id.as_str()).await.unwrap().queue), ["three", "one, edited", "two"]);
    r.rt.queue_merge(id.as_str(), &[ids[0].clone(), ids[1].clone()]).await.unwrap();
    assert_eq!(texts(r.rt.get(id.as_str()).await.unwrap().queue), ["three", "one, edited\n\ntwo"]);
    r.rt.queue_edit(QueueEditArgs { id: id.clone(), items: vec![], remove: vec![ids[2].clone()], held: None }).await.unwrap();
    assert_eq!(r.rt.get(id.as_str()).await.unwrap().queue.len(), 1);
    r.rt.stop(id.as_str(), true).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn before_run_can_veto_or_hold_a_run() {
    let r = rig_with(Recorder { veto: Some("Daily budget $20 reached ($20.40)".into()), ..Recorder::default() }).await;
    let id = r.rt.create(start("anything")).await.unwrap().id;
    let t = r.rt.turns(id.as_str(), None, None).await.unwrap().pop().unwrap();
    assert_eq!(t.status, TurnStatus::Error);
    assert_eq!(t.presentation.unwrap().blocks[0]["summary"], "Daily budget $20 reached ($20.40)");
    assert!(r.sim.spawned().is_empty(), "nothing spawned");
    let r = rig_with(Recorder { hold: Some("limit".into()), ..Recorder::default() }).await;
    let id = r.rt.create(start("held work")).await.unwrap().id;
    let t = r.rt.turns(id.as_str(), None, None).await.unwrap().pop().unwrap();
    assert_eq!(t.status, TurnStatus::Held);
    assert!(r.host.names().contains(&"turn.held"));
    assert_eq!(r.rt.list(&ListArgs::default())[0].status, "held");
    // Skip: it stays, stopped, saying why
    r.rt.release(id.as_str(), t.id.as_str(), false).await.unwrap();
    assert_eq!(last_status(&r, id.as_str()).await, Some(TurnStatus::Stopped));
}

#[tokio::test(flavor = "multi_thread")]
async fn edits_reads_and_delete() {
    let r = rig().await;
    let id = r.rt.create(start("x")).await.unwrap().id.0;
    until("the turn to end", || async { last_status(&r, &id).await == Some(TurnStatus::Done) }).await;
    r.rt.rename(&id, "  Named  ").await.unwrap();
    r.rt.archive(&id, true).await.unwrap();
    r.rt.set_ext(&id, "wisp.goal", serde_json::json!({"text": "green"})).await.unwrap();
    let s = r.rt.get(&id).await.unwrap();
    assert_eq!((s.title.as_str(), s.archived), ("Named", true));
    assert_eq!(s.ext["wisp.goal"]["text"], "green");
    assert!(r.rt.list(&ListArgs { archived: Some(false), limit: None }).is_empty());
    assert!(r.rt.rename(&id, " ").await.is_err());
    let hits = r.rt.search("Named", 10).await.unwrap();
    assert_eq!(hits.len(), 1);
    r.rt.delete(&id).await.unwrap();
    assert!(r.rt.get(&id).await.is_err());
    assert!(r.rt.list(&ListArgs::default()).is_empty());
    assert!(r.host.names().contains(&"session.deleted"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_restart_marks_turns_it_left_running_as_stopped() {
    let r = rig().await;
    let id = r.rt.create(start("slow work")).await.unwrap().id.0;
    until("the run to start", || async { r.sim.spawned().len() == 1 }).await;
    // a second runtime over the same store, as after a crash
    let rt2 = wisp_runtime::Runtime::new(wisp_runtime::repo::Repo::new(r.store.clone()), r.host.clone(), std::sync::Arc::new(wisp_proc::sim::SimProc::new()), std::sync::Arc::new(wisp_store::SystemClock));
    rt2.start().await.unwrap();
    let t = rt2.turns(&id, None, None).await.unwrap().pop().unwrap();
    assert_eq!(t.status, TurnStatus::Stopped);
    assert!(t.presentation.unwrap().blocks[0]["summary"].as_str().unwrap().contains("wisp restarted"));
    r.rt.stop(&id, true).await.unwrap();
}
