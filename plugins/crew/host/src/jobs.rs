//! The crew's commands and the scheduler (v1 crew.js `create`, `update`, `assign`, `checkin`, `tick`,
//! `drain`). A job is an ordinary task: `runtime.create` with the member's harness, folder and mode,
//! `ext["wisp.crew"]` saying whose job it is, `by: "crew"`.

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_crew_api::commands as c;
use wisp_crew_api::{CrewExt, JobKind, JobSummary, Member, MemberView, PLUGIN_ID, RunPick, TICK_MS, WaitingJob};
use wisp_crew_core::cron::Utc;
use wisp_crew_core::layout::{layout_of, normalize_layout};
use wisp_crew_core::note::checkin_prompt;
use wisp_crew_core::queue::{Placement, checkin_already, count_checkin, drain_count, place};
use wisp_crew_core::run::{job_body, job_run};
use wisp_crew_core::tick::tick;
use wisp_kernel::{Call, Command as _, Ctx, Setup, WireError};
use wisp_runtime_api::commands as rt;

use crate::{State, calls, lock, wire};

pub(crate) fn now(ctx: &Ctx) -> i64 {
    ctx.clock().map_or(0, |c| c.now_ms())
}

/// A job's task: here, or on the machine (a sandbox) it runs on (`<machine>|<id>`).
pub(crate) async fn job_task(ctx: &Ctx, call: &Call, id: &str) -> Result<Value, WireError> {
    match id.split_once('|') {
        Some((machine, task)) => calls::routed::<rt::Get>(ctx, call, machine, json!({ "id": task })).await,
        None => calls::to_json(&calls::task(ctx, call, id).await?),
    }
}

/// A job's turns, here or in its sandbox.
pub(crate) async fn job_turns(ctx: &Ctx, call: &Call, id: &str) -> Result<Vec<wisp_runtime_api::model::Turn>, WireError> {
    match id.split_once('|') {
        Some((machine, task)) => {
            let v = calls::routed::<rt::Turns>(
                ctx,
                call,
                machine,
                calls::to_json(&rt::TurnsArgs { id: task.into(), before: None, limit: None, masked: None })?,
            )
            .await?;
            serde_json::from_value(v).map_err(|e| WireError::internal(format!("{}: {e}", rt::Turns::ID)))
        }
        None => calls::turns(ctx, call, id).await,
    }
}

/// A crew follow-up to a job, here or in its sandbox (queued behind a running turn).
pub(crate) async fn job_follow_up(ctx: &Ctx, call: &Call, id: &str, text: String) -> Result<(), WireError> {
    match id.split_once('|') {
        Some((machine, task)) => {
            let a = rt::FollowUpArgs { id: task.into(), text, queue: Some(true), by: Some("crew".into()), ..rt::FollowUpArgs::default() };
            calls::routed::<rt::FollowUp>(ctx, call, machine, calls::to_json(&a)?).await.map(|_| ())
        }
        None => calls::follow_up(ctx, call, id, text).await,
    }
}

/// The grid said it's full (or the user has all the sandboxes they may): a crew job waits and tries again.
fn grid_full(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("is full") || m.contains("sandboxes of yours")
}

/// Where a member's job runs when it isn't here: on their machine (v1 crew.js `{ machine: m.machine }`, its folder
/// one there), a sandbox per job, or their own (ADR-0047). `(machine, cwd)`.
async fn sandbox_for(ctx: &Ctx, call: &Call, m: &Member) -> Result<Option<(String, String)>, WireError> {
    if !m.machine.is_empty() && m.sandbox.is_empty() {
        return Ok(Some((m.machine.clone(), m.cwd.clone())));
    }
    let owner = match m.sandbox.as_str() {
        "own" => json!({ "crew": m.id }),
        "job" => json!({ "crew": m.id, "job": "" }),
        _ => return Ok(None),
    };
    let cwd = (!m.cwd.is_empty()).then(|| m.cwd.clone());
    Ok(Some(calls::place(ctx, call, owner, cwd).await?))
}

