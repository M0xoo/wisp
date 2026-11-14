//! Try it two ways (v1 #650, F-comp-31; ADR-0056) through the runtime: a task's variant reaches its harness on
//! every turn, a harness that can't run it refuses it by name, and Keep this marks one run and archives the other.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::many_single_char_names)]

mod common;

use common::{Fake, rig_on, until};
use serde_json::json;
use wisp_runtime::Recorder;
use wisp_runtime::trial::link;
use wisp_runtime_api::SessionId;
use wisp_runtime_api::commands::{FollowUpArgs, StartArgs, TrialArgs, TrialLink, Variant};
use wisp_runtime_api::model::TurnStatus;

fn start(prompt: &str, agent: &str) -> StartArgs {
    StartArgs { prompt: prompt.into(), agent: Some(agent.into()), cwd: Some("/tmp".into()), ..StartArgs::default() }
}

async fn ended(r: &common::Rig, id: &str) -> bool {
    r.rt.turns(id, None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status == TurnStatus::Done)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_tasks_variant_reaches_its_harness_on_every_turn_and_its_own_pick_beats_the_setting_v1_try_two_ways() {
    let set = Recorder { settings: [("runtime.subagentModel".to_owned(), json!("sonnet"))].into(), ..Recorder::default() };
    let r = rig_on(set, vec![Fake::varies("cc", "Claude-ish")]).await;
    let args = |i: usize| r.sim.spawned()[i].args.clone();
    // run B of a trial: subagents on Haiku (over the Sonnet setting), skills off
    let b = StartArgs { subagent_model: Some("haiku".into()), skills: Some("off".into()), ..start("fix it", "cc") };
    let id = r.rt.create(b).await.unwrap().id;
    until("the run", || async { r.sim.spawned().len() == 1 }).await;
    assert!(args(0).contains(&"--sub=haiku".to_owned()) && args(0).contains(&"--skills=off".to_owned()), "{:?}", args(0));
    until("it ends", || async { ended(&r, id.as_str()).await }).await;
    // a follow-up keeps it (v1: each run keeps its variant on follow-ups)
    r.rt.follow_up(FollowUpArgs { id: id.clone(), text: "and the tests".into(), ..FollowUpArgs::default() }).await.unwrap();
    until("the second run", || async { r.sim.spawned().len() == 2 }).await;
    assert!(args(1).contains(&"--sub=haiku".to_owned()) && args(1).contains(&"--skills=off".to_owned()), "{:?}", args(1));
    until("it ends", || async { ended(&r, id.as_str()).await }).await;
    // '' is the task's own model: no subagent model at all, even with the setting on Sonnet
    let own = r.rt.create(StartArgs { subagent_model: Some(String::new()), ..start("fix it", "cc") }).await.unwrap().id;
    until("its run", || async { r.sim.spawned().len() == 3 }).await;
    assert!(!args(2).iter().any(|a| a.starts_with("--sub=") || a.starts_with("--skills=")), "{:?}", args(2));
    until("it ends", || async { ended(&r, own.as_str()).await }).await;
    // none asked: the setting, as before
    let plain = r.rt.create(start("fix it", "cc")).await.unwrap().id;
    until("its run", || async { r.sim.spawned().len() == 4 }).await;
    assert!(args(3).contains(&"--sub=sonnet".to_owned()) && !args(3).iter().any(|a| a.starts_with("--skills=")), "{:?}", args(3));
    until("it ends", || async { ended(&r, plain.as_str()).await }).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_harness_without_variants_refuses_one_by_name_and_starts_nothing_v1_check_variant() {
    let r = rig_on(Recorder::default(), vec![Fake::varies("cc", "Claude-ish"), Fake::named("cx", "Codex-ish", &[])]).await;
    let e = r.rt.create(StartArgs { skills: Some("off".into()), ..start("fix it", "cx") }).await.unwrap_err().to_string();
    assert!(e.contains("Codex-ish can't run with its skills off"), "{e}");
    let e = r.rt.create(StartArgs { subagent_model: Some("haiku".into()), ..start("fix it", "cx") }).await.unwrap_err().to_string();
    assert!(e.contains("Codex-ish can't run its subagents"), "{e}");
    assert!(r.sim.spawned().is_empty(), "nothing ran");
    // the trial's plan checks both runs against the harness before anything starts
    let t = TrialArgs { task: start("fix it", "cx"), vary: Variant { skills: Some("off".into()), ..Variant::default() } };
    assert!(r.rt.trial_plan(&t).unwrap_err().to_string().contains("Codex-ish can't"));
    let ok = TrialArgs { task: start("fix it", "cc"), vary: Variant { skills: Some("off".into()), ..Variant::default() } };
    let p = r.rt.trial_plan(&ok).unwrap();
    assert_eq!(p.b.skills.as_deref(), Some("off"));
}

#[tokio::test(flavor = "multi_thread")]
async fn keep_this_marks_the_kept_run_on_both_and_archives_the_other_v1_trial_kept() {
    let r = rig_on(Recorder::default(), vec![Fake::varies("cc", "Claude-ish")]).await;
    let t = TrialArgs { task: start("fix it", "cc"), vary: Variant { subagent_model: Some("haiku".into()), ..Variant::default() } };
    let p = r.rt.trial_plan(&t).unwrap();
    let mut ids: Vec<SessionId> = Vec::new();
    for (i, mut a) in [p.a, p.b].into_iter().enumerate() {
        a.worktree = None; // no worktrees service in this rig
        link(&mut a, &TrialLink { group: "g-1".into(), run: u8::from(i > 0), differs: p.differs.clone(), ..TrialLink::default() });
        ids.push(r.rt.create(a).await.unwrap().id);
    }
    r.rt.trial_runs(&ids).await.unwrap();
    for id in &ids {
        until("it ends", || async { ended(&r, id.as_str()).await }).await;
    }
    let row = |s: &wisp_runtime_api::model::Session| s.ext["wisp.runtime"]["trial"].clone();
    let a = r.rt.get(ids[0].as_str()).await.unwrap();
    assert_eq!(row(&a)["runs"], json!([ids[0].0, ids[1].0]), "each run lists both, A first");
    assert_eq!(a.ext["wisp.runtime"]["group"], "g-1");
    r.rt.trial_keep(ids[1].as_str()).await.unwrap();
    let (a, b) = (r.rt.get(ids[0].as_str()).await.unwrap(), r.rt.get(ids[1].as_str()).await.unwrap());
    assert_eq!((row(&a)["kept"].clone(), row(&b)["kept"].clone()), (json!(ids[1].0), json!(ids[1].0)), "both say which one you kept");
    assert!(a.archived && !b.archived, "the other run is archived, the kept one isn't");
    // keeping the other one after all: it comes back and this one goes (idempotent per pick)
    r.rt.trial_keep(ids[0].as_str()).await.unwrap();
    r.rt.trial_keep(ids[0].as_str()).await.unwrap();
    let (a, b) = (r.rt.get(ids[0].as_str()).await.unwrap(), r.rt.get(ids[1].as_str()).await.unwrap());
    assert!(!a.archived && b.archived);
    assert_eq!(row(&b)["kept"], json!(ids[0].0));
    // a task that isn't a trial run: refused
    let plain = r.rt.create(start("other", "cc")).await.unwrap().id;
    assert!(r.rt.trial_keep(plain.as_str()).await.unwrap_err().to_string().contains("isn't a run of Try it two ways"));
    until("it ends", || async { ended(&r, plain.as_str()).await }).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_variant_on_a_terminal_task_is_refused_never_dropped_v1_terminal_variant() {
    let r = rig_on(Recorder::default(), vec![Fake::varies("cc", "Claude-ish")]).await;
    let e = r.rt.create(StartArgs { terminal: true, skills: Some("off".into()), ..start("fix it", "cc") }).await.unwrap_err().to_string();
    assert!(e.contains("terminal task"), "{e}");
    assert_eq!(r.sim.spawned().len(), 0, "nothing ran");
}

#[tokio::test(flavor = "multi_thread")]
async fn keep_stops_the_other_run_still_working_so_it_stops_billing_out_of_sight() {
    let r = rig_on(Recorder::default(), vec![Fake::varies("cc", "Claude-ish")]).await;
    let mut ids: Vec<SessionId> = Vec::new();
    for (i, prompt) in ["slow work", "fix it"].into_iter().enumerate() {
        let mut a = start(prompt, "cc");
        link(&mut a, &TrialLink { group: "g-2".into(), run: u8::from(i > 0), ..TrialLink::default() });
        ids.push(r.rt.create(a).await.unwrap().id);
    }
    r.rt.trial_runs(&ids).await.unwrap();
    until("both run", || async { r.sim.spawned().len() == 2 }).await;
    until("B ends", || async { ended(&r, ids[1].as_str()).await }).await;
    r.rt.trial_keep(ids[1].as_str()).await.unwrap();
    until("A stops", || async {
        r.rt.turns(ids[0].as_str(), None, Some(1)).await.unwrap().pop().is_some_and(|t| t.status != TurnStatus::Running)
    })
    .await;
    assert!(r.rt.get(ids[0].as_str()).await.unwrap().archived);
}

/// v1 guard.js `together`: a trial's two runs go at once on one account, so Ask near the limit (`before:run`) hears
/// run A's start as both; run B finds A already running (counted apart, at half), and a follow-up is one run.
#[tokio::test(flavor = "multi_thread")]
async fn a_trials_run_a_asks_near_the_limit_for_both_runs_and_b_and_follow_ups_for_one_v1_together() {
    let r = rig_on(Recorder::default(), vec![Fake::varies("cc", "Claude-ish")]).await;
    let t = TrialArgs { task: start("fix it", "cc"), vary: Variant { skills: Some("off".into()), ..Variant::default() } };
    let p = r.rt.trial_plan(&t).unwrap();
    let mut ids: Vec<SessionId> = Vec::new();
    for (i, mut a) in [p.a, p.b].into_iter().enumerate() {
        a.worktree = None; // no worktrees service in this rig
        link(&mut a, &TrialLink { group: "g-3".into(), run: u8::from(i > 0), differs: p.differs.clone(), ..TrialLink::default() });
        ids.push(r.rt.create(a).await.unwrap().id);
    }
    for id in &ids {
        until("it ends", || async { ended(&r, id.as_str()).await }).await;
    }
    let plain = r.rt.create(start("other", "cc")).await.unwrap().id;
    until("it ends", || async { ended(&r, plain.as_str()).await }).await;
    r.rt.follow_up(FollowUpArgs { id: ids[0].clone(), text: "and the tests".into(), ..FollowUpArgs::default() }).await.unwrap();
    until("the follow-up", || async { r.host.ran.lock().unwrap().len() == 4 }).await;
    let ran = r.host.ran.lock().unwrap().clone();
    let of = |id: &SessionId| ran.iter().filter(|c| &c.session_id == id).map(|c| c.together).collect::<Vec<_>>();
    assert_eq!(of(&ids[0]), vec![2, 1], "run A's start asks for both; its follow-up for one");
    assert_eq!(of(&ids[1]), vec![1], "run B: A is already running");
    assert_eq!(of(&plain), vec![1], "a plain task: itself");
    assert!(serde_json::to_value(&ran[1]).unwrap().get("together").is_none(), "1 stays off the wire (additive)");
    until("it ends", || async { ended(&r, ids[0].as_str()).await }).await;
}

/// A start `before:run` refused (Ask near the limit's veto) or the budget held is read back as not started, so
/// `runtime.trial` refuses the pair as one instead of keeping one run alone (run A or run B); a hold its own row
/// offers Start now on (another plugin's), and a run that ran, are not.
#[tokio::test(flavor = "multi_thread")]
async fn a_run_refused_or_budget_held_before_it_ran_is_read_back_as_not_started_so_no_run_of_a_pair_goes_alone_v1_together() {
    let no = Recorder { veto: Some("5-hour usage window is at 85%: past your 90% line".into()), ..Recorder::default() };
    let r = rig_on(no, vec![Fake::varies("cc", "Claude-ish")]).await;
    let id = r.rt.create(start("fix it", "cc")).await.unwrap().id;
    let why = r.rt.first_turn_not_started(id.as_str()).await.unwrap();
    assert!(why.as_deref().is_some_and(|w| w.contains("past your 90% line")), "{why:?}");
    assert!(r.sim.spawned().is_empty(), "nothing ran");
    let held = rig_on(Recorder { hold: Some("setup".into()), ..Recorder::default() }, vec![Fake::varies("cc", "Claude-ish")]).await;
    let id = held.rt.create(start("fix it", "cc")).await.unwrap().id;
    assert_eq!(held.rt.first_turn_not_started(id.as_str()).await.unwrap(), None, "another plugin's hold: its row's Start now");
    let mut t = wisp_runtime_api::model::Turn { status: TurnStatus::Held, ..Default::default() };
    t.held = Some(wisp_runtime_api::model::Held {
        by: "wisp.budget".into(),
        kind: "ask".into(),
        until: None,
        data: json!({ "why": "5-hour usage window is at 85%" }),
    });
    assert_eq!(wisp_runtime::trial::not_started(&t).as_deref(), Some("5-hour usage window is at 85%"), "the budget's hold");
    let ok = rig_on(Recorder::default(), vec![Fake::varies("cc", "Claude-ish")]).await;
    let id = ok.rt.create(start("fix it", "cc")).await.unwrap().id;
    until("it ends", || async { ended(&ok, id.as_str()).await }).await;
    assert_eq!(ok.rt.first_turn_not_started(id.as_str()).await.unwrap(), None, "it ran");
}
