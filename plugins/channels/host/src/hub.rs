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
use wisp_kernel::{BoxFuture, Ctx, Result, WireError};

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

/// Not a grid box (the grid client says otherwise once it lands).
struct NoGrid;
#[async_trait]
impl BoxApi for NoGrid {
    fn grid(&self) -> Option<BoxGrid> {
        None
    }
    fn in_box(&self) -> bool {
        false
    }
    fn bot_mark(&self, token: &str) -> String {
        wisp_channels_core::sign::sha256_hex(token.as_bytes())[..12].to_owned()
    }
    async fn channel_url(&self, _b: &BoxGrid, _c: &str, _bot: Option<&str>, _gone: bool) -> Result<Option<ChannelUrl>> {
        Ok(None)
    }
    async fn rotate_url(&self, _b: &BoxGrid, _c: &str) -> Result<ChannelUrl> {
        Err(WireError::unavailable("not a cloud wisp"))
    }
    async fn mail_reply(&self, _b: &BoxGrid, _to: &str, _s: &str, _t: &str) -> Result<Option<String>> {
        Ok(None)
    }
    async fn set_channel_key(&self, _b: &BoxGrid, _c: &str, _k: &str, _l: &[String]) -> Result<bool> {
        Ok(false)
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

impl KPhone {
    async fn cmd(&self, name: &str, args: Value) -> Result<Value> {
        self.0.run_json(&self.0.root_call(), name, args).await
    }
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
        let projects = self.projects().await?;
        let agents: Vec<wisp_channels_api::AgentView> = self.cmd("runtime.agents", json!({})).await.ok().and_then(|v| serde_json::from_value::<Vec<Value>>(v).ok()).unwrap_or_default().iter().map(agent_view).collect();
        let crew = self.cmd("crew.list", json!({})).await.ok().and_then(|v| v.as_array().cloned()).unwrap_or_default().iter().map(member_view).collect();
        let tasks = self.sessions().await.unwrap_or_default().into_iter().filter(|s| matches!(s.state.as_str(), "running" | "waiting")).map(|s| wisp_channels_api::TaskRow { id: s.id, title: s.title, state: s.state }).collect();
        let adapters = agents.iter().map(|a| wisp_channels_api::AdapterView { agent: a.clone(), overrides: Vec::new() }).collect();
        let default_agent = agents.iter().find(|a| a.available).map(|a| a.id.clone()).unwrap_or_default();
        Ok(ChannelCtx { default_project: projects.first().cloned(), projects, agents, adapters, crew, goals: wisp_router_api::GOALS.iter().map(|g| g.0.to_owned()).collect(), default_agent, tasks, ..ChannelCtx::default() })
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
            let _ = ctx.run_json(&ctx.root_call(), "telemetry.track", json!({ "event": "channel_event", "props": props })).await;
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
            if let Err(e) = ctx.run_json(&ctx.root_call(), "automations.trigger.push", ev).await {
                tracing::debug!("chat.message not handed to triggers: {}", e.message);
            }
        });
    }
    async fn thread_ctx(&self, session_id: &str) -> Result<ThreadCtx> {
        let t = self.cmd("runtime.get", json!({ "id": session_id })).await?;
        Ok(ThreadCtx { agent: t.get("agent").and_then(Value::as_str).unwrap_or_default().to_owned(), machine: String::new() })
    }
    async fn start_parsed(&self, p: &Parsed, o: &StartOpts) -> Result<Started> {
        // a channel never starts more than its cap, and never Full auto (v1 policy)
        let asked = p.mode.or(o.fallback).unwrap_or(wisp_channels_api::views::Mode::Plan);
        let mode = o.cap.map_or(asked, |c| asked.min(c)).min(wisp_channels_api::views::Mode::Edits);
        let mut a = json!({ "prompt": p.prompt, "mode": mode_str(Some(mode)), "by": format!("channel:{}", o.channel) });
        if let Some(pr) = &p.project {
            a["cwd"] = json!(pr.path);
        }
        if let Some(ag) = &p.agent {
            a["agent"] = json!(ag);
        }
        let made = self.cmd("runtime.create", a).await?;
        let id = made.get("id").and_then(Value::as_str).unwrap_or_default().to_owned();
        let t = self.cmd("runtime.get", json!({ "id": id })).await.unwrap_or_default();
        Ok(Started { ack: format!("Started ({}): {}", mode.label(), t.get("title").and_then(Value::as_str).unwrap_or_default()), session: Some(session_view(&t)), queued: None })
    }
    async fn stop(&self, session_id: &str) -> Result<String> {
        self.cmd("runtime.stop", json!({ "id": session_id })).await?;
        Ok("Stopped.".into())
    }
    async fn status(&self, session_id: &str) -> Result<String> {
        let t = self.cmd("runtime.get", json!({ "id": session_id })).await?;
        Ok(format!("{}: {}", t.get("title").and_then(Value::as_str).unwrap_or_default(), t.get("state").and_then(Value::as_str).unwrap_or_default()))
    }
    async fn run(&self, session_id: &str, p: &Parsed, o: &RunOpts, _later: Option<Later>) -> Result<String> {
        let mut a = json!({ "id": session_id, "text": p.prompt, "by": o.sender.clone().unwrap_or_else(|| o.name.clone()) });
        if let Some(m) = mode_str(o.cap) {
            a["mode"] = json!(m);
        }
        if o.btw {
            self.cmd("runtime.btw", json!({ "id": session_id, "question": p.prompt })).await?;
            return Ok("Asked on the side.".into());
        }
        self.cmd("runtime.followUp", a).await?;
        Ok("Sent.".into())
    }
    async fn mention(&self, _session_id: &str, p: &Parsed, o: &StartOpts) -> Result<Started> {
        self.start_parsed(p, o).await
    }
    async fn launch(&self, project: &ProjectView, prompt: &str) -> Result<Option<SessionView>> {
        let made = self.cmd("runtime.create", json!({ "prompt": prompt, "cwd": project.path, "mode": "plan" })).await?;
        self.session(made.get("id").and_then(Value::as_str).unwrap_or_default()).await
    }
    async fn act(&self, a: &ActArgs) -> Result<String> {
        let text = a.text.clone().unwrap_or_default();
        match a.kind {
            ActKind::Done => {
                self.cmd("runtime.setState", json!({ "id": a.session_id, "state": "done" })).await?;
                Ok("Marked done.".into())
            }
            ActKind::Answer => {
                self.cmd("runtime.answer", json!({ "id": a.session_id, "text": text })).await?;
                Ok("Answered.".into())
            }
            ActKind::Reply | ActKind::Text => {
                self.cmd("runtime.followUp", json!({ "id": a.session_id, "text": text })).await?;
                Ok("Sent.".into())
            }
        }
    }
    async fn projects(&self) -> Result<Vec<ProjectView>> {
        let list = self.cmd("resources.export", json!({ "kinds": ["project"] })).await.unwrap_or_default();
        Ok(list
            .pointer("/projects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|p| {
                let s = |k: &str| p.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
                ProjectView { id: s("name"), name: s("name"), path: s("path"), ..ProjectView::default() }
            })
            .collect())
    }
    async fn session(&self, id: &str) -> Result<Option<SessionView>> {
        Ok(self.cmd("runtime.get", json!({ "id": id })).await.ok().map(|t| session_view(&t)))
    }
    async fn sessions(&self) -> Result<Vec<SessionView>> {
        let list = self.cmd("runtime.list", json!({})).await?;
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
        Arc::new(NoGrid)
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
        KPhone(self.ctx.clone()).projects().await.ok()?.into_iter().next()
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
