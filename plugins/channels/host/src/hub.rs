//! The hub a transport is handed (`ChannelHub`): its IO handles (net and exec through the kernel's
//! services, no socket or process of its own), its config (the `channel` resource for its transport,
//! `${secret:}` read), what wisp does for it (`Phone`: runtime commands as the channel's caller) and
//! what it keeps about tasks (their thread there, who started them). In memory; the config is the
//! resource, so a restart reads it again.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels_api::views::{
    ActArgs, ActKind, ActionKind, ChannelCtx, Parsed, ProjectView, Remote, RunOpts, SessionView, Signed, StartOpts, Started, Thread, ThreadCtx,
};
use wisp_channels_api::{AwayEntry, BoxApi, BoxGrid, ChannelHub, ChannelUrl, Exec, ExecOut, HttpRequest, HttpResponse, Later, Net, NetError, Phone, Status, Ws};
use wisp_kernel::services::NetRequest;
use wisp_kernel::{BoxFuture, Command, Ctx, Result, WireError};
use wisp_runtime_api::commands as rt;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The grid's thread for a task routed here (`remote.routed`), if it is one.
pub fn routed_thread(st: &State, session_id: &str) -> Option<String> {
    lock(&st.remotes).get(session_id).and_then(|r| r.get("routed")).and_then(Value::as_str).map(str::to_owned)
}

/// What the hub keeps, shared by every transport.
#[derive(Default)]
pub struct State {
    pub cfg: Mutex<HashMap<String, Value>>,
    pub status: Mutex<HashMap<String, Status>>,
    remotes: Mutex<HashMap<String, Remote>>,
    away: Mutex<HashMap<String, AwayEntry>>,
    started: Mutex<HashMap<String, (String, Option<String>)>>,
    /// the key taps are signed with (`channels/sign` in secrets)
    pub key: Mutex<String>,
}

pub struct Hub {
    pub ctx: Ctx,
    pub st: Arc<State>,
}

struct KNet(Ctx);
#[async_trait]
impl Net for KNet {
    async fn fetch(&self, req: HttpRequest) -> std::result::Result<HttpResponse, NetError> {
        let net = wisp_kernel::services::net(&self.0).map_err(|e| NetError::Broken(e.message))?;
        let r = net
            .fetch(NetRequest { method: req.method, url: req.url, headers: req.headers, body: req.body, timeout_ms: if req.timeout_ms == 0 { 15_000 } else { req.timeout_ms } })
            .await
            .map_err(|e| NetError::Broken(e.message))?;
        Ok(HttpResponse { status: r.status, headers: r.headers, body: r.body })
    }
}

struct KExec(Ctx);
#[async_trait]
impl Exec for KExec {
    async fn run(&self, bin: &str, args: &[String], stdin: Option<String>, timeout_ms: u64) -> Result<ExecOut> {
        let proc = self.0.service::<wisp_proc::Proc>()?;
        let opts = wisp_proc::ExecOpts { input: stdin.map(String::into_bytes), timeout: Some(std::time::Duration::from_millis(timeout_ms.max(1000))), scope: Some(self.0.scope().clone()), ..wisp_proc::ExecOpts::default() };
        let r = proc.exec(bin, args, opts).await.map_err(|e| WireError::unavailable(e.to_string()))?;
        Ok(ExecOut { code: r.exit.shell_code(), stdout: r.stdout_text(), stderr: r.stderr_text() })
    }
}

