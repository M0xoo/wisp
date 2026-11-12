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
use wisp_runtime_api::model::{
    Mode, Presentation, QueueItem, Session, SessionState, Turn, TurnStatus,
};
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
    pub ctl: mpsc::UnboundedSender<Ctl>,
}

impl Live {
    pub fn state(&self) -> Run {
        if self.finished {
            Run::Lingering
        } else {
            Run::Running {
                resumable: self.resumable,
            }
        }
    }
}

fn opt_str(v: Option<&Value>, k: &str) -> Option<String> {
    v.and_then(|o| o.get(k))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// A queued item's own mode and harness, from here on (v1 `#startQueued`).
fn apply_opts(s: &mut Session, item: &QueueItem) {
    let opts = item.opts.as_ref();
    if let Some(m) = opts
        .and_then(|o| o.get("mode"))
        .and_then(|m| serde_json::from_value::<Mode>(m.clone()).ok())
    {
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

fn shown(title: &str, summary: &str, status: &str) -> Presentation {
    let hero =
        serde_json::json!({ "type": "hero", "title": title, "summary": summary, "status": status });
    Presentation {
        blocks: vec![hero],
        v: wisp_runtime_core::blocks::PARSER_VERSION,
        ..Presentation::default()
    }
}

impl Runtime {
    /// Starts `item` as the task's next turn. The turn id, also for one held or refused.
    pub async fn start_turn(self: &Arc<Self>, mut s: Session, item: QueueItem) -> Result<TurnId> {
        apply_opts(&mut s, &item);
        let idx = self
            .repo
            .turns(s.id.as_str(), None, Some(1))
            .await?
            .last()
            .map_or(0, |t| t.idx + 1);
        let mut turn = Turn {
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
        };
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
            untrusted: s.ext.get("wisp.runtime").and_then(|o| o.pointer("/brief/untrusted")).and_then(serde_json::Value::as_bool).unwrap_or(false),
            kind: if idx == 0 {
                RunKind::First
            } else {
                RunKind::FollowUp
            },
            parent_id: s.parent_id.clone(),
            confirm_limit: item.opts.as_ref().and_then(|o| o.get("confirmLimit")).and_then(serde_json::Value::as_bool).unwrap_or(false),
        };
        let mut ctx = match self.host.before_run(ctx).await {
            Ok(c) => c,
            Err(e) => return self.refused(s, turn, &e.message).await,
        };
        // its project's setup failed in its fresh worktree: the turn waits with why (once: Start now runs it)
        if ctx.hold.is_none()
            && let Some(why) = s.ext.get_mut("wisp.runtime").and_then(Value::as_object_mut).and_then(|o| o.remove("setupFailed"))
        {
            ctx.hold = Some(wisp_runtime_api::model::Held { by: "wisp.runtime".into(), kind: "setup".into(), until: None, data: serde_json::json!({ "label": "Its setup", "why": why }) });
        }
        if let Some(h) = ctx.hold.clone() {
            turn.status = TurnStatus::Held;
            turn.held = Some(h.clone());
            s.state = SessionState::Review;
            s.unread = true;
            s.updated_at = self.now();
            self.persist(&mut s, vec![turn.clone()]).await?;
            self.host.emit(Emitted::Task("task.held", crate::host::fact(&s, Some(&turn.id), "held", &format!("{} ({})", h.kind, h.by), None)));
            self.host.emit(Emitted::Held(TurnHeld { session_id: s.id.clone(), turn_id: turn.id.clone(), by: h.by, kind: h.kind }));
            return Ok(turn.id);
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
        self.persist(&mut s, vec![turn.clone()]).await?;
        self.host.emit(Emitted::Started(TurnStarted {
            session_id: s.id.clone(),
            turn_id: turn.id.clone(),
        }));
        // a task or My Stuff mentioned in the prompt (the turn as saved keeps the user's words)
        let asked = Turn { prompt: self.with_mentions(&s, &turn, harness.info()).await, ..turn.clone() };
        let mut run = self.harness_run(&s, &asked, &ctx, harness.as_ref());
        run.grants = next.get("grants").and_then(Value::as_array).map(|g| g.iter().filter_map(Value::as_str).map(str::to_owned).collect()).unwrap_or_default();
        run.fork = next.get("fork").and_then(Value::as_bool).unwrap_or(false) && harness.info().fork;
        if next.get("once").and_then(Value::as_str) == Some("auto") {
            run.mode = Mode::Auto;
        }
        if turn.idx == 0 {
            self.record_setup(&s, &run);
        }
        if let Err(e) = self.spawn_run(&s, &turn, &harness, &run).await {
            let text = e.to_string();
            self.finish_now(s.id.as_str(), turn.id.as_str(), &text)
                .await?;
        }
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

    /// What the task had (ADR-0029), at its first run; its MCP servers probed in the background.
    fn record_setup(&self, s: &Session, run: &HarnessRun) {
        let harness = self.harness(&s.agent).ok();
        let dirs = harness.as_ref().map(|h| h.skill_dirs(&run.cwd)).unwrap_or_default();
        let available = crate::setup::available(s, run, &s.agent, &dirs);
        let servers: Vec<(String, Value)> = run.mcp_servers.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        let host = self.host.clone();
        crate::setup::record(self.repo.store.clone(), Arc::new(self.proc.clone()), self.host.net(), harness, s.id.0.clone(), available, servers, &move |f| host.spawn(f));
    }

    /// `before:run` vetoed it, or its harness is gone: the turn says why, and the task lands.
    async fn refused(
        self: &Arc<Self>,
        mut s: Session,
        mut turn: Turn,
        why: &str,
    ) -> Result<TurnId> {
        turn.status = TurnStatus::Error;
        turn.is_error = true;
        turn.ended_at = Some(self.now());
        turn.presentation = Some(shown("Not started", why, "blocked"));
        s.state = SessionState::Review;
        s.unread = true;
        s.updated_at = self.now();
        self.persist(&mut s, vec![turn.clone()]).await?;
        Ok(turn.id)
    }

    fn harness_run(
        &self,
        s: &Session,
        t: &Turn,
        ctx: &BeforeRunCtx,
        h: &dyn Harness,
    ) -> HarnessRun {
        let info = h.info();
        let parts: Vec<String> = self
            .host
            .prompt_parts()
            .iter()
            .map(|p| p.part(s))
            .filter(|p| !p.is_empty())
            .collect();
        // v1 runner.js:1379: the app block and wisp_watch unless switched off; a plain markdown answer when wisp
        // blocks are off, never for a crew job or a subagent (their reader reads the blocks)
        let (apps, watch) = (self.on_unless_off("runtime.apps"), self.on_unless_off("runtime.watch"));
        let plain = !self.on_unless_off("runtime.blocks") && s.parent_id.is_none() && !s.ext.contains_key("wisp.crew");
        let mut system = system_prompt(&SystemOpts {
            ask_tool: info.ask_tool.clone(),
            apps,
            watch,
            blocks: !plain,
            ..SystemOpts::default()
        });
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
        if let Some(repo) = std::path::Path::new(&s.cwd).ancestors().find(|d| d.join(".wisp").is_dir())
            && let Ok(exe) = std::env::current_exe()
        {
            mcp_servers.insert("wisp-history".to_owned(), serde_json::json!({ "type": "stdio", "command": exe.display().to_string(), "args": ["mcp", "--repo", repo.display().to_string()] }));
        }
        // the MCP servers other plugins give this run (connectors: a formula's `connectors:`)
        let q = wisp_runtime_api::points::McpQuery { mode: ctx.once.unwrap_or(s.mode), harness: s.agent.clone(), team: s.ext.get("wisp.runtime").and_then(|o| o.get("subagents")).and_then(serde_json::Value::as_array).cloned().unwrap_or_default(), turn_id: t.id.0.clone(), sub: s.parent_id.is_some() };
        for part in self.host.run_parts() {
            for (k, v) in part.mcp_servers(s, &q) {
                mcp_servers.entry(k).or_insert(v);
            }
        }
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
            // v1 defaults.subagentModel: the model Claude Code's subagents run on ('task' is the task's own)
            subagent_model: Some(self.text_setting("runtime.subagentModel")).filter(|m| m == "haiku" || m == "sonnet").unwrap_or_default(),
            ..HarnessRun::default()
        }
    }

    async fn spawn_run(
        self: &Arc<Self>,
        s: &Session,
        t: &Turn,
        h: &Arc<dyn Harness>,
        run: &HarnessRun,
    ) -> Result<()> {
        let launch = h.launch(run)?;
        let tmp = self.write_files(t, &launch).await?;
        let fill = |x: &str| x.replace("{tmp}", &tmp);
        let mut set: Vec<(String, String)> = run
            .env
            .iter()
            .chain(&run.account_env)
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        set.extend(launch.env.iter().map(|(k, v)| (k.clone(), fill(v))));
        // never the server's own folder: a task with none (adopted from a share, made before
        // `specs::folder`) runs in one empty folder of its own, the same each turn so a resume finds it
        let cwd = if !launch.cwd.is_empty() {
            launch.cwd.clone()
        } else if !s.cwd.is_empty() {
            s.cwd.clone()
        } else {
            let dir = std::env::temp_dir().join(format!("wisp-scratch-{}", s.id.0));
            tokio::fs::create_dir_all(&dir)
                .await
                .map_err(|e| RuntimeError::Invalid(format!("couldn't make a folder for the task: {e}")))?;
            dir.to_string_lossy().into_owned()
        };
        let opts = SpawnOpts {
            cwd: Some(cwd.into()),
            env: Env {
                clear: false,
                set,
                remove: launch.env_remove.clone(),
            },
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
            ctl,
        };
        self.live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(s.id.0.clone(), live);
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
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        for f in &launch.files {
            if f.path.contains("..") {
                return Err(RuntimeError::Invalid(format!(
                    "launch file {} leaves its folder",
                    f.path
                )));
            }
            tokio::fs::write(dir.join(&f.path), &f.contents)
                .await
                .map_err(|e| RuntimeError::Invalid(e.to_string()))?;
        }
        Ok(dir.to_string_lossy().into_owned())
    }

    pub(crate) fn send(&self, id: &str, c: Ctl) -> bool {
        let mut live = self
            .live
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
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
