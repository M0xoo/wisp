//! A task live in the terminal (ADR-0022): `wisp "task"` in a terminal, `wisp attach <id>`, `wisp show
//! <id> --watch` and `wisp ls --watch`. The CLI is a sync client like the phone (ADR-0024): wisp-sync's
//! `SyncClient` on `GET /api/events`, its subs and unsubs on `POST /api/events`, no polling. What to
//! print comes from wisp-cli-core's `attach::View`; this file reads the stream, the keyboard and Ctrl-C.
//!
//! size-ok: the one place the CLI follows a topic (attach, ls --watch, waits), sharing its connection
use std::collections::BTreeMap;
use std::io::{IsTerminal, Write};
use std::path::Path;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::AsyncBufReadExt;
use tokio::sync::mpsc;
use wisp_cli_core::attach::{Out, View, state_line};
use wisp_cli_core::{IMAGE_MARK, Images, Renderers, Style, term};
use wisp_protocol::{ClientMessage, Row};
use wisp_sync::client::{Input, Options, Output, SyncClient};
use wisp_sync::sse::{SseParser, decode_frame};

use crate::client::{CliError, Client, Result};

/// How long after a first Ctrl-C a second one stops the run.
const SECOND_CTRL_C: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, Copy)]
pub struct Mode {
    /// questions asked inline and a reply box after the answer (a terminal on stdin)
    pub interactive: bool,
    /// return when no turn runs (`show --watch`, a pipe)
    pub until_idle: bool,
    /// started from here just now: every step, from the first
    pub fresh: bool,
}

enum Ev {
    Chunk(bytes::Bytes),
    Ended,
}

#[derive(Debug, Clone, PartialEq)]
enum Prompt {
    None,
    Ask(Vec<String>),
    Reply,
}

fn out_line(text: &str) {
    let mut o = std::io::stdout().lock();
    let _ = writeln!(o, "{text}");
    let _ = o.flush();
}

fn prompt(text: &str) {
    let mut o = std::io::stdout().lock();
    let _ = write!(o, "{text}");
    let _ = o.flush();
}

fn b64(bytes: &[u8]) -> String {
    const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            if i <= c.len() {
                s.push(A[((n >> shift) & 63) as usize] as char);
            } else {
                s.push('=');
            }
        }
    }
    s
}

/// An answer's line: an image drawn inline where the terminal can (the file read here), else the text.
fn print_lines(lines: &[String], st: &Style) {
    for l in lines {
        if let Some(path) = l.strip_prefix(IMAGE_MARK) {
            match (st.images, std::fs::metadata(path)) {
                (Images::Iterm, Ok(m)) if m.len() < 8 << 20 => {
                    if let Ok(b) = std::fs::read(path) {
                        out_line(&format!("\x1b]1337;File=inline=1;size={};preserveAspectRatio=1;width=auto:{}\x07", b.len(), b64(&b)));
                    }
                }
                (Images::Kitty, Ok(_)) => out_line(&format!("\x1b_Ga=T,f=100,t=f;{}\x1b\\", b64(path.as_bytes()))),
                _ => {}
            }
            continue;
        }
        out_line(l);
    }
}

/// The stream for this hello, chunk by chunk, until it ends.
fn open(c: &Client, params: &BTreeMap<String, String>, tx: mpsc::Sender<Ev>) {
    let enc = |x: &str| x.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect::<String>();
    let q: Vec<String> = params.iter().map(|(k, v)| format!("{}={}", enc(k), enc(v))).collect();
    let mut b = c.http().get(format!("{}/api/events?{}", c.url, q.join("&")));
    if let Some(t) = c.token() {
        b = b.header("x-wisp-token", t);
    }
    tokio::spawn(async move {
        if let Ok(mut r) = b.send().await
            && r.status().is_success()
        {
            while let Ok(Some(chunk)) = r.chunk().await {
                if tx.send(Ev::Chunk(chunk)).await.is_err() {
                    return;
                }
            }
        }
        let _ = tx.send(Ev::Ended).await;
    });
}