/// The grid, from a cloud box's side (v1 channels/box.js): which grid (`WISP_GRID_URL`), and the box's own secret
/// as its credential (`Box <handle> <secret>`): fine for this, since the answers only ever reach this same box. A
/// sandbox (one task's box) has no channels.
pub fn box_grid(env: &dyn Fn(&str) -> Option<String>) -> Option<BoxGrid> {
    let grid = env("WISP_GRID_URL").filter(|g| !g.is_empty())?.trim_end_matches('/').to_owned();
    let secret = env("WISP_TRUSTED_PROXY_SECRET").filter(|s| !s.is_empty())?;
    let public = env("WISP_PUBLIC_URL").filter(|s| !s.is_empty())?;
    if env("WISP_SANDBOX").as_deref() == Some("1") {
        return None;
    }
    let host = public.split("://").nth(1).unwrap_or(&public).split(['/', ':', '.']).next().unwrap_or_default().to_owned();
    Some(BoxGrid { grid, auth: format!("Box {host} {secret}") })
}

/// A cloud box's grid, through the kernel's net service.
struct KBox {
    ctx: Ctx,
    grid: Option<BoxGrid>,
}

impl KBox {
    async fn call(&self, b: &BoxGrid, method: &str, path: &str, body: Option<serde_json::Value>, timeout_ms: u64) -> Result<(u16, serde_json::Value)> {
        let net = wisp_kernel::services::net(&self.ctx)?;
        let mut headers = vec![("authorization".to_owned(), b.auth.clone())];
        if body.is_some() {
            headers.push(("content-type".into(), "application/json".into()));
        }
        let r = net.fetch(NetRequest { method: method.into(), url: format!("{}{path}", b.grid), headers, body: body.map(|v| v.to_string().into_bytes()).unwrap_or_default(), timeout_ms }).await?;
        Ok((r.status, serde_json::from_slice(&r.body).unwrap_or_default()))
    }
}

fn enc(s: &str) -> String {
    s.bytes().fold(String::new(), |mut o, b| {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            o.push(char::from(b));
        } else {
            use std::fmt::Write as _;
            let _ = write!(o, "%{b:02X}");
        }
        o
    })
}

#[async_trait]
impl BoxApi for KBox {
    fn grid(&self) -> Option<BoxGrid> {
        self.grid.clone()
    }
    fn in_box(&self) -> bool {
        self.grid.is_some()
    }
    /// proof of the token, not the token: a public id would let a box claim a bot it doesn't hold
    fn bot_mark(&self, token: &str) -> String {
        wisp_channels_core::sign::sha256_hex(format!("wisp bot|{token}").as_bytes())[..32].to_owned()
    }
    async fn channel_url(&self, b: &BoxGrid, c: &str, bot: Option<&str>, gone: bool) -> Result<Option<ChannelUrl>> {
        let path = format!("/api/channels/url?channel={}{}{}", enc(c), bot.map(|m| format!("&bot={}", enc(m))).unwrap_or_default(), if gone { "&gone=1" } else { "" });
        let (status, v) = self.call(b, "GET", &path, None, 10_000).await?;
        if status == 404 || status == 401 {
            return Ok(None);
        }
        if status != 200 || (v["url"].is_null() && v["address"].is_null()) {
            return Err(WireError::unavailable(v["error"].as_str().map_or_else(|| format!("the grid said {status}"), str::to_owned)));
        }
        Ok(Some(serde_json::from_value(v).unwrap_or_default()))
    }
    async fn rotate_url(&self, b: &BoxGrid, c: &str) -> Result<ChannelUrl> {
        let (status, v) = self.call(b, "POST", "/api/channels/rotate", Some(serde_json::json!({ "channel": c })), 10_000).await?;
        if status != 200 {
            return Err(WireError::unavailable(format!("The grid didn’t rotate it: {}.", v["error"].as_str().unwrap_or("no answer"))));
        }
        Ok(serde_json::from_value(v).unwrap_or_default())
    }
    /// the grid knows who to, and won't be told
    async fn mail_reply(&self, b: &BoxGrid, to: &str, s: &str, t: &str) -> Result<Option<String>> {
        let (status, v) = self.call(b, "POST", "/api/channels/mail/reply", Some(serde_json::json!({ "replyTo": to, "subject": s, "text": t })), 20_000).await?;
        if status != 200 {
            return Err(WireError::unavailable(v["error"].as_str().map_or_else(|| format!("the grid said {status}"), str::to_owned)));
        }
        Ok(v["messageId"].as_str().map(str::to_owned))
    }
    /// The key the grid's edge checks this channel's requests with (Discord's public key; empty: none, so its calls
    /// stop there and wake nothing). false: this grid holds no channels.
    async fn set_channel_key(&self, b: &BoxGrid, c: &str, k: &str, _l: &[String]) -> Result<bool> {
        let (status, v) = self.call(b, "POST", "/api/channels/key", Some(serde_json::json!({ "channel": c, "key": k })), 15_000).await?;
        match status {
            200 => Ok(true),
            404 => Ok(false),
            _ => Err(WireError::unavailable(v["error"].as_str().map_or_else(|| format!("the grid said {status}"), str::to_owned))),
        }
    }
}


