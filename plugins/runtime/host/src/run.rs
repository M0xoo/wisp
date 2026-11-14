//! Starting a turn (v1 runner.js `#startTurn`): the turn row, `before:run` (which may hold or veto it),
//! the run's inputs (system prompt, env, resume id), the harness's `Launch`, spawned through the proc
//! service. The process is then driven by `drive.rs`.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde_json::Value;
use tokio::sync::mpsc;
use wisp_proc::{Env, SpawnOpts};
use wisp_runtime_api::events::{TurnHeld, TurnStarted};
use wisp_runtime_api::harness::{HarnessRun, Launch, Stdin};
use wisp_runtime_api::hooks::{BeforeRunCtx, RunKind};
use wisp_runtime_api::model::{Mode, Presentation, QueueItem, Session, SessionState, Turn, TurnStatus};
use wisp_runtime_api::{Harness, TurnId};
use wisp_runtime_core::prompt::{SystemOpts, system_prompt};
use wisp_runtime_core::queue::Run;

use crate::error::{Result, RuntimeError};
use crate::host::Emitted;
use crate::runtime::Runtime;

/// What the drive loop is told from outside.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Ctl {
    Stop,
    Interrupt,
    /// the result is in and a follow-up waits: let the lingering CLI go
    Release,
}

/// A task's run while its process lives.
#[derive(Debug)]
#[allow(clippy::struct_excessive_bools)] // v1's live/stopping/interrupting sets, one per flag
pub(crate) struct Live {
    pub resumable: bool,
    /// the turn has its result; the CLI is only on its way out
    pub finished: bool,
    pub stopping: bool,
    pub interrupting: bool,
    /// the running turn's last step that isn't text (the row's live line)
    pub label: Option<String>,
    /// the account the run is on (what `before:run` picked): its usage reports are that account's
    pub account: Option<String>,
    pub ctl: mpsc::UnboundedSender<Ctl>,
}

impl Live {
    pub fn state(&self) -> Run {
        if self.finished { Run::Lingering } else { Run::Running { resumable: self.resumable } }
    }
}