/// The member's jobs as the runtime has them now.
async fn jobs_of(ctx: &Ctx, call: &Call, st: &State, m: &Member) -> Vec<JobSummary> {
    let ids = lock(&st.jobs).get(&m.id).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for id in ids {
        let Ok(s) = job_task(ctx, call, &id).await else { continue };
        let job = s.pointer("/ext/wisp.crew/job").and_then(|j| serde_json::from_value::<JobKind>(j.clone()).ok()).unwrap_or_default();
        let state = s.get("state").and_then(Value::as_str).unwrap_or("done").to_owned();
        out.push(JobSummary { session_id: id, crew_id: m.id.clone(), job, state });
    }
    out
}

pub(crate) async fn view(ctx: &Ctx, call: &Call, st: &State, m: &Member) -> MemberView {
    let live = jobs_of(ctx, call, st, m).await.iter().filter(|j| j.live()).count();
    st.view(m, u32::try_from(live).unwrap_or(u32::MAX), now(ctx))
}

/// Starts one job as a task.
/// `w.run`: this job's own pick (`wisp_crew_core::run`), already checked.
async fn start(ctx: &Ctx, call: &Call, st: &State, m: &Member, w: &WaitingJob) -> Result<Value, WireError> {
    let (prompt, job, attachments) = (&w.prompt, w.job, &w.attachments);
    // what it was asked, for its page (a check-in's prompt is the crew's own)
    let asked = (job != JobKind::Checkin && !prompt.trim().is_empty()).then(|| prompt.chars().take(2000).collect::<String>());
    // on the member's machine, or in a sandbox (a fresh one per job, or the member's own): the job's task runs there
    let place = sandbox_for(ctx, call, m).await?;
    let mut ext = CrewExt { id: m.id.clone(), job, prompt: asked, from: w.from.clone(), reply: w.reply.clone(), ..CrewExt::default() };
    if place.is_some() {
        // no such member over there: the note goes with the job (`Note::part` reads it)
        ext.note = Some(wisp_crew_core::note::crew_note(m, &ext, None, &Utc));
    }
    let (agent, model, effort, mode) = job_body(m, w.run.as_ref());
    let agent = (!agent.is_empty() && agent != "auto").then_some(agent);
    let args = json!({
        "prompt": prompt, "agent": agent, "model": (!model.is_empty()).then_some(model), "effort": (!effort.is_empty()).then_some(effort),
        "mode": mode, "cwd": (!m.cwd.is_empty()).then(|| m.cwd.clone()), "attachments": attachments, "by": "crew", "title": format!("{} · {}", m.name, if job == JobKind::Checkin { "Check-in" } else { "Job" }),
        "ext": { PLUGIN_ID: ext },
    });
    let mut args = args;
    let made = match &place {
        Some((machine, cwd)) => {
            // no folder: the machine's own default (a member's there may have none)
            args["cwd"] = if cwd.is_empty() { Value::Null } else { json!(cwd) };
            let made = calls::routed::<rt::Create>(ctx, call, machine, args).await?;
            let id = format!("{machine}|{}", made.get("id").and_then(Value::as_str).unwrap_or_default());
            if m.sandbox == "job" {
                calls::warn(
                    "a job's sandbox isn't kept as the job's",
                    calls::own(ctx, call, machine, json!({ "crew": m.id, "job": id })).await,
                );
            }
            let mut made = made;
            made["id"] = json!(id);
            made
        }
        None => calls::to_json(&ctx.run::<rt::Create>(call, calls::args_of::<rt::Create>(args)?).await?)?,
    };
    if let Some(id) = made.get("id").and_then(Value::as_str) {
        // the entry names its job before the job is kept: a sandbox's row seen in between finds whom it answers
        if let Some(r) = &w.reply {
            crate::answers::started(ctx, call, st, r, id).await;
        }
        st.add_job(&m.id, id, now(ctx)).await;
        if let Some((machine, task)) = id.split_once('|') {
            crate::remote::check(ctx, st, machine, task).await;
        }
    }
    let id = made.get("id").cloned().unwrap_or_default();
    let mut session = job_task(ctx, call, id.as_str().unwrap_or_default()).await.unwrap_or(made);
    // a sandbox's job is named as it's kept here (`<machine>|<id>`), not by its id over there
    session["id"] = id;
    Ok(session)
}