/// A task as a channel sees it, from `runtime.get`.
pub fn session_view(t: &Value) -> SessionView {
    let s = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    SessionView {
        id: s("id"),
        title: s("title"),
        state: s("state"),
        agent: s("agent"),
        model: Some(s("model")).filter(|m| !m.is_empty()),
        cwd: Some(s("cwd")).filter(|m| !m.is_empty()),
        parent_id: t.get("parentId").and_then(Value::as_str).map(str::to_owned),
        queue_held: t.get("queueHeld").and_then(Value::as_bool).unwrap_or(false),
        branch: t.pointer("/ext/wisp.worktrees/branch").and_then(Value::as_str).filter(|b| !b.is_empty()).map(str::to_owned),
        created_at: t.get("createdAt").and_then(Value::as_i64),
        ..SessionView::default()
    }
}

/// A harness as `runtime.agents` lists it, as the grammar reads it.
fn agent_view(a: &Value) -> wisp_channels_api::AgentView {
    let strs = |v: &Value| v.as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
    let models = a["models"].as_array().into_iter().flatten().map(|m| wisp_channels_api::ModelView { id: m["id"].as_str().unwrap_or_default().to_owned(), label: m["label"].as_str().map(str::to_owned), efforts: strs(&m["efforts"]) }).collect();
    wisp_channels_api::AgentView { id: a["id"].as_str().unwrap_or_default().to_owned(), name: a["name"].as_str().map(str::to_owned), available: a["available"].as_bool().unwrap_or(false), signed_in: a["signedIn"].as_bool().unwrap_or(true), models, efforts: strs(&a["efforts"]) }
}

/// A crew member as `crew.list` gives it (its `member` and how busy it is).
fn member_view(v: &Value) -> wisp_channels_api::MemberView {
    let m = v.get("member").unwrap_or(v);
    let s = |k: &str| m[k].as_str().filter(|x| !x.is_empty()).map(str::to_owned);
    wisp_channels_api::MemberView {
        id: s("id").unwrap_or_default(),
        name: s("name").unwrap_or_default(),
        role: s("role"),
        agent: s("agent").unwrap_or_else(|| "auto".into()),
        model: s("model"),
        effort: s("effort"),
        mode: serde_json::from_value(m["mode"].clone()).ok(),
        cwd: s("cwd"),
        machine: s("machine"),
        sandbox: m["sandbox"].as_bool().unwrap_or(false) || m["sandbox"].is_string(),
        paused: m["paused"].as_bool().unwrap_or(false),
        running: v["running"].as_u64().and_then(|n| u32::try_from(n).ok()).unwrap_or(0),
        queue: m["queue"].as_array().cloned().unwrap_or_default(),
    }
}

/// What wisp does when a channel asks: runtime commands, as the channel's caller (its capability set).
pub struct KPhone(pub Ctx);

/// Typed command `C` as the root caller, its answer as the JSON `run_json` would have answered.
pub(crate) async fn typed<C: Command>(ctx: &Ctx, args: C::Args) -> Result<Value> {
    let out = ctx.run::<C>(&ctx.root_call(), args).await?;
    serde_json::to_value(out).map_err(|e| WireError::internal(e.to_string()))
}