async fn post(c: &Client, client_id: &str, m: &ClientMessage) {
    let mut b = c.http().post(format!("{}/api/events", c.url)).header("x-wisp-client", client_id).json(m);
    if let Some(t) = c.token() {
        b = b.header("x-wisp-token", t);
    }
    // a sub sent before the stream registered: the client resubscribes after its next welcome
    let _ = b.send().await;
}

/// The keyboard, line by line (EOF closes the channel).
fn stdin_lines() -> mpsc::Receiver<String> {
    let (tx, rx) = mpsc::channel(16);
    tokio::spawn(async move {
        let mut lines = tokio::io::BufReader::new(tokio::io::stdin()).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if tx.send(l).await.is_err() {
                break;
            }
        }
    });
    rx
}

/// One sync connection to the local wisp, for one or more topics.
pub(crate) struct Conn {
    c: Client,
    id: String,
    sync: SyncClient,
    parser: SseParser,
    tx: mpsc::Sender<Ev>,
    rx: mpsc::Receiver<Ev>,
    start: Instant,
    retry: Option<Instant>,
}

/// What the connection handed the view.
pub(crate) enum Got {
    Snapshot(Vec<Row>),
    Ops(Vec<wisp_protocol::EntityOp>),
}

impl Conn {
    pub(crate) fn new(c: &Client, topics: &[String]) -> Self {
        let id = format!("cli-{}", crate::services::hex(&rand::random::<[u8; 8]>()));
        let mut sync = SyncClient::new(Options::new("local", id.clone(), crate::serve::VERSION));
        for t in topics {
            sync.handle(Input::Subscribe { topic: t.clone(), passive: false }, 0);
        }
        let (tx, rx) = mpsc::channel(64);
        Self { c: c.clone(), id, sync, parser: SseParser::new(), tx, rx, start: Instant::now(), retry: None }
    }

    fn now(&self) -> i64 {
        i64::try_from(self.start.elapsed().as_millis()).unwrap_or(i64::MAX)
    }

    /// Carries the machine's outputs out; returns what the view takes.
    async fn carry(&mut self, outs: Vec<Output>) -> Result<Vec<Got>> {
        let mut got = Vec::new();
        for o in outs {
            match o {
                Output::Request { params } => {
                    self.parser = SseParser::new();
                    open(&self.c, &params, self.tx.clone());
                }
                Output::Send(m) => post(&self.c, &self.id, &m).await,
                Output::Snapshot { rows, .. } => got.push(Got::Snapshot(rows)),
                Output::EntityOps { ops, .. } => got.push(Got::Ops(ops)),
                Output::Retry { at } => self.retry = Some(self.start + Duration::from_millis(u64::try_from(at).unwrap_or(0))),
                Output::State { update: Some(u), .. } => {
                    return Err(CliError::said(format!("this wisp speaks another sync protocol: update the {}", if u == wisp_sync::client::Update::Peer { "server" } else { "CLI" })));
                }
                Output::Denied { topic, code } => return Err(CliError::said(format!("{topic}: {code}"))),
                _ => {}
            }
        }
        Ok(got)
    }

    /// The stream dropped and a reconnect is due (the TUI's connection banner).
    pub(crate) fn reconnecting(&self) -> bool {
        self.retry.is_some()
    }

    pub(crate) async fn start(&mut self) -> Result<Vec<Got>> {
        let outs = self.sync.handle(Input::Open, self.now());
        self.carry(outs).await
    }

    /// The next thing from the stream: a chunk's frames, its end, or the reconnect time.
    pub(crate) async fn next(&mut self) -> Result<Vec<Got>> {
        let wake = self.retry;
        let ev = tokio::select! {
            ev = self.rx.recv() => ev,
            () = async { match wake { Some(at) => tokio::time::sleep_until(at.into()).await, None => std::future::pending().await } } => {
                self.retry = None;
                return self.start().await;
            }
        };
        let now = self.now();
        let outs = match ev {
            Some(Ev::Chunk(b)) => {
                let mut outs = Vec::new();
                for e in self.parser.push(&b) {
                    if let Some((id, messages)) = decode_frame(&e) {
                        outs.extend(self.sync.handle(Input::Frame { id, messages }, now));
                    }
                }
                outs
            }
            Some(Ev::Ended) | None => self.sync.handle(Input::Lost, now),
        };
        self.carry(outs).await
    }
}