/// A job to start or queue.
fn work(prompt: String, job: JobKind, attachments: Vec<Value>, run: Option<RunPick>) -> WaitingJob {
    WaitingJob { prompt, job, attachments, run, ..WaitingJob::default() }
}

/// A job for `m`: now when a slot is free, else in its queue (v1 `assign`).
pub(crate) async fn assign(ctx: &Ctx, call: &Call, st: &State, m: &Member, w: WaitingJob) -> Result<c::Started, WireError> {
    let busy = u32::try_from(jobs_of(ctx, call, st, m).await.iter().filter(|j| j.live()).count()).unwrap_or(u32::MAX);
    match place(m, busy, w.job).map_err(wire)? {
        Placement::Start => Ok(c::Started { session: Some(start(ctx, call, st, m, &w).await?), ..c::Started::default() }),
        Placement::Queue => {
            let id = wisp_kernel::ids::uuid7();
            let mut m = m.clone();
            m.queue.push(WaitingJob { id: id.clone(), at: now(ctx), ..w });
            let position = u32::try_from(m.queue.len()).unwrap_or(u32::MAX);
            st.put(m);
            st.save().await;
            Ok(c::Started { queued: Some(id), position: Some(position), session: None })
        }
    }
}

/// `crew.checkin`: one check-in at a time per member (v1 `checkin`).
pub(crate) async fn checkin(ctx: &Ctx, call: &Call, st: &State, id: &str, wake: bool) -> Result<c::Started, WireError> {
    let mut m = st.member(id)?;
    let live = jobs_of(ctx, call, st, &m).await.iter().any(|j| j.job == JobKind::Checkin && j.live());
    if checkin_already(&m, live) {
        return Err(WireError::conflict(format!("{} is already checking in.", m.name)));
    }
    let prompt = checkin_prompt(&m, wake);
    count_checkin(&mut m, now(ctx));
    st.put(m.clone());
    st.save().await;
    assign(ctx, call, st, &m, work(prompt, JobKind::Checkin, Vec::new(), None)).await
}

macro_rules! on {
    ($s:ident, $st:ident, $C:ty, |$state:ident, $ctx:ident, $call:ident, $a:ident| $body:expr) => {{
        let st = $st.clone();
        $s.command::<$C, _, _>(move |$ctx, $call, $a| {
            let $state = st.clone();
            async move { $body }
        });
    }};
}

/// `crew.wake` and `crew.wakeMentions` (ADR-0043).
fn adopt(s: &mut Setup, st: &Arc<State>) {
    // Add to crew… on a task (v1 POST /sessions/:id/crew): a new member, and the task becomes its first job
    on!(s, st, c::Adopt, |st, ctx, call, a| {
        let task = calls::task(&ctx, &call, &a.session_id).await.map_err(|_| WireError::not_found("That task is gone."))?;
        if calls::crew_of(&task).get("id").and_then(Value::as_str).is_some() {
            return Err(WireError::invalid("That task is already a crew member's job."));
        }
        let m =
            st.normalize(&a.member, None, now(&ctx), &profile_names(&ctx, &call).await, &crate::calls::machine_ids(&ctx, &call).await)?;
        st.put(m.clone());
        st.save().await;
        let ext = CrewExt { id: m.id.clone(), job: JobKind::Task, ..CrewExt::default() };
        calls::set_ext(&ctx, &call, &a.session_id, calls::to_json(&ext)?).await?;
        ctx.emit(&call, &wisp_crew_api::events::Joined { crew_id: m.id.clone(), name: m.name.clone(), how: "task".into() });
        Ok(view(&ctx, &call, &st, &m).await)
    });
}