/// `C` with args from hand-built JSON, refused in the words its handler would use (`<id>: <why>`).
pub(crate) async fn typed_json<C: Command>(ctx: &Ctx, v: Value) -> Result<Value> {
    let args = serde_json::from_value(v).map_err(|e| WireError::invalid(format!("{}: {e}", C::ID)))?;
    typed::<C>(ctx, args).await
}

pub(crate) fn get(id: &str) -> rt::IdArgs {
    rt::IdArgs { id: id.into() }
}

impl KPhone {
    async fn cmd<C: Command>(&self, args: C::Args) -> Result<Value> {
        typed::<C>(&self.0, args).await
    }
    async fn cmd_json<C: Command>(&self, args: Value) -> Result<Value> {
        typed_json::<C>(&self.0, args).await
    }
    /// The projects with when each was last used (its newest task, from `runtime.list`), and the default one
    /// (v1 phone.js `ctx.defaultProject`: the one picked in `channels.project`, else the last used, else the first).
    async fn projects_and_default(&self, tasks: &[SessionView]) -> (Vec<ProjectView>, Option<ProjectView>) {
        use wisp_channels_core::default_project as dp;
        let projects = dp::with_last_used(self.projects().await.unwrap_or_default(), tasks);
        let picked = self.0.setting(dp::SETTING);
        let default = dp::default_project(&projects, picked.as_ref().and_then(Value::as_str));
        (projects, default)
    }
}

/// `project` resources as a channel shows them: the name is the id, the spec's `path` is where a task runs.
pub fn project_views(list: &[wisp_resources_api::Resource]) -> Vec<ProjectView> {
    list.iter()
        .filter(|r| r.kind == "project")
        .map(|r| ProjectView { id: r.name.clone(), name: r.name.clone(), path: r.spec.get("path").and_then(Value::as_str).unwrap_or_default().to_owned(), ..ProjectView::default() })
        .collect()
}

fn mode_str(m: Option<wisp_channels_api::views::Mode>) -> Option<&'static str> {
    m.map(|m| match m {
        wisp_channels_api::views::Mode::Plan => "plan",
        wisp_channels_api::views::Mode::Edits => "edits",
        wisp_channels_api::views::Mode::Auto => "auto",
    })
}

