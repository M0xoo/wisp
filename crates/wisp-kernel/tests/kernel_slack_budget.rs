//! Plan §6.11.3 end to end with fake plugins: a Slack message starts a task and the budget refuses it.
//! slack knows nothing about budgets, budget nothing about Slack, runtime neither; the refusal goes back
//! through the channel it came in on, with no direct call between any two of them.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::needless_pass_by_value,
    clippy::type_complexity,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::many_single_char_names
)]
mod common;

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::{
    Call, Caller, Code, Event, Failure, FollowUp, Hook, InterceptOpts, Kernel, PluginGroup, Result,
    Service, Verdict, WireError,
};

struct BeforeRun;
impl Hook for BeforeRun {
    const ID: &'static str = "before:run";
    type Ctx = Value;
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Created {
    id: String,
}
impl Event for Created {
    const TYPE: &'static str = "runtime.created";
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Noticed {
    to: Value,
    text: String,
}
impl Event for Noticed {
    const TYPE: &'static str = "channels.noticed";
}
trait Budget: Send + Sync {
    fn day(&self, call: &Call) -> Result<(f64, f64)>;
}
struct BudgetService;
impl Service for BudgetService {
    const ID: &'static str = "budget.service";
    const MAJOR: u32 = 1;
    type Api = dyn Budget;
}
struct Day(f64);
impl Budget for Day {
    fn day(&self, call: &Call) -> Result<(f64, f64)> {
        call.require("budget:read")?;
        Ok((self.0, 20.0))
    }
}

cmd!(Create, "runtime.create", Value, String);
cmd!(Start, "runtime.start", Value, String);
cmd!(Inbound, "channels.inbound", Value, String);
cmd!(ChStart, "channels.start", Value, String);
cmd!(Notice, "channels.notice", Value, ());

#[derive(Default)]
struct World {
    outbound: Mutex<Vec<String>>,
    spawned: Mutex<Vec<String>>,
    sessions: Mutex<BTreeMap<String, String>>,
    heard: Mutex<Vec<String>>,
}

fn runtime(w: Arc<World>) -> common::P {
    common::plugin("wisp.runtime", json!({}), move |s| {
        let w1 = w.clone();
        s.command::<Create, _, _>(move |ctx, call, _a| {
            let w = w1.clone();
            async move {
                let id = format!("s{}", w.sessions.lock().unwrap().len() + 1);
                w.sessions.lock().unwrap().insert(id.clone(), "new".into());
                ctx.emit(&call, &Created { id: id.clone() });
                Ok(id)
            }
        });
        let w2 = w.clone();
        s.command::<Start, _, _>(move |ctx, call, a| {
            let w = w2.clone();
            async move {
                let id = a["session"].as_str().unwrap_or_default().to_owned();
                if let Err(e) = ctx
                    .run_hook::<BeforeRun>(&call, json!({ "session": id, "origin": a["origin"] }))
                    .await
                {
                    let by = e
                        .details
                        .as_ref()
                        .and_then(|d| d["by"].as_str())
                        .unwrap_or_default()
                        .split('.')
                        .nth(1)
                        .unwrap_or_default()
                        .to_owned();
                    w.sessions
                        .lock()
                        .unwrap()
                        .insert(id, format!("refused: {by}"));
                    return Err(e);
                }
                w.spawned.lock().unwrap().push(id.clone());
                w.sessions.lock().unwrap().insert(id, "running".into());
                Ok("started".into())
            }
        });
    })
}

fn channels() -> common::P {
    common::plugin(
        "wisp.channels",
        json!({ "permissions": ["runtime:create", "runtime:start"], "contributes": { "points": [{ "id": "channels.transport", "version": 1, "kind": "list" }] } }),
        |s| {
            s.command::<Inbound, _, _>(|ctx, call, a| async move {
                if a["from"] != "U-owner" {
                    return Err(WireError::forbidden("not allowed to start tasks here"));
                }
                ctx.run::<Create>(
                    &call,
                    json!({ "prompt": a["text"], "capped": { "mode": "edits" } }),
                )
                .await
            });
            s.command::<ChStart, _, _>(
                |ctx, call, a| async move { ctx.run::<Start>(&call, a).await },
            );
            s.command::<Notice, _, _>(|ctx, call, a| async move {
                ctx.emit(
                    &call,
                    &Noticed {
                        to: a["to"].clone(),
                        text: a["text"].as_str().unwrap_or_default().to_owned(),
                    },
                );
                Ok(())
            });
        },
    )
}

fn slack(w: Arc<World>) -> common::P {
    common::plugin(
        "wisp.slack",
        json!({ "kind": "module", "extends": "wisp.channels", "permissions": ["channels:inbound", "channels:start"] }),
        move |s| {
            let w = w.clone();
            s.on::<Noticed, _, _>(move |_, e| {
                let w = w.clone();
                async move {
                    if e.to["transport"] == "slack" {
                        w.outbound.lock().unwrap().push(e.text);
                    }
                }
            });
        },
    )
}

fn guard(id: &str, priority: i32) -> common::P {
    common::plugin(id, json!({}), move |s| {
        s.intercept::<BeforeRun, _, _>(
            InterceptOpts {
                priority,
                failure: Failure::Closed,
                ..Default::default()
            },
            |_, _, _| async { Verdict::Continue },
        );
    })
}

fn budget(spent: f64) -> common::P {
    common::plugin(
        "wisp.budget",
        json!({ "provides": { "budget.service": { "version": "1.0.0" } }, "permissions": ["budget:read", "channels:notice"] }),
        move |s| {
            s.provide::<BudgetService>(Arc::new(Day(spent)));
            s.intercept::<BeforeRun, _, _>(InterceptOpts { priority: 2, failure: Failure::Closed, ..Default::default() }, |ctx, call, c| async move {
            // a read-only service method: allowed inside an interceptor
            let Ok((spent, limit)) = ctx.use_service::<BudgetService>().and_then(|b| b.day(&call)) else {
                return Verdict::Veto { code: "budget_unknown".into(), message: "budget unavailable".into(), then: Vec::new() };
            };
            if spent < limit {
                return Verdict::Continue;
            }
            let text = format!("Daily budget reached: ${spent:.2} of ${limit}. Raise it in Settings → Budget.");
            Verdict::Veto { code: "budget_exceeded".into(), message: format!("Daily budget ${limit} reached (${spent:.2})"), then: vec![FollowUp { cmd: "channels.notice".into(), args: json!({ "to": c["origin"], "text": text }) }] }
        });
        },
    )
}

fn list(w: Arc<World>) -> common::P {
    common::plugin("wisp.list", json!({}), move |s| {
        let w = w.clone();
        s.on_raw("*", move |_, e| {
            let w = w.clone();
            async move {
                w.heard.lock().unwrap().push(e.ty.clone());
                Ok(())
            }
        });
    })
}

async fn world(spent: f64, budget_on: bool) -> (Kernel, Arc<World>) {
    let w = Arc::new(World::default());
    let mut g = PluginGroup::new()
        .add(runtime(w.clone()))
        .add(channels())
        .add(slack(w.clone()))
        .add(guard("wisp.capped", 0))
        .add(guard("wisp.sidegate", 1))
        .add(budget(spent))
        .add(list(w.clone()));
    if !budget_on {
        g = g.disable("wisp.budget");
    }
    (common::start(g).await, w)
}

async fn inbound(k: &Kernel, text: &str) -> Result<Value> {
    let slack = k.ctx("wisp.slack").unwrap();
    let call = slack.root_call();
    let session = slack
        .run::<Inbound>(
            &call,
            json!({ "transport": "slack", "from": "U-owner", "text": text }),
        )
        .await?;
    // a second root command: the session above committed (tx 1) before this one runs
    slack
        .run::<ChStart>(
            &call,
            json!({ "session": session, "origin": { "transport": "slack", "channel": "#dev" } }),
        )
        .await
        .map(Value::from)
}

#[tokio::test]
async fn the_budget_refuses_the_run_nothing_spawns_and_slack_hears_why() {
    let (k, w) = world(20.4, true).await;
    let e = inbound(&k, "@wisp fix the flaky login test")
        .await
        .unwrap_err();
    assert_eq!(e.code, Code::Vetoed);
    assert_eq!(e.message, "Daily budget $20 reached ($20.40)");
    assert_eq!(
        e.details.unwrap(),
        json!({ "by": "wisp.budget", "reason": "budget_exceeded", "hook": "before:run" })
    );
    assert!(w.spawned.lock().unwrap().is_empty(), "no harness spawned");
    k.idle().await;
    assert_eq!(
        *w.outbound.lock().unwrap(),
        ["Daily budget reached: $20.40 of $20. Raise it in Settings → Budget."]
    );
    assert_eq!(w.sessions.lock().unwrap()["s1"], "refused: budget");
    // the list saw the new session (tx 1 committed) and the veto; runtime.start wrote nothing
    assert_eq!(
        *w.heard.lock().unwrap(),
        ["runtime.created", "kernel.vetoed", "channels.noticed"]
    );
    assert_eq!(k.failures("wisp.runtime").last().unwrap().code, "vetoed");
}

#[tokio::test]
async fn under_the_limit_it_runs() {
    let (k, w) = world(3.0, true).await;
    assert_eq!(inbound(&k, "@wisp go").await.unwrap(), json!("started"));
    assert_eq!(*w.spawned.lock().unwrap(), ["s1"]);
    k.idle().await;
    assert!(w.outbound.lock().unwrap().is_empty());
}

#[tokio::test]
async fn switching_budget_off_removes_one_interceptor_and_the_task_runs() {
    let (k, w) = world(99.0, false).await;
    assert_eq!(inbound(&k, "@wisp go").await.unwrap(), json!("started"));
    k.set_enabled("wisp.budget", true).await.unwrap();
    assert!(
        inbound(&k, "@wisp again")
            .await
            .unwrap_err()
            .message
            .contains("Daily budget")
    );
    k.set_enabled("wisp.budget", false).await.unwrap();
    assert_eq!(
        inbound(&k, "@wisp once more").await.unwrap(),
        json!("started")
    );
    assert_eq!(*w.spawned.lock().unwrap(), ["s1", "s3"]);
    k.idle().await;
    assert_eq!(w.outbound.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn switching_channels_off_takes_slack_with_it_with_the_reason() {
    let (k, _) = world(0.0, true).await;
    k.set_enabled("wisp.channels", false).await.unwrap();
    assert_eq!(
        common::state(&k, "wisp.channels"),
        ("off".into(), Some("wisp.channels was switched off".into()))
    );
    assert_eq!(
        common::state(&k, "wisp.slack"),
        (
            "refused".into(),
            Some("wisp.slack extends wisp.channels, which is off".into())
        )
    );
}

#[tokio::test]
async fn someone_the_channel_policy_refuses_never_creates_anything() {
    let (k, w) = world(0.0, true).await;
    let slack = k.ctx("wisp.slack").unwrap();
    let e = slack
        .run::<Inbound>(
            &slack.root_call(),
            json!({ "transport": "slack", "from": "U-stranger", "text": "hi" }),
        )
        .await
        .unwrap_err();
    assert!(e.message.contains("not allowed to start tasks here"));
    assert!(w.sessions.lock().unwrap().is_empty());
    // and an agent token can't reach the channel's commands at all
    assert_eq!(
        k.call(Caller::agent("s1", true), "channels.inbound", json!({}))
            .await
            .unwrap_err()
            .code,
        Code::Forbidden
    );
}
