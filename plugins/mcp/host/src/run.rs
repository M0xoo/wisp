//! A message's tool calls, run: a built-in as its owner's command (by name, through the kernel, as the
//! caller), a contributed tool through its own function. v1's words for each answer come from
//! `wisp-mcp-core`.

use serde_json::{Map, Value, json};
use wisp_kernel::{Call, Command, Ctx};
use wisp_runtime_api::commands as rt;
use wisp_mcp_core::{AgentAction, Outcome, Step, Who, agent_action, owner_text, user, words};

use crate::{Sessions, extras_for, who as who_of};

/// How often a waiting tool looks again (an ask, a task to finish).
const POLL_MS: u64 = 250;
const ASK_WAIT_MS: i64 = 30 * 60_000;

/// One body in, its answer out (`None`: only notifications).
pub async fn rpc(ctx: &Ctx, call: &Call, sessions: &Sessions, text: &str, cwd: Option<String>) -> Option<String> {
    let mut w = who_of(ctx, call, sessions);
    let mut only = None;
    if let Who::Agent { session, info } = &mut w {
        merge_flags(ctx, call, session, info).await;
        only = narrowed(ctx, call, sessions, session).await;
    }
    let (ex, contributed) = extras_for(ctx, call);
    let plan = wisp_mcp_core::plan(text, &w, &ex);
    let mut replies = Vec::with_capacity(plan.steps.len());
    for step in plan.steps {
        replies.push(match step {
            Step::Reply(r) => Some(only.as_ref().map_or_else(|| r.clone(), |o| crate::kinds::filter_list(&r, o))),
            Step::Silent => None,
            Step::Call(c) if only.as_ref().is_some_and(|o| !o.allows(&c.name)) => Some(wisp_mcp_core::finish(&c.id, &c.name, &w, Outcome::Failed(format!("{} isn't one of this agent's tools (tools: in its formula)", c.name)))),
            Step::Call(c) => {
                let outcome = if let Some(t) = c.extra.and_then(|i| contributed.get(i)) {
                    let tc = wisp_mcp_api::ToolCall { args: Value::Object(c.args), session: call.caller().session.clone() };
                    match (t.run)(ctx.clone(), call.clone(), tc).await {
                        Ok(t) if t.error.is_some() => Outcome::Failed(t.error.unwrap_or_default()),
                        Ok(t) => Outcome::Text(t.text.unwrap_or_default()),
                        Err(e) => Outcome::Failed(e.message),
                    }
                } else {
                    let fact = wisp_mcp_core::telemetry::of(&c.name, &c.args, matches!(w, Who::Agent { .. }));
                    let out = builtin(ctx, call, &w, &c.name, c.args, cwd.as_deref()).await;
                    if let Some((event, props)) = fact.filter(|_| !matches!(out, Outcome::Failed(_))) {
                        track(ctx, call, &w, event, props).await;
                    }
                    out
                };
                Some(wisp_mcp_core::finish(&c.id, &c.name, &w, outcome))
            }
        });
    }
    wisp_mcp_core::assemble(replies, plan.batch)
}

/// A tool call's catalogue event (`wisp_mcp_core::telemetry`), with the caller's harness.
async fn track(ctx: &Ctx, call: &Call, w: &Who, event: &str, mut props: Value) {
    if let Who::Agent { session, .. } = w {
        let agent = typed::<rt::Get>(ctx, call, get(session)).await.ok().and_then(|s| s.get("agent").cloned());
        if let (Some(o), Some(a)) = (props.as_object_mut(), agent) {
            o.insert("agent".into(), a);
        }
    }
    if let Ok(a) = args_of::<wisp_telemetry_api::Track>(json!({ "event": event, "props": props })) {
        let _ = ctx.run::<wisp_telemetry_api::Track>(&ctx.root_call(), a).await;
    }
}

/// The `tools` spec for this session's run (its agent profile's, else its mode's), when one is declared.
async fn narrowed(ctx: &Ctx, call: &Call, sessions: &Sessions, session: &str) -> Option<crate::kinds::ToolsSpec> {
    if sessions.1.is_empty() {
        return None;
    }
    let s = typed::<rt::Get>(ctx, call, get(session)).await.ok()?;
    let profile = s.pointer("/ext/wisp.runtime/spec/agent").and_then(Value::as_str).unwrap_or_default();
    sessions.1.for_run(profile, s.get("mode").and_then(Value::as_str).unwrap_or_default())
}