#[async_trait]
impl Phone for KPhone {
    /// Everything a message may pick from: projects, this computer's harnesses (as the lists and the grammar read
    /// them), the crew, Auto's goals, the default project and harness, the tasks running or waiting.
    async fn context(&self) -> Result<ChannelCtx> {
        let sessions = self.sessions().await.unwrap_or_default();
        let (projects, default_project) = self.projects_and_default(&sessions).await;
        let agents: Vec<wisp_channels_api::AgentView> = self.cmd::<rt::Agents>(rt::AgentsArgs::default()).await.ok().and_then(|v| serde_json::from_value::<Vec<Value>>(v).ok()).unwrap_or_default().iter().map(agent_view).collect();
        let crew = self.cmd::<wisp_crew_api::commands::List>(wisp_crew_api::commands::NoArgs {}).await.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().map(member_view).collect();
        let tasks = sessions.into_iter().filter(|s| matches!(s.state.as_str(), "running" | "waiting")).map(|s| wisp_channels_api::TaskRow { id: s.id, title: s.title, state: s.state }).collect();
        let adapters = agents.iter().map(|a| wisp_channels_api::AdapterView { agent: a.clone(), overrides: Vec::new() }).collect();
        let default_agent = agents.iter().find(|a| a.available).map(|a| a.id.clone()).unwrap_or_default();
        Ok(ChannelCtx { default_project, projects, agents, adapters, crew, goals: wisp_router_api::GOALS.iter().map(|g| g.0.to_owned()).collect(), default_agent, tasks, ..ChannelCtx::default() })
    }
    /// v1 phone.js `count`: fixed values only (start, thread, list, refused and their detail), never what a
    /// message said; counted as `channel_event`.
    fn count(&self, kind: &str, detail: Option<&str>) {
        let mut props = json!({ "kind": kind });
        if let Some(d) = detail {
            props["detail"] = json!(d);
        }
        let ctx = self.0.clone();
        self.0.spawn(async move {
            let _ = typed_json::<wisp_telemetry_api::Track>(&ctx, json!({ "event": "channel_event", "props": props })).await;
        });
    }
    fn on_grid(&self) -> bool {
        false
    }
    async fn grid_reply(&self, _thread: &str, _text: &str) -> Result<()> {
        Err(WireError::unavailable("not a cloud wisp"))
    }
    fn thread_saved(&self) {}
    fn heard(&self, channel: &str, sender: &str, text: &str) {
        let at = self.0.clock().map_or(0, |c| c.now_ms());
        // the transport let the sender in (its allowed users), so the message is `trusted`: @mentions wake the crew
        let ev = json!({ "on": "chat.message", "key": format!("chat:{channel}:{sender}:{at}"), "at": at, "summary": text.lines().next().unwrap_or("").chars().take(160).collect::<String>(), "payload": { "channel": channel, "user": sender, "text": text, "trusted": true } });
        let ctx = self.0.clone();
        self.0.spawn(async move {
            if let Err(e) = typed_json::<wisp_automations_api::commands::TriggerPush>(&ctx, ev).await {
                tracing::debug!("chat.message not handed to triggers: {}", e.message);
            }
        });
    }
    async fn thread_ctx(&self, session_id: &str) -> Result<ThreadCtx> {
        let t = self.cmd::<rt::Get>(get(session_id)).await?;
        Ok(ThreadCtx { agent: t.get("agent").and_then(Value::as_str).unwrap_or_default().to_owned(), machine: String::new() })
    }
    async fn start_parsed(&self, p: &Parsed, o: &StartOpts) -> Result<Started> {
        // a channel never starts more than its cap, and never Full auto (v1 policy)
        let asked = p.mode.or(o.fallback).unwrap_or(wisp_channels_api::views::Mode::Plan);
        let mode = o.cap.map_or(asked, |c| asked.min(c)).min(wisp_channels_api::views::Mode::Edits);
        let mut a = json!({ "prompt": p.prompt, "mode": mode_str(Some(mode)), "by": format!("channel:{}", o.channel) });
        // a message that names no project runs in the default one (v1 phone.js `p.project || ctx.defaultProject`)
        let project = match &p.project {
            Some(pr) => Some(pr.clone()),
            None => self.projects_and_default(&self.sessions().await.unwrap_or_default()).await.1,
        };
        if let Some(pr) = project.filter(|pr| !pr.path.is_empty()) {
            a["cwd"] = json!(pr.path);
        }
        if let Some(ag) = &p.agent {
            a["agent"] = json!(ag);
        }
        if !o.attachments.is_empty() {
            a["attachments"] = json!(o.attachments);
        }
        let made = self.cmd_json::<rt::Create>(a).await?;
        let id = made.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let t = self.cmd::<rt::Get>(get(&id)).await.unwrap_or_default();
        Ok(Started { ack: format!("Started ({}): {}", mode.label(), t.get("title").and_then(Value::as_str).unwrap_or_default()), session: Some(session_view(&t)), queued: None })
    }
    async fn stop(&self, session_id: &str) -> Result<String> {
        self.cmd::<rt::Stop>(rt::StopArgs { id: session_id.into(), clear_queue: false }).await?;
        Ok("Stopped.".into())
    }
    async fn status(&self, session_id: &str) -> Result<String> {
        let t = self.cmd::<rt::Get>(get(session_id)).await?;
        Ok(format!("{}: {}", t.get("title").and_then(Value::as_str).unwrap_or_default(), t.get("state").and_then(Value::as_str).unwrap_or_default()))
    }
    async fn run(&self, session_id: &str, p: &Parsed, o: &RunOpts, _later: Option<Later>) -> Result<String> {
        let mut a = json!({ "id": session_id, "text": p.prompt, "by": o.sender.clone().unwrap_or_else(|| o.name.clone()) });
        if let Some(m) = mode_str(o.cap) {
            a["mode"] = json!(m);
        }
        if o.btw {
            self.cmd_json::<rt::Btw>(json!({ "id": session_id, "question": p.prompt })).await?;
            return Ok("Asked on the side.".into());
        }
        if !o.attachments.is_empty() {
            a["attachments"] = json!(o.attachments);
        }
        self.cmd_json::<rt::FollowUp>(a).await?;
        Ok("Sent.".into())
    }
    async fn mention(&self, _session_id: &str, p: &Parsed, o: &StartOpts) -> Result<Started> {
        self.start_parsed(p, o).await
    }
    async fn upload(&self, name: &str, mime: &str, bytes: Vec<u8>) -> Result<Value> {
        use base64::Engine as _;
        let u = self.cmd_json::<wisp_stuff_api::commands::Receive>(json!({ "name": name, "mime": mime, "data": base64::engine::general_purpose::STANDARD.encode(bytes) })).await?;
        Ok(json!({ "id": u.get("id"), "name": u.get("name"), "mime": u.get("mime"), "size": u.get("size") }))
    }
    async fn launch(&self, project: &ProjectView, prompt: &str) -> Result<Option<SessionView>> {
        let made = self.cmd_json::<rt::Create>(json!({ "prompt": prompt, "cwd": project.path, "mode": "plan" })).await?;
        self.session(made.get("id").and_then(Value::as_str).unwrap_or_default()).await
    }
    async fn act(&self, a: &ActArgs) -> Result<String> {
        let text = a.text.clone().unwrap_or_default();
        match a.kind {
            ActKind::Done => {
                self.cmd_json::<rt::SetState>(json!({ "id": a.session_id, "state": "done" })).await?;
                Ok("Marked done.".into())
            }
            ActKind::Answer => {
                self.cmd_json::<rt::Answer>(json!({ "id": a.session_id, "text": text })).await?;
                Ok("Answered.".into())
            }
            ActKind::Reply | ActKind::Text => {
                self.cmd_json::<rt::FollowUp>(json!({ "id": a.session_id, "text": text })).await?;
                Ok("Sent.".into())
            }
        }
    }
    /// The `project` resources (`resources.export` answers `Vec<Resource>`), as a message picks from them.
    async fn projects(&self) -> Result<Vec<ProjectView>> {
        let args = wisp_resources_api::ExportArgs { kinds: vec!["project".into()], include: Vec::new() };
        // a refusal is logged, never silently read as "no projects" (the manifest once named a permission that
        // doesn't exist, `resources:export`, and every channel said "No projects yet")
        match self.0.run::<wisp_resources_api::Export>(&self.0.root_call(), args).await {
            Ok(list) => Ok(project_views(&list)),
            Err(e) => {
                tracing::warn!("channels: projects not read: {}", e.message);
                Ok(Vec::new())
            }
        }
    }
    async fn session(&self, id: &str) -> Result<Option<SessionView>> {
        Ok(self.cmd::<rt::Get>(get(id)).await.ok().map(|t| session_view(&t)))
    }
    async fn sessions(&self) -> Result<Vec<SessionView>> {
        let list = self.cmd::<rt::List>(rt::ListArgs::default()).await?;
        Ok(list.as_array().into_iter().flatten().map(session_view).collect())
    }
}