/// `<home>/cli-detached.json`: tasks this terminal left running, for the notice on a later command.
fn detached_file(home: &Path) -> std::path::PathBuf {
    home.join("cli-detached.json")
}

fn shell_id() -> u32 {
    #[cfg(unix)]
    {
        std::os::unix::process::parent_id()
    }
    #[cfg(not(unix))]
    {
        0
    }
}

/// Remembers a task this terminal launched or detached from.
pub fn remember(home: &Path, id: &str, title: &str) {
    let f = detached_file(home);
    let mut list: Vec<Value> = std::fs::read(&f).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
    list.retain(|x| x["id"] != id);
    list.push(json!({ "id": id, "title": title, "shell": shell_id() }));
    if let Ok(b) = serde_json::to_vec(&list) {
        let _ = std::fs::write(f, b);
    }
}

/// One line per task this terminal left running that finished, asks or failed since; each said once.
pub async fn notices(c: &Client, home: &Path) {
    let f = detached_file(home);
    let Some(list) = std::fs::read(&f).ok().and_then(|b| serde_json::from_slice::<Vec<Value>>(&b).ok()) else { return };
    let me = shell_id();
    let st = crate::cli::style();
    let mut keep = Vec::new();
    for x in list {
        let id = x["id"].as_str().unwrap_or_default().to_owned();
        if x["shell"].as_u64() != Some(u64::from(me)) {
            keep.push(x);
            continue;
        }
        let state = c.cmd("runtime.get", json!({ "id": id })).await.ok().and_then(|s| s["state"].as_str().map(str::to_owned));
        match state.as_deref() {
            Some("running") => keep.push(x),
            Some(s) => {
                let what = match s {
                    "error" => "failed",
                    "waiting" => "asks you something",
                    _ => "finished",
                };
                eprintln!("  {} \"{}\" {what} · wisp attach {id}", state_line(&st, s).split(' ').next().unwrap_or("◌"), x["title"].as_str().unwrap_or(""));
            }
            None => {}
        }
    }
    if let Ok(b) = serde_json::to_vec(&keep) {
        let _ = std::fs::write(f, b);
    }
}