/// What `mcp.session@1` contributors know of the session (a side discussion, spells, watch).
async fn merge_flags(ctx: &Ctx, call: &Call, session: &str, info: &mut wisp_mcp_api::SessionInfo) {
    let flags = ctx.contributions(&wisp_mcp_api::SESSION_POINT);
    if flags.is_empty() {
        return;
    }
    let ext = typed::<rt::Get>(ctx, call, get(session)).await.ok().and_then(|s| s.get("ext").cloned()).unwrap_or(Value::Null);
    for f in flags {
        let more = f.flags(session, &ext);
        info.read_only |= more.read_only;
        info.spells |= more.spells;
        info.watch |= more.watch;
    }
}

/// A command chosen at runtime by name (an owner tool from the table, a connector, `crew.*`): by name, with JSON.
async fn owner(ctx: &Ctx, call: &Call, cmd: &str, args: Value) -> Result<Value, String> {
    ctx.run_json(call, cmd, args).await.map_err(|e| e.message)
}

/// Typed command `C`, its answer as the JSON the tool words read (what `run_json` would have answered).
async fn typed<C: Command>(ctx: &Ctx, call: &Call, args: C::Args) -> Result<Value, String> {
    let out = ctx.run::<C>(call, args).await.map_err(|e| e.message)?;
    serde_json::to_value(out).map_err(|e| e.to_string())
}

/// `C`'s args from what a tool call carried, refused in the words its handler would use (`<id>: <why>`).
fn args_of<C: Command>(v: Value) -> Result<C::Args, String> {
    serde_json::from_value(v).map_err(|e| format!("{}: {e}", C::ID))
}

/// `C` with args from a tool call's JSON (`args_of`), then `typed`.
async fn typed_json<C: Command>(ctx: &Ctx, call: &Call, v: Value) -> Result<Value, String> {
    typed::<C>(ctx, call, args_of::<C>(v)?).await
}

fn get(id: &str) -> rt::IdArgs {
    rt::IdArgs { id: id.into() }
}

fn text_of(r: Result<Value, String>) -> Outcome {
    match r {
        Ok(v) if v.get("text").is_some() || v.get("error").is_some() => owner_text(&v).map_or_else(|e| Outcome::Failed(e.to_string()), Outcome::Text),
        Ok(v) => Outcome::Text(v.to_string()),
        Err(e) => Outcome::Failed(e),
    }
}

async fn builtin(ctx: &Ctx, call: &Call, w: &Who, name: &str, args: Map<String, Value>, cwd: Option<&str>) -> Outcome {
    match w {
        Who::User { .. } => user_tool(ctx, call, name, args, cwd).await,
        Who::Agent { session, info } => match agent_action(name, args, session, info) {
            Ok(Some(a)) => agent_tool(ctx, call, session, a).await,
            Ok(None) => Outcome::Failed(format!("{name} isn't something this server does")),
            Err(e) => Outcome::Failed(e.to_string()),
        },
    }
}

/// Waits for the open question's answer (`runtime.pollAnswer`), as long as v1 waited.
async fn wait_answer(ctx: &Ctx, call: &Call, ask_id: &str, wait_ms: i64) -> Option<String> {
    let clock = ctx.clock().ok()?;
    let until = clock.now_ms() + wait_ms;
    loop {
        let p = typed::<rt::PollAnswerOf>(ctx, call, rt::PollAnswerArgs { ask_id: ask_id.to_owned() }).await.ok()?;
        match p.get("state").and_then(Value::as_str) {
            Some("answered") => return p.get("answer").and_then(Value::as_str).map(str::to_owned),
            Some("pending") if clock.now_ms() < until => clock.sleep(POLL_MS).await,
            _ => return None,
        }
    }
}