#[async_trait]
impl ChannelHub for Hub {
    fn phone(&self) -> Arc<dyn Phone> {
        Arc::new(KPhone(self.ctx.clone()))
    }
    fn net(&self) -> Arc<dyn Net> {
        Arc::new(KNet(self.ctx.clone()))
    }
    fn ws(&self) -> Arc<dyn Ws> {
        Arc::new(crate::ws::KWs)
    }
    fn exec(&self) -> Arc<dyn Exec> {
        Arc::new(KExec(self.ctx.clone()))
    }
    fn grid(&self) -> Arc<dyn BoxApi> {
        Arc::new(KBox { ctx: self.ctx.clone(), grid: box_grid(&|k| std::env::var(k).ok()) })
    }
    fn now_ms(&self) -> i64 {
        self.ctx.clock().map(|c| c.now_ms()).unwrap_or_default()
    }
    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()> {
        match self.ctx.clock() {
            Ok(c) => c.sleep(ms),
            Err(_) => Box::pin(async {}),
        }
    }
    fn spawn(&self, fut: BoxFuture<'static, ()>) {
        self.ctx.spawn(fut);
    }
    fn warn(&self, msg: &str) {
        tracing::warn!("channels: {msg}");
    }
    fn cfg(&self, channel: &str) -> Value {
        lock(&self.st.cfg).get(channel).cloned().unwrap_or_else(|| json!({}))
    }
    fn set_cfg(&self, channel: &str, cfg: Value) {
        // what a transport keeps for itself (a poll cursor): merged over the declared config
        let mut all = lock(&self.st.cfg);
        let had = all.entry(channel.to_owned()).or_insert_with(|| json!({}));
        if let (Some(h), Some(n)) = (had.as_object_mut(), cfg.as_object()) {
            for (k, v) in n {
                h.insert(k.clone(), v.clone());
            }
        }
    }
    fn mark(&self, channel: &str, st: Status) {
        lock(&self.st.status).insert(channel.to_owned(), st);
    }
    fn changed(&self) {
        self.ctx.emit(&self.ctx.root_call(), &wisp_channels_api::Changed {});
    }
    fn restart(&self) {}
    fn tune(&self, _key: &str) -> Option<u64> {
        None
    }
    fn remote_of(&self, session_id: &str) -> Option<Remote> {
        lock(&self.st.remotes).get(session_id).cloned()
    }
    fn set_remote(&self, session_id: &str, remote: Remote) {
        lock(&self.st.remotes).insert(session_id.to_owned(), remote);
    }
    fn find_remote(&self, pred: &(dyn Fn(&Remote, &str) -> bool + Send + Sync)) -> Vec<String> {
        lock(&self.st.remotes).iter().filter(|(id, r)| pred(r, id)).map(|(id, _)| id.clone()).collect()
    }
    fn away(&self, session_id: &str) -> Option<AwayEntry> {
        lock(&self.st.away).get(session_id).cloned()
    }
    fn keep_away(&self, session_id: &str, entry: AwayEntry) {
        lock(&self.st.away).insert(session_id.to_owned(), entry);
    }
    fn sign(&self, session_id: &str, kind: ActionKind, reference: &str, index: u32) -> String {
        wisp_channels_core::sign::sign(&lock(&self.st.key), session_id, kind, reference, index)
    }
    fn verify(&self, s: &Signed) -> bool {
        wisp_channels_core::sign::verify(&lock(&self.st.key), s)
    }
    fn started_from(&self, session_id: &str) -> Option<(String, Option<String>)> {
        lock(&self.st.started).get(session_id).cloned()
    }
    fn mark_started(&self, session_id: &str, channel: &str, by: Option<&str>) {
        lock(&self.st.started).insert(session_id.to_owned(), (channel.to_owned(), by.map(str::to_owned)));
        self.ctx.emit(&self.ctx.root_call(), &wisp_channels_api::StartedFrom { session_id: session_id.to_owned(), channel: channel.to_owned(), by: by.map(str::to_owned) });
    }
    fn thread_started(&self, _s: Option<&SessionView>, _thread: Option<&Thread>, _by: Option<&str>, err: Option<&str>) {
        if let Some(e) = err {
            tracing::warn!("channels: a thread didn't start: {e}");
        }
    }
    async fn default_project(&self) -> Option<ProjectView> {
        let phone = KPhone(self.ctx.clone());
        phone.projects_and_default(&phone.sessions().await.unwrap_or_default()).await.1
    }
    async fn act(&self, a: &ActArgs) -> Result<String> {
        KPhone(self.ctx.clone()).act(a).await
    }
    async fn converse(&self, c: &dyn wisp_channels_api::conversation::Conversation, text: &str, session_id: Option<&str>, thread_text: Option<&str>) -> Result<Value> {
        wisp_channels_core::conversation::converse(c, text, session_id, thread_text).await
    }
    fn hash(&self, s: &str) -> String {
        wisp_channels_core::sign::sha256_hex(s.as_bytes())
    }
    fn random_int(&self, min: u32, max: u32) -> u32 {
        let n = u32::from_str_radix(&self.random_hex(4), 16).unwrap_or_default();
        min + n % (max.saturating_sub(min).max(1))
    }
    fn random_hex(&self, bytes: usize) -> String {
        let mut out = String::new();
        while out.len() < bytes * 2 {
            out.push_str(&wisp_channels_core::sign::sha256_hex(wisp_kernel::ids::uuid7().as_bytes()));
        }
        out.truncate(bytes * 2);
        out
    }
}

