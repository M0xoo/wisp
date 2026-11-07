//! What a message does once it's through a channel's door, written once (v1 `conversation.js`). A
//! channel implements [`Conversation`] (what differs for it: how it says things, where a task started
//! there answers) and keeps only its wire and who may speak. No IO of its own: everything goes
//! through the channel's `say` and the phone.
use async_trait::async_trait;
use serde_json::Value;
use wisp_channels_api::{ActArgs, ActKind, ChannelCtx, Later, Mode, Parsed, Phone, Problem, RunOpts, StartOpts, Started, Thread};
use wisp_kernel::{Result, WireError};

use crate::grammar::parse_message;
use crate::lists;
use crate::policy::cap_mode;
use crate::scrub::{hide_names, truncate};

pub const NO_PROMPT: &str = "What should it do? Say it after the options.";
pub const NO_PROJECTS: &str = "No projects yet. Open a folder in wisp first.";
pub const BTW_HELP: &str = "Type your question after /btw.";

pub fn failed_line(what: &str, err: &WireError) -> String {
    format!("Couldn’t {what}: {}", truncate(&err.message, 300))
}

/// The part of a line before its first `:`, ending in one full stop.
pub fn first_part(line: &str) -> String {
    let head = line.split(':').next().unwrap_or_default();
    format!("{}.", head.strip_suffix('.').unwrap_or(head))
}

/// What differs per channel in a conversation (v1 `conversation.js`'s `c`).
#[async_trait]
pub trait Conversation: Send + Sync {
    fn phone(&self) -> &dyn Phone;
    fn ctx(&self) -> &ChannelCtx;
    fn channel(&self) -> &str;
    /// the sender's display name
    fn name(&self) -> &str;
    /// the sender's stable id
    fn sender(&self) -> &str;
    /// the most this chat may ask for
    fn cap(&self) -> Mode;
    fn fallback(&self) -> Option<Mode> {
        None
    }
    fn about(&self) -> Option<&str> {
        None
    }
    /// false: a channel that can't answer a tool approval
    fn approvals(&self) -> bool;
    /// the line for `stop`, `done` or `/btw` out of a thread
    fn no_thread(&self) -> &str;

    /// Posts a line here. Its value is what the channel sent (a message id), for `acked`.
    async fn say(&self, text: String) -> Result<Value>;
    async fn list(&self, p: &Parsed) -> Result<Value>;
    async fn refuse(&self, problems: &[Problem]) -> Result<Value> {
        self.say(lists::refusal(problems)).await
    }
    /// where a task started here answers
    async fn thread(&self, _p: &Parsed) -> Option<Thread> {
        None
    }
    /// a line when the message points at something gone
    fn stale(&self, _p: &Parsed) -> Option<String> {
        None
    }
    fn acked(&self, _thread: Option<&Thread>, _sent: &Value) {}
    /// keeps a first reply that couldn't go, for the next thing said in that thread. true: kept.
    fn owe(&self, _ack: &str) -> bool {
        false
    }
    /// status with less in it
    fn quiet(&self, line: String) -> String {
        line
    }
    /// a follow-up's answer, as this channel says it
    fn run_line(&self, line: String) -> String {
        line
    }
    /// where a later answer goes; None: said in this thread when it comes
    fn later(&self) -> Option<Later> {
        None
    }
    /// before a follow-up runs (a reaction, a typing mark); the returned undo runs if no turn comes
    fn before_run(&self, _session_id: &str) -> Option<Box<dyn FnOnce() + Send>> {
        None
    }
    fn failed(&self, what: &str, err: &WireError) -> String {
        failed_line(what, err)
    }
    fn btw_help(&self) -> &str {
        BTW_HELP
    }
}

/// say, refuse and list for a place others can read, or not (`open`). There a list is one fixed
/// line, help has nothing of yours, a refusal has no choices, and anything said loses names you didn't
/// write there. `typed`: what this message said, and what's already known there.
#[derive(Debug, Clone, Copy)]
pub struct Surface<'a> {
    pub ctx: &'a ChannelCtx,
    /// a place only you read: lists and names as they are
    pub open: bool,
    pub typed: &'a str,
    /// the one fixed line for a list where others can read
    pub no_list: &'a str,
}

impl Surface<'_> {
    pub fn say(&self, t: &str) -> String {
        if self.open { t.to_owned() } else { hide_names(t, self.ctx, self.typed) }
    }
    pub fn refuse(&self, problems: &[Problem]) -> String {
        if self.open {
            return self.say(&lists::refusal(problems));
        }
        let bare: Vec<Problem> = problems.iter().map(|p| Problem { choices: Vec::new(), ..p.clone() }).collect();
        self.say(&lists::refusal(&bare))
    }
    /// The text for a list command (`p.command`), as posted (not through `say` unless open).
    pub fn list(&self, p: &Parsed, c: &ChannelCtx) -> String {
        let name = p.command.as_deref().unwrap_or_default();
        if self.open {
            return self.say(&if lists::is_list(Some(name)) { lists::render(name, c, &p.arg) } else { String::new() });
        }
        match name {
            "help" => lists::help(),
            "status" => {
                let n = |st: &str| c.tasks.iter().filter(|s| s.state == st).count();
                format!("{} running, {} waiting: see them in wisp.", n("running"), n("waiting"))
            }
            _ => self.no_list.to_owned(),
        }
    }
}