fn wakes(s: &mut Setup, st: &Arc<State>) {
    // a wake (ADR-0043): what happened is the job; where it came from is said in it
    on!(s, st, c::Wake, |st, ctx, call, a| {
        let m = st.member(&a.id)?;
        let why = if a.why.trim().is_empty() { "You were woken: see what needs doing.".to_owned() } else { a.why.trim().to_owned() };
        let prompt = match &a.source {
            Some(src) => format!("{why}\n\n(woken by {src})"),
            None => why,
        };
        assign(&ctx, &call, &st, &m, work(prompt, JobKind::Task, Vec::new(), None)).await
    });
    on!(s, st, c::WakeMentions, |st, ctx, call, a| {
        let crew = lock(&st.saved).crew.clone();
        let found = wisp_crew_core::mentions::crew_mentions(&a.text, &crew);
        let mut out = Vec::new();
        for m in found.all {
            let m = m.clone();
            let prompt = match &a.source {
                Some(src) => format!("You were mentioned ({src}):\n\n{}", a.text.trim()),
                None => format!("You were mentioned:\n\n{}", a.text.trim()),
            };
            out.push(assign(&ctx, &call, &st, &m, work(prompt, JobKind::Task, Vec::new(), None)).await?);
        }
        Ok(out)
    });
}

pub(crate) fn register(s: &mut Setup, st: &Arc<State>) {
    adopt(s, st);
    on!(s, st, c::List, |st, ctx, call, _a| {
        let crew = lock(&st.saved).crew.clone();
        let mut out = Vec::new();
        for m in &crew {
            out.push(view(&ctx, &call, &st, m).await);
        }
        Ok(out)
    });
    on!(s, st, c::Get, |st, ctx, call, a| {
        let m = st.member(&a.id)?;
        let mut job_list = jobs_of(&ctx, &call, &st, &m).await;
        job_list.reverse();
        job_list.truncate(50);
        Ok(c::MemberDetail { member: view(&ctx, &call, &st, &m).await, job_list })
    });
    on!(s, st, c::GetLayout, |st, _ctx, _call, _a| {
        let saved = lock(&st.saved).clone();
        Ok(layout_of(&saved.crew_layout, &saved.crew))
    });
    on!(s, st, c::SetLayout, |st, _ctx, _call, a| {
        let crew = lock(&st.saved).crew.clone();
        let out = normalize_layout(&a.layout, &crew).map_err(wire)?;
        st.set_layout(out.clone());
        st.save().await;
        Ok(out)
    });
    on!(s, st, c::Create, |st, ctx, call, a| {
        let m =
            st.normalize(&a.member, None, now(&ctx), &profile_names(&ctx, &call).await, &crate::calls::machine_ids(&ctx, &call).await)?;
        st.put(m.clone());
        st.save().await;
        ctx.emit(&call, &wisp_crew_api::events::Joined { crew_id: m.id.clone(), name: m.name.clone(), how: "create".into() });
        let session =
            if a.checkin == Some(true) { checkin(&ctx, &call, &st, &m.id, false).await.ok().and_then(|s| s.session) } else { None };
        Ok(c::Created { member: view(&ctx, &call, &st, &m).await, session })
    });
    on!(s, st, c::Update, |st, ctx, call, a| {
        let mut prev = st.member(&a.id)?;
        if let Some(keep) = &a.queue {
            prev.queue.retain(|w| keep.contains(&w.id)); // drop waiting jobs
        }
        let mut m = st.normalize(
            &a.member,
            Some(&prev),
            now(&ctx),
            &profile_names(&ctx, &call).await,
            &crate::calls::machine_ids(&ctx, &call).await,
        )?;
        crate::offers::settle_all(&mut m, a.offers.as_ref(), now(&ctx));
        st.put(m.clone());
        st.save().await;
        ctx.emit(&call, &wisp_crew_api::events::MemberChanged { crew_id: m.id.clone() });
        Ok(view(&ctx, &call, &st, &m).await)
    });
    on!(s, st, c::Remove, |st, ctx, call, a| {
        let m = st.member(&a.id)?;
        st.remove(&m.id);
        st.save().await;
        ctx.emit(&call, &wisp_crew_api::events::Left { crew_id: m.id });
        Ok(c::Ok { ok: true })
    });
    on!(s, st, c::Detach, |st, ctx, call, a| {
        let mut m = st.member(&a.id)?;
        if m.spell.is_none() {
            return Err(WireError::invalid(format!("{} is already yours.", m.name)));
        }
        m.spell = None;
        m.changed = None;
        st.put(m.clone());
        st.save().await;
        Ok(view(&ctx, &call, &st, &m).await)
    });
    work_commands(s, st);
}