fn opt_str(v: Option<&Value>, k: &str) -> Option<String> {
    v.and_then(|o| o.get(k)).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// A queued item's own mode and harness, from here on (v1 `#startQueued`).
fn apply_opts(s: &mut Session, item: &QueueItem) {
    let opts = item.opts.as_ref();
    if let Some(m) = opts.and_then(|o| o.get("mode")).and_then(|m| serde_json::from_value::<Mode>(m.clone()).ok()) {
        s.mode = m;
    }
    let run = opts.and_then(|o| o.get("run"));
    if let Some(agent) = opt_str(run, "agent").filter(|a| *a != s.agent) {
        s.agent = agent;
        // another harness keeps its own conversation
        s.resume_id = None;
    }
    if let Some(m) = opt_str(run, "model") {
        s.model = m;
    }
    if let Some(e) = opt_str(run, "effort") {
        s.effort = e;
    }
}

/// The hero title of a turn `before:run` (or its folder) refused: it never started.
pub(crate) const NOT_STARTED: &str = "Not started";

fn shown(title: &str, summary: &str, status: &str) -> Presentation {
    let hero = serde_json::json!({ "type": "hero", "title": title, "summary": summary, "status": status });
    Presentation { blocks: vec![hero], v: wisp_runtime_core::blocks::PARSER_VERSION, ..Presentation::default() }
}

impl Runtime {
    /// Starts `item` as the task's next turn. The turn id, also for one held or refused.
    pub async fn start_turn(self: &Arc<Self>, mut s: Session, item: QueueItem) -> Result<TurnId> {
        let was = s.agent.clone();
        apply_opts(&mut s, &item);
        // a capped task's turn never runs above its cap, whatever its queued item asked (F-chan-10)
        let capped = crate::capped::cap_of(&s);
        s.mode = wisp_runtime_core::cap::at_cap(s.mode, capped);
        let run = item.opts.as_ref().and_then(|o| o.get("run"));
        let next = self.harness(&s.agent).ok();
        crate::handoff::carry_over(&mut s, &was, opt_str(run, "model").is_some(), opt_str(run, "effort").is_some(), next.as_deref());
        let idx = self.repo.turns(s.id.as_str(), None, Some(1)).await?.last().map_or(0, |t| t.idx + 1);
        let mut turn = self.new_turn(&s, &item, idx);
        let ctx = BeforeRunCtx {
            session_id: s.id.clone(),
            turn_id: turn.id.clone(),
            agent: s.agent.clone(),
            account: s.account.clone(),
            model: s.model.clone(),
            effort: s.effort.clone(),
            mode: s.mode,
            cwd: s.cwd.clone(),
            prompt: item.text.clone(),
            by: item.by.clone(),
            hold: None,
            account_env: BTreeMap::new(),
            once: None,
            // a project declared without trusting its hooks or MCP servers (crate::kinds)
            untrusted: s
                .ext
                .get("wisp.runtime")
                .and_then(|o| o.pointer("/brief/untrusted"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            kind: if idx == 0 { RunKind::First } else { RunKind::FollowUp },
            parent_id: s.parent_id.clone(),
            confirm_limit: item.opts.as_ref().and_then(|o| o.get("confirmLimit")).and_then(serde_json::Value::as_bool).unwrap_or(false),
            together: crate::trial::together(&s, idx),
        };
        // its folder first (a worktree archiving removed comes back on its branch), before anything reads it
        if let Err(why) = self.folder_ready(&s, Some(&turn.id)).await {
            return self.refused(s, turn, &why).await;
        }
        let mut ctx = match self.host.before_run(ctx).await {
            Ok(c) => c,
            Err(e) => return self.refused(s, turn, &e.message).await,
        };
        ctx.once = ctx.once.map(|m| wisp_runtime_core::cap::at_cap(m, capped));
        // the account wisp.accounts picked (an account at its limit or signed out is skipped on a run you start):
        // the turn says which, so its end and its usage reports count on that account, not the task's first pick
        if let Some(a) = ctx.account.clone().filter(|a| !a.is_empty()) {
            turn.account = Some(a);
        }
        // its project's setup failed in its fresh worktree: the turn waits with why (once: Start now runs it)
        if ctx.hold.is_none()
            && let Some(why) = s.ext.get_mut("wisp.runtime").and_then(Value::as_object_mut).and_then(|o| o.remove("setupFailed"))
        {
            ctx.hold = Some(wisp_runtime_api::model::Held {
                by: "wisp.runtime".into(),
                kind: "setup".into(),
                until: None,
                data: serde_json::json!({ "label": "Its setup", "why": why }),
            });
        }
        if let Some(h) = ctx.hold.clone() {
            return self.hold_turn(s, turn, h).await;
        }
        let harness = match self.harness(&s.agent) {
            Ok(h) => h,
            Err(e) => return self.refused(s, turn, &e.to_string()).await,
        };
        // one-off extras a command left for this run (approveBlocked's grants, a fork's first run)
        let next = s.ext.get_mut("wisp.runtime").and_then(Value::as_object_mut).and_then(|o| o.remove("next")).unwrap_or(Value::Null);
        // what other plugins keep on the turn before it runs (git: the checkpoint its rollback goes back to)
        self.kept_before(&s, &mut turn).await;
        s.state = SessionState::Running;
        s.unread = false;
        s.archived = false;
        s.updated_at = self.now();
        self.persist_start(&mut s, vec![turn.clone()]).await?;
        self.host.emit(Emitted::Started(TurnStarted { session_id: s.id.clone(), turn_id: turn.id.clone() }));
        // a task or My Stuff mentioned in the prompt (the turn as saved keeps the user's words)
        let asked = Turn { prompt: self.with_mentions(&s, &turn, harness.info()).await, ..turn.clone() };
        // another harness taking over: what it missed goes first, with the user's rules (v1 handoff.js)
        let asked = Turn { prompt: Box::pin(self.with_handoff(&s, &asked, asked.prompt.clone())).await, ..asked };
        let mut run = self.harness_run(&s, &asked, &ctx, harness.as_ref());
        run.grants = next
            .get("grants")
            .and_then(Value::as_array)
            .map(|g| g.iter().filter_map(Value::as_str).map(str::to_owned).collect())
            .unwrap_or_default();
        run.fork = next.get("fork").and_then(Value::as_bool).unwrap_or(false) && harness.info().fork;
        if next.get("once").and_then(Value::as_str) == Some("auto") {
            run.mode = Mode::Auto;
        }
        run.mode = wisp_runtime_core::cap::at_cap(run.mode, capped);
        run.capped = capped.is_some();
        if turn.idx == 0 {
            self.record_setup(&s, &run);
        }
        if let Err(e) = self.spawn_run(&s, &turn, &harness, &run).await {
            let text = e.to_string();
            self.finish_now(s.id.as_str(), turn.id.as_str(), &text).await?;
        }
        Ok(turn.id)
    }

    /// The turn `item` starts, as it's saved (running, from now).
    fn new_turn(&self, s: &Session, item: &QueueItem, idx: u32) -> Turn {
        Turn {
            id: TurnId::new(),
            session_id: s.id.clone(),
            idx,
            prompt: item.text.clone(),
            agent: s.agent.clone(),
            model: s.model.clone(),
            effort: s.effort.clone(),
            account: s.account.clone(),
            mode: s.mode,
            attachments: item.attachments.clone(),
            by: item.by.clone(),
            status: TurnStatus::Running,
            started_at: self.now(),
            ..Turn::default()
        }
    }

    /// Parks a turn a `before_run` interceptor held: the task goes to Review with why, and nothing runs.
    async fn hold_turn(self: &Arc<Self>, mut s: Session, mut turn: Turn, h: wisp_runtime_api::model::Held) -> Result<TurnId> {
        turn.status = TurnStatus::Held;
        turn.held = Some(h.clone());
        s.state = SessionState::Review;
        s.unread = true;
        // a turn asked for it: the task is back in the list, with why it waits (and its folder stays)
        s.archived = false;
        s.updated_at = self.now();
        self.persist_start(&mut s, vec![turn.clone()]).await?;
        self.host.emit(Emitted::Task("task.held", crate::host::fact(&s, Some(&turn.id), "held", &format!("{} ({})", h.kind, h.by), None)));
        self.host.emit(Emitted::Held(TurnHeld { session_id: s.id.clone(), turn_id: turn.id.clone(), by: h.by, kind: h.kind }));
        Ok(turn.id)
    }

    /// What `runtime.run@1` contributors keep on a turn just before it runs (at most 3 s each).
    async fn kept_before(&self, s: &Session, turn: &mut Turn) {
        for part in self.host.run_parts() {
            if let Ok(Some((k, v))) = tokio::time::timeout(std::time::Duration::from_secs(3), part.before_turn(s)).await {
                turn.ext.insert(k, v);
            }
        }
    }

    /// Every `runtime.run@1` contributor's `ready` (in order, the first refusal wins), then the folders themselves:
    /// a task whose folder, or one of its extra folders (`dirs`), is gone and that nobody brought back is refused,
    /// never run somewhere else or without it. A turn (`turn`: its id), a /btw and `runtime.quick` (None) all come
    /// through here.
    pub(crate) async fn folder_ready(&self, s: &Session, turn: Option<&TurnId>) -> std::result::Result<(), String> {
        let wait = std::time::Duration::from_millis(wisp_runtime_api::points::READY_MS);
        for part in self.host.run_parts() {
            match tokio::time::timeout(wait, part.ready(s, turn)).await {
                Ok(Ok(())) => {}
                Ok(Err(why)) => return Err(why),
                Err(_) => return Err(format!("This task's folder didn't come back in time ({}).", part.id())),
            }
        }
        folder_there(&s.cwd).await?;
        for dir in &s.dirs {
            extra_there(dir).await?;
        }
        Ok(())
    }

    /// What the task had (ADR-0029), at its first run; its MCP servers probed in the background.
    fn record_setup(&self, s: &Session, run: &HarnessRun) {
        let harness = self.harness(&s.agent).ok();
        let dirs = harness.as_ref().map(|h| h.skill_dirs(&run.cwd)).unwrap_or_default();
        let available = crate::setup::available(s, run, &s.agent, &dirs);
        let servers: Vec<(String, Value)> = run.mcp_servers.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let host = self.host.clone();
        crate::setup::record(
            self.repo.store.clone(),
            Arc::new(self.proc.clone()),
            self.host.net(),
            harness,
            s.id.0.clone(),
            available,
            servers,
            &move |f| host.spawn(f),
        );
    }

    /// `before:run` vetoed it, its folder can't be made ready, or its harness is gone: the turn says why, and the
    /// task lands (out of Archived, where the refusal would go unseen).
    async fn refused(self: &Arc<Self>, mut s: Session, mut turn: Turn, why: &str) -> Result<TurnId> {
        turn.status = TurnStatus::Error;
        turn.is_error = true;
        turn.ended_at = Some(self.now());
        turn.presentation = Some(shown(NOT_STARTED, why, "blocked"));
        s.state = SessionState::Review;
        s.unread = true;
        s.archived = false;
        s.updated_at = self.now();
        self.persist_start(&mut s, vec![turn.clone()]).await?;
        Ok(turn.id)
    }

    /// A turn's start written over the task as it is now, under its lock: `s` was read before the start's awaits
    /// (folder, `before:run`, run parts), so another plugin's slot written meanwhile (`runtime.setExt`: a goal
    /// dropped) is kept, never put back as `s` had it. Runtime's own slot is the start's.
    async fn persist_start(self: &Arc<Self>, s: &mut Session, turns: Vec<Turn>) -> Result<()> {
        let _guard = self.task_lock(s.id.as_str()).await;
        if let Ok(now) = self.repo.session(s.id.as_str()).await {
            carry_others_ext(s, now.ext);
        }
        self.persist(s, turns).await.map(drop)
    }

    fn harness_run(&self, s: &Session, t: &Turn, ctx: &BeforeRunCtx, h: &dyn Harness) -> HarnessRun {
        let info = h.info();
        let parts: Vec<String> = self.host.prompt_parts().iter().map(|p| p.part(s)).filter(|p| !p.is_empty()).collect();
        // v1 runner.js:1379: the app block and wisp_watch unless switched off; a plain markdown answer when wisp
        // blocks are off, never for a crew job or a subagent (their reader reads the blocks)
        let (apps, watch) = (self.on_unless_off("runtime.apps"), self.on_unless_off("runtime.watch"));
        let plain = !self.on_unless_off("runtime.blocks") && s.parent_id.is_none() && !s.ext.contains_key("wisp.crew");
        let mut system =
            system_prompt(&SystemOpts { ask_tool: info.ask_tool.clone(), apps, watch, blocks: !plain, ..SystemOpts::default() });
        for p in &parts {
            system.push_str("\n\n");
            system.push_str(p);
        }
        let mut prompt = t.prompt.clone();
        // v1 withProtocol: a CLI without a system-prompt flag hears it ahead of the first prompt
        if !info.system_prompt_flag && s.resume_id.is_none() {
            prompt = format!("{}\n\n---\n\n# Task\n\n{prompt}", system.trim());
        }
        let mut env = BTreeMap::from([("WISP_TASK".to_owned(), s.id.0.clone())]);
        for part in self.host.run_parts() {
            env.extend(part.env(s));
        }
        if watch {
            env.insert("WISP_WATCH".into(), "1".into());
        }
        // wisp's own MCP server (ask_user, delegate, wisp_save…), with a token for this task only
        let mut mcp_servers = BTreeMap::new();
        if let Some(acc) = self.host.agent_access() {
            let (url, token) = (acc.url(), acc.token(s.id.as_str()));
            if info.ask_tool.is_some() {
                mcp_servers.insert("wisp".to_owned(), serde_json::json!({ "type": "http", "url": format!("{url}/api/mcp"), "headers": { "x-wisp-token": token, "x-wisp-session": s.id.0 } }));
            }
            env.insert("WISP_URL".into(), url);
            env.insert("WISP_TOKEN".into(), token);
        }
        // a repo that keeps its agent history (ADR-0033): its tools (`wisp mcp`: history, blame, task)
        // (a task with no folder has no repo: `Path::new("")` would find the server's own `.wisp/`)
        if let Ok(dir) = wisp_runtime_api::paths::Folder::of(&s.cwd)
            && let Some(repo) = dir.path().ancestors().find(|d| d.join(".wisp").is_dir())
            && let Ok(exe) = std::env::current_exe()
        {
            mcp_servers.insert("wisp-history".to_owned(), serde_json::json!({ "type": "stdio", "command": exe.display().to_string(), "args": ["mcp", "--repo", repo.display().to_string()] }));
        }
        // the MCP servers other plugins give this run (connectors: a formula's `connectors:`)
        let q = wisp_runtime_api::points::McpQuery {
            mode: ctx.once.unwrap_or(s.mode),
            harness: s.agent.clone(),
            team: s
                .ext
                .get("wisp.runtime")
                .and_then(|o| o.get("subagents"))
                .and_then(serde_json::Value::as_array)
                .cloned()
                .unwrap_or_default(),
            turn_id: t.id.0.clone(),
            sub: s.parent_id.is_some(),
        };
        for part in self.host.run_parts() {
            for (k, v) in part.mcp_servers(s, &q) {
                mcp_servers.entry(k).or_insert(v);
            }
        }
        let variant = crate::trial::variant_of(s);
        HarnessRun {
            session_id: s.id.0.clone(),
            turn_id: t.id.0.clone(),
            prompt,
            attachments: t.attachments.clone(),
            cwd: s.cwd.clone(),
            dirs: s.dirs.clone(),
            resume_id: s.resume_id.clone(),
            mode: ctx.once.unwrap_or(s.mode),
            model: s.model.clone(),
            effort: s.effort.clone(),
            system_prompt: system,
            mcp_servers,
            env,
            account_env: ctx.account_env.clone(),
            untrusted: ctx.untrusted,
            // the program `harnesses:` points at (`from: path`)
            bin: s.ext.get("wisp.runtime").and_then(|o| o.pointer("/brief/bin")).and_then(serde_json::Value::as_str).map(str::to_owned),
            probe: true,
            // v1 leanTask: lean when the task asked, or Settings says every run
            quiet: self.lean_task(s),
            // v1 defaults.subagentModel: the model Claude Code's subagents run on ('task' is the task's own); the task's
            // own pick (Try it two ways, `ext["wisp.runtime"].variant`) wins, '' included
            subagent_model: crate::trial::subagents_on(variant.subagent_model.as_deref(), &self.text_setting("runtime.subagentModel")),
            skills: if variant.skills.as_deref() == Some("off") { "off".into() } else { String::new() },
            ..HarnessRun::default()
        }
    }

    async fn spawn_run(self: &Arc<Self>, s: &Session, t: &Turn, h: &Arc<dyn Harness>, run: &HarnessRun) -> Result<()> {
        let launch = h.launch(run)?;
        let tmp = self.write_files(t, &launch).await?;
        let fill = |x: &str| x.replace("{tmp}", &tmp);
        let mut set: Vec<(String, String)> = run.env.iter().chain(&run.account_env).map(|(k, v)| (k.clone(), v.clone())).collect();
        set.extend(launch.env.iter().map(|(k, v)| (k.clone(), fill(v))));
        let cwd = run_folder(&launch.cwd, &s.cwd, &s.id.0).await?;
        let opts = SpawnOpts {
            cwd: Some(cwd),
            env: Env { clear: false, set, remove: launch.env_remove.clone() },
            no_stdin: launch.stdin == Stdin::Null,
            ..SpawnOpts::default()
        };
        let args: Vec<String> = launch.args.iter().map(|a| fill(a)).collect();
        let child = self.proc.spawn(&launch.program, &args, opts)?;
        let (handle, rx) = child.split();
        if let Stdin::Bytes(b) = &launch.stdin {
            handle.write(b.clone())?;
            handle.close_stdin();
        }
        let (ctl, ctl_rx) = mpsc::unbounded_channel();
        let live = Live {
            resumable: s.resume_id.is_some(),
            finished: false,
            stopping: false,
            interrupting: false,
            label: None,
            account: t.account.clone(),
            ctl,
        };
        self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(s.id.0.clone(), live);
        let rt = self.clone();
        let driver = h.driver(run);
        let (sid, tid) = (s.id.0.clone(), t.id.0.clone());
        tokio::spawn(async move { rt.drive(sid, tid, driver, handle, rx, ctl_rx).await });
        Ok(())
    }

    /// Files the launch asked for (an MCP config), in the turn's own temp folder. Returns the folder.
    async fn write_files(&self, t: &Turn, launch: &Launch) -> Result<String> {
        let dir = std::env::temp_dir().join(format!("wisp-run-{}", t.id));
        if launch.files.is_empty() {
            return Ok(dir.to_string_lossy().into_owned());
        }
        tokio::fs::create_dir_all(&dir).await.map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        for f in &launch.files {
            if f.path.contains("..") {
                return Err(RuntimeError::Invalid(format!("launch file {} leaves its folder", f.path)));
            }
            tokio::fs::write(dir.join(&f.path), &f.contents).await.map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        }
        Ok(dir.to_string_lossy().into_owned())
    }

    pub(crate) fn send(&self, id: &str, c: Ctl) -> bool {
        let mut live = self.live.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(l) = live.get_mut(id) else {
            return false;
        };
        match c {
            Ctl::Stop => l.stopping = true,
            Ctl::Interrupt => l.interrupting = true,
            Ctl::Release => {}
        }
        l.ctl.send(c).is_ok()
    }

    pub(crate) fn stop_run(&self, id: &str) {
        self.send(id, Ctl::Stop);
    }
    pub(crate) fn interrupt(&self, id: &str) {
        self.send(id, Ctl::Interrupt);
    }
    pub(crate) fn release_linger(&self, id: &str) {
        self.send(id, Ctl::Release);
    }
}

/// Where a harness runs, never the server's own folder: the launch's folder, else the task's; with neither
/// (adopted from a share, made before `specs::folder`, a `runtime.quick` with no folder) one empty folder of
/// its own under the temp dir, the same each turn for `scratch` so a resume finds it. A relative folder is
/// refused: it would resolve against the server's folder.
/// Every ext slot but runtime's own as `now` has it (other plugins write theirs under the task's lock).
fn carry_others_ext(s: &mut Session, mut now: wisp_runtime_api::model::Ext) {
    match s.ext.remove(OWN) {
        Some(own) => now.insert(OWN.to_owned(), own),
        None => now.remove(OWN),
    };
    s.ext = now;
}

const OWN: &str = "wisp.runtime";

pub(crate) async fn run_folder(launch: &str, task: &str, scratch: &str) -> Result<std::path::PathBuf> {
    let named = if launch.trim().is_empty() { task } else { launch };
    if !named.trim().is_empty() {
        return wisp_runtime_api::paths::Folder::of(named)
            .map(wisp_runtime_api::paths::Folder::into_path)
            .map_err(|e| RuntimeError::Invalid(format!("Not a project folder: {e}")));
    }
    let dir = std::env::temp_dir().join(format!("wisp-scratch-{scratch}"));
    tokio::fs::create_dir_all(&dir).await.map_err(|e| RuntimeError::Invalid(format!("couldn't make a folder for the task: {e}")))?;
    Ok(dir)
}

/// A task with a folder runs only there: Err (the reason, as the turn says it) when it's gone or not a folder.
/// No folder at all, or a relative one, is left to `run_folder` (its own scratch folder, or refused).
pub(crate) async fn folder_there(cwd: &str) -> std::result::Result<(), String> {
    if wisp_runtime_api::paths::Folder::of(cwd).is_err() {
        return Ok(());
    }
    match tokio::fs::metadata(cwd).await {
        Ok(m) if m.is_dir() => Ok(()),
        _ => Err(format!("This task's folder is gone: {cwd}. It runs only there, so nothing was started.")),
    }
}

/// One of a task's extra folders (`dirs`): Err, with its name, when it's gone or not a folder (it's never dropped
/// from the run silently). A relative one is left as it is: the harness is given it as named.
pub(crate) async fn extra_there(dir: &str) -> std::result::Result<(), String> {
    if wisp_runtime_api::paths::Folder::of(dir).is_err() {
        return Ok(());
    }
    match tokio::fs::metadata(dir).await {
        Ok(m) if m.is_dir() => Ok(()),
        _ => Err(format!("One of this task's extra folders is gone: {dir}. It runs only with all of them, so nothing was started.")),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod folder_tests {
    /// A harness (a turn, a /btw, `runtime.quick`) never spawns with no cwd, which is the server's own folder.
    #[tokio::test]
    async fn a_harness_runs_in_the_launchs_folder_else_the_tasks_else_its_own_scratch_never_the_servers() {
        let at = |p: &str| std::path::PathBuf::from(p);
        assert_eq!(super::run_folder("/launch", "/task", "t1").await.unwrap(), at("/launch"));
        assert_eq!(super::run_folder("", "/task", "t1").await.unwrap(), at("/task"));
        let scratch = super::run_folder(" ", "", "folder-test").await.unwrap();
        assert_eq!(scratch, std::env::temp_dir().join("wisp-scratch-folder-test"));
        assert!(scratch.is_dir(), "made, so the spawn finds it");
        for (launch, task) in [("relative", "/task"), ("", "src"), ("", ".")] {
            let e = super::run_folder(launch, task, "t1").await.unwrap_err();
            assert!(e.to_string().contains("Not a project folder"), "{launch:?} {task:?}: {e}");
        }
        std::fs::remove_dir_all(scratch).ok();
    }
}