/// Follows task `id` until it goes idle (`until_idle`), you leave the reply box empty, or Ctrl-C.
#[allow(clippy::too_many_lines)] // one select loop: the stream, the keyboard and Ctrl-C
pub async fn attach(c: &Client, home: &Path, id: &str, mode: Mode) -> Result<i32> {
    let st = crate::cli::style();
    let r = Renderers::builtin();
    let mut view = if mode.fresh { View::launched(id) } else { View::new(id) };
    let mut conn = Conn::new(c, &[wisp_runtime_api::session_topic(id)]);
    let mut keys = if mode.interactive { Some(stdin_lines()) } else { None };
    let mut asking = Prompt::None;
    let mut got = conn.start().await?;
    loop {
        for g in got.drain(..) {
            let outs = match g {
                Got::Snapshot(rows) => view.snapshot(rows, &st, &r),
                Got::Ops(ops) => view.ops(ops, &st, &r),
            };
            for o in outs {
                match o {
                    Out::Line(l) => out_line(&l),
                    Out::Answer(lines) => {
                        out_line("");
                        print_lines(&lines, &st);
                    }
                    Out::Ask { question, options, .. } if mode.interactive => {
                        let q = json!({ "type": "question", "question": question, "options": options.iter().map(|o| json!({ "label": o })).collect::<Vec<_>>() });
                        out_line("");
                        print_lines(&r.block(&q, &st), &st);
                        prompt(&term::dim(&st, if options.is_empty() { "answer › " } else { "pick a number or type › " }));
                        asking = Prompt::Ask(options);
                    }
                    Out::Ask { question, .. } => out_line(&format!("  ? {question}  (wisp attach {id} to answer)")),
                    Out::Answered => {
                        if matches!(asking, Prompt::Ask(_)) {
                            out_line("");
                            asking = Prompt::None;
                        }
                    }
                    Out::Idle { state } => {
                        if mode.until_idle {
                            return Ok(i32::from(state == "error"));
                        }
                        if mode.interactive && !matches!(asking, Prompt::Ask(_)) {
                            out_line(&format!("\n{}", term::dim(&st, &format!("{}  · Enter to leave, or reply ›", state_line(&st, &state)))));
                            prompt("› ");
                            asking = Prompt::Reply;
                        }
                    }
                }
            }
        }
        tokio::select! {
            g = conn.next() => got = g?,
            line = async { match keys.as_mut() { Some(k) => k.recv().await, None => std::future::pending().await } } => {
                let Some(line) = line else {
                    keys = None;
                    if asking == Prompt::Reply { return Ok(0); }
                    continue;
                };
                let text = line.trim().to_owned();
                match std::mem::replace(&mut asking, Prompt::None) {
                    Prompt::Ask(options) => {
                        let pick = text.parse::<usize>().ok().and_then(|n| options.get(n.wrapping_sub(1))).cloned().unwrap_or_else(|| text.clone());
                        if pick.is_empty() {
                            prompt("› ");
                            asking = Prompt::Ask(options);
                            continue;
                        }
                        if let Err(e) = c.cmd("runtime.answer", json!({ "id": id, "text": pick })).await {
                            out_line(&format!("  ✗ {e}"));
                        }
                    }
                    Prompt::Reply if text.is_empty() => return Ok(0),
                    Prompt::Reply => {
                        if let Err(e) = c.cmd("runtime.followUp", json!({ "id": id, "text": text })).await {
                            out_line(&format!("  ✗ {e}"));
                            prompt("› ");
                            asking = Prompt::Reply;
                        }
                    }
                    Prompt::None if text.is_empty() => {}
                    Prompt::None => match c.cmd("runtime.followUp", json!({ "id": id, "text": text, "queue": true })).await {
                        Ok(_) => out_line(&term::dim(&st, "  ✓ queued: it goes when this turn ends")),
                        Err(e) => out_line(&format!("  ✗ {e}")),
                    },
                }
            }
            _ = tokio::signal::ctrl_c() => {
                eprintln!("\n  ◌ detached: the task keeps running · wisp attach {id}\n    (Ctrl-C again within 2 s stops it)");
                return Ok(tokio::select! {
                    _ = tokio::signal::ctrl_c() => {
                        let stopped = c.cmd("runtime.stop", json!({ "id": id })).await;
                        eprintln!("  {}", if stopped.is_ok() { "◼ stopped" } else { "✗ couldn't stop it" });
                        130
                    }
                    () = tokio::time::sleep(SECOND_CTRL_C) => {
                        remember(home, id, view.title());
                        0
                    }
                });
            }
        }
    }
}

/// Follows task `id`'s topic until `done` holds for it (the session's columns with its body over them);
/// returns it then. No polling: it wakes on the stream's changes.
pub async fn until(c: &Client, id: &str, done: impl Fn(&Value) -> bool) -> Result<Value> {
    let (st, r) = (Style::plain(80), Renderers::builtin());
    let mut view = View::new(id);
    let mut conn = Conn::new(c, &[wisp_runtime_api::session_topic(id)]);
    let mut got = conn.start().await?;
    loop {
        for g in got.drain(..) {
            let _ = match g {
                Got::Snapshot(rows) => view.snapshot(rows, &st, &r),
                Got::Ops(ops) => view.ops(ops, &st, &r),
            };
        }
        if let Some(s) = view.session()
            && done(s)
        {
            return Ok(s.clone());
        }
        got = conn.next().await?;
    }
}

fn ls_line(st: &Style, v: &Value) -> String {
    let b = v.get("body").unwrap_or(v);
    let s = |k: &str| b.get(k).or_else(|| v.get(k)).and_then(Value::as_str).unwrap_or("").to_owned();
    term::truncate(&format!("{}  {:<9}  {:<8}  {}", s("id"), state_line(st, &s("state")), s("agent"), s("title")), st.width)
}