/// Giving a member work: assign, check in, wake, and the per-member stats.
fn work_commands(s: &mut Setup, st: &Arc<State>) {
    on!(s, st, c::Assign, |st, ctx, call, a| {
        let m = st.member(&a.id)?;
        let prompt = if a.prompt.trim().is_empty() && a.kit {
            format!(
                "Build your kit: make yourself excellent{}.",
                if m.role.is_empty() { " at your job".to_owned() } else { format!(" as our {}", m.role) }
            )
        } else {
            a.prompt.trim().to_owned()
        };
        if prompt.is_empty() {
            return Err(WireError::invalid("Tell them what to do."));
        }
        let harnesses = if a.run.as_ref().is_some_and(|r| r.agent.is_some()) { profile_names(&ctx, &call).await } else { Vec::new() };
        let run = job_run(&m, a.run.as_ref(), a.picked, &|h| harnesses.iter().any(|p| p == h)).map_err(wire)?;
        assign(&ctx, &call, &st, &m, work(prompt, JobKind::Task, a.attachments, run)).await
    });
    on!(s, st, c::Checkin, |st, ctx, call, a| checkin(&ctx, &call, &st, &a.id, false).await);
    wakes(s, st);
    crate::stats::register(s, st);
}

/// Every 20 s (v1 `tick`): the check-ins that are due, then each queue with room.
pub(crate) fn start_ticks(ctx: &Ctx, st: Arc<State>) {
    let scope = ctx.scope().clone();
    let c2 = ctx.clone();
    let Ok(clock) = ctx.clock() else { return };
    ctx.spawn(async move {
        loop {
            run_tick(&c2, &st).await;
            // on the kernel's clock, so a test's FakeClock drives the scheduler
            tokio::select! {
                () = scope.cancelled() => return,
                () = clock.sleep(TICK_MS) => {}
            }
        }
    });
}

async fn run_tick(ctx: &Ctx, st: &State) {
    let call = ctx.root_call();
    let crew = lock(&st.saved).crew.clone();
    let t = now(ctx);
    for mut m in crew {
        if let Some(fire) = tick(&mut m, t, &Utc) {
            st.put(m.clone());
            if let Err(e) = checkin(ctx, &call, st, &m.id, fire.wake).await {
                tracing::warn!(member = %m.name, error = %e.message, "crew check-in");
            }
        }
        let Ok(mut m) = st.member(&m.id) else { continue };
        let busy = u32::try_from(jobs_of(ctx, &call, st, &m).await.iter().filter(|j| j.live()).count()).unwrap_or(u32::MAX);
        let n = drain_count(&m, busy);
        if n == 0 {
            continue;
        }
        let due: Vec<WaitingJob> = m.queue.drain(..n).collect();
        st.put(m.clone());
        for w in due {
            if let Err(e) = start(ctx, &call, st, &m, &w).await {
                tracing::warn!(member = %m.name, error = %e.message, "crew job");
                // a full grid (its sandboxes): the job waits its turn again instead of being lost (ADR-0047)
                if grid_full(&e.message)
                    && let Ok(mut again) = st.member(&m.id)
                {
                    again.queue.insert(0, w);
                    st.put(again);
                }
            }
        }
    }
    st.save().await;
}

/// The agent profiles a member may name (wisp.runtime's `runtime.profiles`).
async fn profile_names(ctx: &wisp_kernel::Ctx, call: &wisp_kernel::Call) -> Vec<String> {
    calls::profile_names(ctx, call).await
}