async fn agent_tool(ctx: &Ctx, call: &Call, session: &str, a: AgentAction) -> Outcome {
    match a {
        AgentAction::Owner { command, args } => text_of(owner(ctx, call, command, args).await),
        AgentAction::Ask { question, context, options } => {
            let q = context.map_or(question.clone(), |c| format!("{question}\n\n{c}"));
            match typed::<rt::Ask>(ctx, call, rt::AskArgs { id: session.into(), question: q, options, details: None }).await {
                Ok(v) => {
                    let id = v.get("askId").and_then(Value::as_str).unwrap_or_default().to_owned();
                    Outcome::Text(words::ask_answer(wait_answer(ctx, call, &id, ASK_WAIT_MS).await.as_deref()))
                }
                Err(e) => Outcome::Failed(e),
            }
        }
        AgentAction::Approve { args, input } => {
            let a = json!({ "id": session, "tool": args.get("tool"), "input": input, "toolUseId": args.get("tool_use_id") });
            match typed_json::<rt::Approval>(ctx, call, a).await {
                Ok(v) => Outcome::Text(v.to_string()),
                Err(e) => Outcome::Failed(e),
            }
        }
        AgentAction::Delegate { args, wait } => {
            let tasks = args.get("tasks").cloned().unwrap_or(Value::Null);
            match typed_json::<rt::Delegate>(ctx, call, json!({ "id": session, "tasks": tasks })).await {
                Ok(v) if !wait => Outcome::Text(format!("Started: {v}")),
                Ok(v) => {
                    let ids: Vec<String> = v.as_array().into_iter().flatten().filter_map(|d| d.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)).collect();
                    text_of(typed_json::<rt::Results>(ctx, call, json!({ "id": session, "ids": ids, "wait": 600 })).await.map(|r| json!({ "text": r.to_string() })))
                }
                Err(e) => Outcome::Failed(e),
            }
        }
        AgentAction::Results { args, wait } => {
            let ids = args.get("ids").cloned().unwrap_or_else(|| json!([]));
            let r = typed_json::<rt::Results>(ctx, call, json!({ "id": session, "ids": ids, "wait": if wait { 600 } else { 0 } })).await;
            text_of(r.map(|v| json!({ "text": v.to_string() })))
        }
        AgentAction::Launch { args, wait, wait_ms } => {
            let start = json!({ "prompt": args.get("prompt"), "cwd": args.get("cwd"), "agent": args.get("agent"), "model": args.get("model"), "mode": args.get("mode"), "by": "agent" });
            match typed_json::<rt::Create>(ctx, call, start).await {
                Ok(c) if wait => {
                    let id = c.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                    Outcome::Text(task_wait(ctx, call, &id, wait_ms).await)
                }
                Ok(c) => Outcome::Text(format!("Launched task `{}`.", c.get("id").and_then(Value::as_str).unwrap_or_default())),
                Err(e) => Outcome::Failed(e),
            }
        }
        AgentAction::TaskWait { task, wait_ms } => Outcome::Text(task_wait(ctx, call, &task, wait_ms).await),
        AgentAction::ConnectorAdd { args, .. } => text_of(owner(ctx, call, wisp_mcp_api::owners::CONNECTORS_ADD, args).await),
        AgentAction::ConnectorSignin { args } => text_of(owner(ctx, call, wisp_mcp_api::owners::CONNECTORS_SIGNIN, args).await),
    }
}

/// Waits for a task to settle (not running), then its report in v1's words.
async fn task_wait(ctx: &Ctx, call: &Call, id: &str, wait_ms: i64) -> String {
    let Ok(clock) = ctx.clock() else { return String::new() };
    let until = clock.now_ms() + wait_ms;
    loop {
        let s = typed::<rt::Get>(ctx, call, get(id)).await.unwrap_or(Value::Null);
        let settled = s.get("state").and_then(Value::as_str) != Some("running");
        if settled || clock.now_ms() >= until {
            let t = typed::<rt::Turns>(ctx, call, rt::TurnsArgs { id: id.into(), before: None, limit: Some(1), masked: None }).await.unwrap_or(Value::Null);
            let text = t.as_array().and_then(|l| l.last()).and_then(|x| x.get("text")).and_then(Value::as_str).unwrap_or_default().to_owned();
            return words::task_report(settled, None, &text);
        }
        clock.sleep(POLL_MS).await;
    }
}