/// `wisp ls --watch`: the list, redrawn in a terminal as it changes; a line per change in a pipe.
pub async fn ls_watch(c: &Client, all: bool) -> Result<i32> {
    let st = crate::cli::style();
    let tty = std::io::stdout().is_terminal();
    let mut conn = Conn::new(c, &[wisp_runtime_api::TOPIC_LIST.to_owned()]);
    let mut rows: BTreeMap<String, Value> = BTreeMap::new();
    let mut got = conn.start().await?;
    loop {
        let mut changed: Vec<String> = Vec::new();
        for g in got.drain(..) {
            match g {
                Got::Snapshot(list) => {
                    rows.clear();
                    for r in list.into_iter().filter(|r| r.e == "session") {
                        changed.push(r.id.clone());
                        rows.insert(r.id, r.v);
                    }
                }
                Got::Ops(ops) => {
                    for op in ops.into_iter().filter(|o| o.e == "session") {
                        changed.push(op.id.clone());
                        match op.change {
                            wisp_protocol::Change::Upsert { v } => {
                                rows.insert(op.id, v);
                            }
                            wisp_protocol::Change::Del => {
                                rows.remove(&op.id);
                            }
                            wisp_protocol::Change::Patch { ops } => {
                                if let Some(v) = rows.get_mut(&op.id) {
                                    let _ = wisp_protocol::apply_patch(v, &ops);
                                }
                            }
                            wisp_protocol::Change::Append { .. } => {}
                        }
                    }
                }
            }
        }
        if !changed.is_empty() {
            let mut list: Vec<&Value> = rows.values().filter(|v| all || v.get("archived").and_then(Value::as_bool) != Some(true)).collect();
            list.sort_by_key(|v| std::cmp::Reverse(v.get("updated_at").and_then(Value::as_i64).unwrap_or(0)));
            if tty {
                let mut text = String::from("\x1b[H\x1b[2J");
                text.push_str(&term::bold(&st, "wisp ls --watch"));
                text.push_str(&term::dim(&st, "   Ctrl-C to stop\n\n"));
                for v in list.iter().take(40) {
                    text.push_str(&ls_line(&st, v));
                    text.push('\n');
                }
                if list.is_empty() {
                    text.push_str("No sessions.\n");
                }
                prompt(&text);
            } else {
                for id in changed {
                    if let Some(v) = rows.get(&id) {
                        out_line(&ls_line(&st, v));
                    }
                }
            }
        }
        tokio::select! {
            g = conn.next() => got = g?,
            _ = tokio::signal::ctrl_c() => return Ok(0),
        }
    }
}

/// `wisp events tail --follow`: new durable events as they come, from the `events:<glob>` topic (ADR-0044),
/// one line each (`--json`: one JSON object each).
pub async fn events_follow(c: &Client, topic: &str, subject: Option<&str>, json: bool) -> Result<i32> {
    let mut conn = Conn::new(c, &[topic.to_owned()]);
    let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut got = conn.start().await?;
    let mut first = true;
    loop {
        for g in got.drain(..) {
            let rows: Vec<(String, Value)> = match g {
                Got::Snapshot(list) => list.into_iter().filter(|r| r.e == "events_view").map(|r| (r.id, r.v)).collect(),
                Got::Ops(ops) => ops.into_iter().filter(|o| o.e == "events_view").filter_map(|o| match o.change {
                    wisp_protocol::Change::Upsert { v } => Some((o.id, v)),
                    _ => None,
                }).collect(),
            };
            for (id, v) in rows {
                // what's there already when it starts isn't news
                if first || !seen.insert(id) || subject.is_some_and(|s| v.get("subject").and_then(Value::as_str) != Some(s)) {
                    continue;
                }
                out_line(&crate::events_cli::line(&v, json));
            }
        }
        first = false;
        tokio::select! {
            g = conn.next() => got = g?,
            _ = tokio::signal::ctrl_c() => return Ok(0),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64() {
        assert_eq!(b64(b"Man"), "TWFu");
        assert_eq!(b64(b"Ma"), "TWE=");
        assert_eq!(b64(b"M"), "TQ==");
        assert_eq!(b64(b""), "");
    }
}