/// `text`: the message, through `strip_formatting`. `session_id`: the task its thread belongs to.
/// `thread_text`: the same message as it reads in that thread (None: `text`).
pub async fn converse(c: &dyn Conversation, text: &str, session_id: Option<&str>, thread_text: Option<&str>) -> Result<Value> {
    if let Some(id) = session_id {
        let tc = c.phone().thread_ctx(id).await?;
        let ctx = ChannelCtx { thread: Some(tc), ..c.ctx().clone() };
        let p = parse_message(thread_text.unwrap_or(text), &ctx);
        if p.command.as_deref() != Some("new") {
            return in_thread(c, id, &p).await;
        }
    }
    start(c, &parse_message(text, c.ctx())).await
}

fn start_opts(c: &dyn Conversation, thread: Option<Thread>) -> StartOpts {
    StartOpts {
        channel: c.channel().to_owned(),
        name: c.name().to_owned(),
        sender: Some(c.sender().to_owned()),
        cap: Some(c.cap()),
        fallback: c.fallback(),
        about: c.about().map(str::to_owned),
        thread,
    }
}

async fn start(c: &dyn Conversation, p: &Parsed) -> Result<Value> {
    let phone = c.phone();
    if let Some(cmd) = p.command.as_deref().filter(|n| *n != "new") {
        phone.count("list", Some(cmd));
        if lists::is_list(Some(cmd)) {
            return c.list(p).await;
        }
        return c.say(c.no_thread().to_owned()).await;
    }
    if let Some(line) = c.stale(p) {
        return c.say(line).await;
    }
    if let Some(first) = p.problems.first() {
        phone.count("refused", Some(&first.kind));
        return c.refuse(&p.problems).await;
    }
    if p.prompt.is_empty() {
        let line = p.crew.as_ref().map_or_else(|| NO_PROMPT.to_owned(), |m| format!("Tell {} what to do after the name.", m.name));
        return c.say(line).await;
    }
    let asked = cap_mode(p.mode, c.cap(), c.fallback().unwrap_or(Mode::Plan));
    if asked.mode.is_none() {
        phone.count("refused", Some("mode"));
        return c.say(format!("{}\n\nNothing started.", asked.refused)).await;
    }
    if p.crew.is_none() && p.project.is_none() && c.ctx().default_project.is_none() {
        return c.say(NO_PROJECTS.to_owned()).await;
    }
    let thread = c.thread(p).await;
    let out: Started = match phone.start_parsed(p, &start_opts(c, thread.clone())).await {
        Ok(o) => o,
        Err(e) => return c.say(c.failed("start it", &e)).await,
    };
    // the task is running, so a first reply that couldn't go is still true: kept for the next thing
    // said there
    let sent = c.say(out.ack.clone()).await.inspect_err(|_| {
        c.owe(&out.ack);
    })?;
    c.acked(thread.as_ref(), &sent);
    Ok(sent)
}

async fn mention_in(c: &dyn Conversation, session_id: &str, p: &Parsed, name: &str) -> Result<Value> {
    if p.prompt.is_empty() {
        return c.say(format!("Tell {name} what to do after the name.")).await;
    }
    let thread = c.thread(p).await;
    let out = match c.phone().mention(session_id, p, &start_opts(c, thread.clone())).await {
        Ok(o) => o,
        Err(e) => return c.say(c.failed("ask them", &e)).await,
    };
    let sent = c.say(out.ack).await?;
    c.acked(thread.as_ref(), &sent);
    Ok(sent)
}

async fn in_thread(c: &dyn Conversation, session_id: &str, p: &Parsed) -> Result<Value> {
    let phone = c.phone();
    let cmd = p.command.as_deref();
    if lists::is_list(cmd) && cmd != Some("status") {
        return c.list(p).await;
    }
    match cmd {
        Some("stop") => return c.say(phone.stop(session_id).await?).await,
        Some("status") => return c.say(c.quiet(phone.status(session_id).await?)).await,
        Some("done") => {
            let a = ActArgs { session_id: session_id.into(), kind: ActKind::Done, reference: Some(String::new()), index: Some(0), text: None, approvals: c.approvals() };
            return c.say(phone.act(&a).await?).await;
        }
        _ => {}
    }
    if !p.problems.is_empty() {
        return c.refuse(&p.problems).await;
    }
    if let Some(m) = &p.crew {
        return mention_in(c, session_id, p, &m.name).await;
    }
    let btw = cmd == Some("btw");
    if p.prompt.is_empty() {
        return c.say(if btw { c.btw_help().to_owned() } else { NO_PROMPT.to_owned() }).await;
    }
    // in a thread the task's own mode stands unless one is asked for, and that one is held to the cap
    if let Some(m) = p.mode {
        let asked = cap_mode(Some(m), c.cap(), m);
        if asked.mode.is_none() {
            return c.say(asked.refused).await;
        }
    }
    let undo = if btw { None } else { c.before_run(session_id) };
    let o = RunOpts { name: c.name().into(), sender: Some(c.sender().into()), cap: Some(c.cap()), btw, about: c.about().map(str::to_owned), approvals: c.approvals() };
    // Only the follow-up itself: a reply that fails to arrive mustn't say it wasn't sent, or it gets
    // sent twice.
    let line = match phone.run(session_id, p, &o, c.later()).await {
        Ok(line) => {
            if !line.starts_with('✓')
                && let Some(u) = undo
            {
                u(); // refused: no turn is coming
            }
            c.run_line(line)
        }
        Err(e) => {
            if let Some(u) = undo {
                u();
            }
            c.failed("send that", &e)
        }
    };
    c.say(line).await
}