/// The presentation as markdown: the hero's title and summary, then the turn's notes.
fn markdown(p: &Value) -> String {
    let mut out = Vec::new();
    for b in p.get("blocks").and_then(Value::as_array).into_iter().flatten() {
        if let Some(t) = b.get("title").and_then(Value::as_str) {
            out.push(format!("### {t}"));
        }
        if let Some(s) = b.get("summary").or_else(|| b.get("text")).and_then(Value::as_str) {
            out.push(s.to_owned());
        }
    }
    if let Some(n) = p.get("notes").and_then(Value::as_str).filter(|n| !n.is_empty()) {
        out.push(n.to_owned());
    }
    out.join("\n\n")
}

async fn describe(ctx: &Ctx, call: &Call, id: &str, extra: &str) -> Outcome {
    let s = match typed::<rt::Get>(ctx, call, get(id)).await {
        Ok(s) => s,
        Err(e) => return Outcome::Failed(e),
    };
    let p = typed::<rt::PresentationOf>(ctx, call, rt::PresentationArgs { id: id.into(), turn: None }).await.unwrap_or(Value::Null);
    Outcome::Text(user::describe(id, &s, &markdown(&p), extra))
}

/// `wisp mcp`'s tools (v1 server/mcp-wisp.js `callTool`).
async fn user_tool(ctx: &Ctx, call: &Call, name: &str, a: Map<String, Value>, cwd: Option<&str>) -> Outcome {
    let s = |k: &str| a.get(k).and_then(Value::as_str).map(str::to_owned);
    let id = s("id").unwrap_or_default();
    let wait_ms = words::task_wait_ms(a.get("timeout_seconds"));
    match name {
        "wisp_launch" => {
            let Some(prompt) = s("prompt").filter(|p| !p.trim().is_empty()) else { return Outcome::Failed("prompt is required".into()) };
            let args = json!({ "prompt": prompt, "cwd": s("cwd").or_else(|| cwd.map(str::to_owned)), "agent": s("agent"), "model": s("model"), "effort": s("effort"), "mode": s("mode") });
            match typed_json::<rt::Create>(ctx, call, args).await {
                Ok(c) => {
                    let id = c.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
                    if a.get("wait").is_some_and(|w| w.as_bool().unwrap_or(false)) {
                        let _ = task_wait(ctx, call, &id, wait_ms).await;
                        return describe(ctx, call, &id, "").await;
                    }
                    let got = typed::<rt::Get>(ctx, call, get(&id)).await.unwrap_or(Value::Null);
                    Outcome::Text(user::launched(&got))
                }
                Err(e) => Outcome::Failed(e),
            }
        }
        "wisp_list" => match typed::<rt::List>(ctx, call, rt::ListArgs::default()).await {
            Ok(Value::Array(all)) => Outcome::Text(user::list(&all, &a)),
            Ok(_) => Outcome::Text(user::list(&[], &a)),
            Err(e) => Outcome::Failed(e),
        },
        "wisp_get" => describe(ctx, call, &id, "").await,
        "wisp_wait" => {
            let _ = task_wait(ctx, call, &id, wait_ms).await;
            describe(ctx, call, &id, "").await
        }
        "wisp_reply" => {
            let Some(text) = s("text").map(|t| t.trim().to_owned()).filter(|t| !t.is_empty()) else { return Outcome::Failed("text is required".into()) };
            match typed_json::<rt::FollowUp>(ctx, call, json!({ "id": id, "text": text, "queue": a.get("queue"), "mode": s("mode") })).await {
                Ok(r) => Outcome::Text(user::replied(&r).to_owned()),
                Err(e) => Outcome::Failed(e),
            }
        }
        "wisp_stop" => match typed::<rt::Stop>(ctx, call, rt::StopArgs { id: id.as_str().into(), clear_queue: false }).await {
            Ok(_) => Outcome::Text(user::stopped(&id)),
            Err(e) => Outcome::Failed(e),
        },
        "wisp_agents" => {
            let here = typed::<rt::Agents>(ctx, call, rt::AgentsArgs::default()).await.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
            let machines = typed::<wisp_machines_api::List>(ctx, call, wisp_machines_api::NoArgs {}).await.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default();
            Outcome::Text(user::agents(&here, &machines))
        }
        other => text_of(owner(ctx, call, &format!("crew.{}", other.trim_start_matches("wisp_crew_").trim_start_matches("wisp_")), Value::Object(a)).await),
    }
}