#[cfg(test)]
mod box_tests {
    use super::*;

    /// v1 channels/box.js `boxGrid`: a cloud box knows its grid and asks it as itself; a computer or a sandbox doesn't.
    #[test]
    fn a_cloud_box_asks_its_grid_as_itself_and_a_sandbox_has_no_channels() {
        static ON_BOX: [(&str, &str); 3] = [("WISP_GRID_URL", "https://grid.trywisp.dev/"), ("WISP_TRUSTED_PROXY_SECRET", "s3"), ("WISP_PUBLIC_URL", "https://pia.grid.trywisp.dev")];
        static SANDBOX: [(&str, &str); 4] = [("WISP_GRID_URL", "https://g"), ("WISP_TRUSTED_PROXY_SECRET", "s"), ("WISP_PUBLIC_URL", "https://x.g"), ("WISP_SANDBOX", "1")];
        let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| (*v).to_owned());
        let b = box_grid(&env(&ON_BOX)).expect("a box");
        assert_eq!((b.grid.as_str(), b.auth.as_str()), ("https://grid.trywisp.dev", "Box pia s3"));
        assert!(box_grid(&env(&[("WISP_GRID_URL", "https://g"), ("WISP_PUBLIC_URL", "https://pia.g")])).is_none(), "no secret: not a box");
        assert!(box_grid(&env(&SANDBOX)).is_none());
        assert_eq!(enc("a b&c"), "a%20b%26c");
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use wisp_resources_api::Resource;

    #[test]
    fn a_channel_reads_projects_from_the_export_list_and_the_first_is_the_default() {
        // what resources.export answers: an array of resources, not `{ projects: [...] }`
        let list: Vec<Resource> = serde_json::from_value(json!([
            { "kind": "project", "name": "api", "spec": { "path": "/w/api", "color": "teal" } },
            { "kind": "project", "name": "web", "spec": { "path": "/w/web" } },
            { "kind": "crew", "name": "ada", "spec": {} }
        ]))
        .unwrap();
        let got = project_views(&list);
        assert_eq!(got.iter().map(|p| (p.name.as_str(), p.path.as_str())).collect::<Vec<_>>(), [("api", "/w/api"), ("web", "/w/web")]);
        assert_eq!(got[0].id, "api");
        assert_eq!(project_views(&[]), Vec::<ProjectView>::new());
    }
}
