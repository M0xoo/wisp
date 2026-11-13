//! GitHub comments, the channels transport (v1 channels/github.js): wisp polls each repo a project on this computer
//! has as its origin (nothing has to reach this machine); a comment whose first line is `/wisp …`, written by you,
//! starts a task or follows one up, and the answer comes back as a comment posted by `gh` as you. Off by default.
//! Anyone else is met with silence, a message can't ask for more than Edits, a tool approval stays in wisp, and on a
//! public repo a report is a fixed line of wisp's own words (`publicReports` lifts that). The decisions are
//! `wisp_github_core::comments`'; `gh` and `git` go through the hub's `Exec` (the proc service).
//!
//! Not here yet: a PR with no task of its own following the task on its branch.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex, PoisonError, Weak};

use async_trait::async_trait;
use serde_json::{Value, json};
use wisp_channels_api::conversation::{Conversation, failed_line, first_part};
use wisp_channels_api::hub::Later;
use wisp_channels_api::policy::{Gate, GateArgs, RateLimit, gate};
use wisp_channels_api::scrub::{defuse, no_media, scrub_out};
use wisp_channels_api::views::{ActionKind, Msg, SessionView};
use wisp_channels_api::{ChannelCtx, ChannelHub, Mode, Parsed, Phone, ProjectView, Status, Thread, Transport, TransportDef, TransportKind};
use wisp_github_core::comments::{self as gc, Comment, Cursor};
use wisp_kernel::{CancellationToken, Result, WireError};

pub const NAME: &str = "github";
const POLL_MS: u64 = 60_000;
const MAX_REPOS: usize = 20;
const PRIVATE_FRESH_MS: i64 = 10 * 60_000;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) struct Def;
impl TransportDef for Def {
    fn name(&self) -> &'static str {
        NAME
    }
    fn create(&self, hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
        Arc::new_cyclic(|this| Gh { this: this.clone(), hub, limit: Mutex::default(), me: Mutex::default(), private: Mutex::default() })
    }
}

/// The transport on `hub` (tests drive it on the api's test hub).
pub fn transport(hub: Arc<dyn ChannelHub>) -> Arc<dyn Transport> {
    Def.create(hub)
}

pub(crate) struct Gh {
    this: Weak<Gh>,
    hub: Arc<dyn ChannelHub>,
    limit: Mutex<RateLimit>,
    /// who may speak, by id: (id, login)
    me: Mutex<Option<(String, String)>>,
    /// repo → (private, when it was asked); not knowing counts as public
    private: Mutex<BTreeMap<String, (bool, i64)>>,
}

impl Gh {
    fn cfg(&self) -> Value {
        self.hub.cfg(NAME)
    }
    fn mark(&self, error: Option<String>) {
        self.hub.mark(NAME, Status { ok: Some(error.is_none()), error, at: Some(self.hub.now_ms()), ..Status::default() });
    }

    async fn gh(&self, args: &[&str]) -> std::result::Result<String, String> {
        let args: Vec<String> = args.iter().map(|a| (*a).to_owned()).collect();
        let out = self.hub.exec().run("gh", &args, None, 30_000).await.map_err(|e| e.message)?;
        if out.code == 0 {
            Ok(out.stdout)
        } else {
            Err(if out.stderr.trim().is_empty() { out.stdout } else { out.stderr }.trim().to_owned())
        }
    }

    async fn whoami(&self) -> std::result::Result<String, String> {
        if let Some((id, _)) = lock(&self.me).clone() {
            return Ok(id);
        }
        let u: Value =
            serde_json::from_str(&self.gh(&["api", "user"]).await?).map_err(|_| "gh api user said something unreadable".to_owned())?;
        let id = u["id"].as_u64().map(|n| n.to_string()).ok_or("gh api user gave no id")?;
        *lock(&self.me) = Some((id.clone(), u["login"].as_str().unwrap_or_default().to_owned()));
        Ok(id)
    }

    /// The repos of this computer's projects, most recently used first.
    async fn repos(&self) -> Vec<(String, ProjectView)> {
        let mut here: Vec<ProjectView> =
            self.hub.phone().projects().await.unwrap_or_default().into_iter().filter(|p| p.machine.is_none()).collect();
        here.sort_by_key(|p| std::cmp::Reverse(p.last_used_at.or(p.added_at).unwrap_or(0)));
        let mut out: Vec<(String, ProjectView)> = Vec::new();
        for p in here {
            if out.len() >= MAX_REPOS {
                break;
            }
            // `git -C ""` runs in the server's own folder (and starts every task there): a project with no folder is skipped
            if let Err(e) = wisp_runtime_api::paths::Folder::of(&p.path) {
                tracing::warn!(project = %p.name, "github: project skipped: {e}");
                continue;
            }
            let origin = match p.repo.clone() {
                Some(r) => r,
                None => self
                    .hub
                    .exec()
                    .run("git", &["-C".into(), p.path.clone(), "remote".into(), "get-url".into(), "origin".into()], None, 5_000)
                    .await
                    .map(|o| o.stdout)
                    .unwrap_or_default(),
            };
            if let Some(r) = gc::parse_repo(&origin).filter(|r| !out.iter().any(|(x, _)| x == r)) {
                out.push((r, p));
            }
        }
        out
    }

    async fn is_private(&self, repo: &str) -> bool {
        let now = self.hub.now_ms();
        if let Some((p, at)) = lock(&self.private).get(repo).copied().filter(|(_, at)| now - at < PRIVATE_FRESH_MS) {
            let _ = at;
            return p;
        }
        let p = self
            .gh(&["api", &format!("repos/{repo}")])
            .await
            .ok()
            .and_then(|o| serde_json::from_str::<Value>(&o).ok())
            .is_some_and(|v| v["private"] == true);
        lock(&self.private).insert(repo.to_owned(), (p, now));
        p
    }

    /// Reports there may say what an agent wrote: a private repo, or public reports switched on.
    async fn open(&self, repo: &str) -> bool {
        self.is_private(repo).await || self.cfg()["publicReports"] == true
    }

    pub(crate) async fn post(&self, repo: &str, number: u64, text: &str) -> Result<()> {
        let clean = defuse(&no_media(&scrub_out(text, true).text));
        let body = format!("body={}", gc::body_out(&clean));
        self.gh(&["api", &format!("repos/{repo}/issues/{number}/comments"), "-f", &body])
            .await
            .map(drop)
            .map_err(|e| WireError::unavailable(format!("GitHub: {e}")))
    }

    fn cursor(&self, repo: &str) -> Option<Cursor> {
        serde_json::from_value(self.cfg()["repos"][repo].clone()).ok()
    }
    fn set_cursor(&self, repo: &str, c: &Cursor) {
        let mut cfg = self.cfg();
        if !cfg["repos"].is_object() {
            cfg["repos"] = json!({});
        }
        cfg["repos"][repo] = json!(c);
        self.hub.set_cfg(NAME, cfg);
    }

    /// One look at a repo: how long until the next.
    async fn poll(self: &Arc<Self>, repo: &str, project: &ProjectView, me: &str, fails: &mut BTreeMap<String, u32>) -> u64 {
        let poll_ms = self.hub.tune("ghPollMs").unwrap_or(POLL_MS);
        let Some(mut cur) = self.cursor(repo) else {
            // what was said before wisp looked isn't for it
            self.set_cursor(repo, &Cursor { since: gc::s_iso(self.hub.now_ms() / 1000), seen: Vec::new() });
            return poll_ms;
        };
        let path = format!("repos/{repo}/issues/comments?since={}&sort=updated&direction=asc&per_page=100", cur.since.replace(':', "%3A"));
        let out = match self.gh(&["api", "--include", &path]).await {
            Ok(o) => o,
            Err(e) => {
                if matches!(gc::http_status(&e), Some(403 | 429)) {
                    let n = fails.entry(repo.to_owned()).or_default();
                    *n += 1;
                    let ms = gc::backoff_ms(*n, poll_ms, 0);
                    self.mark(Some(format!("{repo}: GitHub asked wisp to slow down. Looking again in {}s.", ms.div_ceil(1000))));
                    return ms;
                }
                self.mark(Some(format!("{repo}: {e}")));
                return poll_ms;
            }
        };
        fails.remove(repo);
        let (head, body) = gc::split_include(&out);
        let Ok(list) = serde_json::from_str::<Vec<Value>>(body) else {
            self.mark(Some(format!("{repo}: GitHub sent something unreadable")));
            return poll_ms;
        };
        let floor = gc::iso_s(&cur.since).unwrap_or(0);
        for c in &list {
            let cm = gc::comment(c, me);
            if gc::iso_s(&cm.updated_at).unwrap_or(0) > gc::iso_s(&cur.since).unwrap_or(0) {
                cur.since.clone_from(&cm.updated_at);
            }
            if cm.created_s < floor {
                continue;
            }
            if let Err(e) = self.comment(repo, project, &mut cur, &cm).await {
                self.mark(Some(format!("{repo}: {}", e.message)));
            }
        }
        self.set_cursor(repo, &cur);
        self.mark(None);
        match gc::header(head, "retry-after").and_then(|r| r.parse::<u64>().ok()) {
            Some(s) => gc::backoff_ms(1, poll_ms, s),
            None => poll_ms,
        }
    }

    /// A PR with no task of its own: the task on its head branch in this project (`gh pr view --json headRefName`).
    async fn branch_task(&self, repo: &str, number: u64, project: &ProjectView) -> Option<String> {
        let args: Vec<String> = ["pr", "view", &number.to_string(), "--repo", repo, "--json", "headRefName"].map(str::to_owned).to_vec();
        let out = self.hub.exec().run("gh", &args, None, 30_000).await.ok()?;
        let head = serde_json::from_str::<Value>(&out.stdout).ok()?.get("headRefName")?.as_str()?.to_owned();
        let phone = self.hub.phone();
        let root = project.path.trim_end_matches('/');
        // "" is a prefix of every folder: a project with none follows no task
        wisp_runtime_api::paths::Folder::of(&project.path).ok()?;
        let mut leads: Vec<_> = phone
            .sessions()
            .await
            .ok()?
            .into_iter()
            .filter(|s| s.parent_id.is_none() && s.cwd.as_deref().is_some_and(|c| c.starts_with(root)))
            .collect();
        leads.sort_by_key(|s| std::cmp::Reverse(s.created_at.unwrap_or(0)));
        // the list rows have no branch: read the newest few in full
        let mut full = Vec::new();
        for s in leads.into_iter().take(20) {
            if let Ok(Some(v)) = phone.session(&s.id).await {
                full.push(v);
            }
        }
        gc::follows_branch(
            full.iter().map(|s| {
                (
                    s.id.as_str(),
                    s.parent_id.is_some(),
                    s.delegated,
                    s.cwd.as_deref().unwrap_or_default(),
                    s.branch.as_deref(),
                    s.created_at.unwrap_or(0),
                )
            }),
            &head,
            &project.path,
        )
    }

    async fn comment(self: &Arc<Self>, repo: &str, project: &ProjectView, cur: &mut Cursor, c: &Comment) -> Result<()> {
        let Some(cmd) = c.command.clone() else {
            // remembered too: a comment from the cursor's own second, edited into /wisp later, isn't older
            if c.mine {
                cur.first(&c.id);
            }
            return Ok(());
        };
        let me = lock(&self.me).clone().map(|(id, _)| id).unwrap_or_default();
        let seen_first = cur.first(&c.id);
        let g = if seen_first {
            let mut limit = lock(&self.limit);
            gate(GateArgs {
                sender: c.mine.then_some(c.user_id.as_str()),
                senders: std::slice::from_ref(&me),
                at_s: Some(c.created_s),
                limit: Some(&mut limit),
                now_ms: self.hub.now_ms(),
                ..GateArgs::default()
            })
        } else {
            return Ok(()); // the cursor's own second comes back on every look
        };
        self.set_cursor(repo, cur); // before anything runs: a crash now loses a task, it can't run one twice
        let Some(number) = c.number else { return Ok(()) };
        if let Gate::Refused { reply, why } = g {
            self.hub.phone().count("refused", Some(&format!("{why:?}").to_lowercase()));
            if let Some(r) = reply {
                self.post(repo, number, &r).await?;
            }
            return Ok(());
        }
        let open = self.open(repo).await;
        let phone = self.hub.phone();
        let mut ctx = phone.context().await?;
        // its project first: a comment on a repo runs there unless it says otherwise
        ctx.projects.sort_by_key(|p| p.id != project.id);
        let text = wisp_channels_api::markup::strip_formatting(
            &if cmd.to_lowercase().starts_with("new ") || cmd.eq_ignore_ascii_case("new") {
                format!("/{cmd}")
            } else if cmd.is_empty() {
                "help".into()
            } else {
                cmd
            },
            wisp_channels_api::markup::Markup::Plain,
            "",
        );
        let key = format!("{repo}#{number}");
        let mut session = self.hub.find_remote(&|r, _| r.get("gh").and_then(Value::as_str) == Some(key.as_str())).into_iter().next();
        if session.is_none() && c.pr {
            session = self.branch_task(repo, number, project).await;
        }
        let conv = GhConv {
            gh: self.clone(),
            phone,
            ctx,
            repo: repo.to_owned(),
            number,
            key,
            login: c.login.clone(),
            sender: c.user_id.clone(),
            about: gc::about(repo, number, c.pr),
            open,
        };
        self.hub.converse(&conv, &text, session.as_deref(), None).await.map(drop)
    }
}

/// A `/wisp` comment through wisp.channels' flow.
struct GhConv {
    gh: Arc<Gh>,
    phone: Arc<dyn Phone>,
    ctx: ChannelCtx,
    repo: String,
    number: u64,
    key: String,
    login: String,
    sender: String,
    about: String,
    /// reports may say what an agent wrote (a private repo, or public reports on)
    open: bool,
}

#[async_trait]
impl Conversation for GhConv {
    fn phone(&self) -> &dyn Phone {
        self.phone.as_ref()
    }
    fn ctx(&self) -> &ChannelCtx {
        &self.ctx
    }
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn channel(&self) -> &str {
        NAME
    }
    fn name(&self) -> &str {
        &self.login
    }
    fn sender(&self) -> &str {
        &self.sender
    }
    fn cap(&self) -> Mode {
        Mode::Edits
    }
    fn fallback(&self) -> Option<Mode> {
        Some(Mode::Plan)
    }
    fn about(&self) -> Option<&str> {
        Some(&self.about)
    }
    fn approvals(&self) -> bool {
        false
    }
    #[allow(clippy::unnecessary_literal_bound)] // the trait's signature
    fn no_thread(&self) -> &str {
        "There’s no task on this one yet."
    }
    async fn say(&self, text: String) -> Result<Value> {
        self.gh.post(&self.repo, self.number, &text).await.map(|()| json!({}))
    }
    /// a public repo shows none of your names
    async fn list(&self, _p: &Parsed, text: String) -> Result<Value> {
        self.say(if self.open { text } else { gc::NO_LIST.to_owned() }).await
    }
    async fn thread(&self, _p: &Parsed) -> Option<Thread> {
        let mut more = BTreeMap::new();
        more.insert("repo".into(), json!(self.repo));
        more.insert("number".into(), json!(self.number));
        Some(Thread { channel: NAME.into(), reference: Some(self.key.clone()), session: None, more })
    }
    /// the task keeps its issue, so its report and the next `/wisp` there reach it
    fn acked(&self, thread: Option<&Thread>, _sent: &Value) {
        if let Some(s) = thread.and_then(|t| t.session.as_deref()) {
            let mut r = self.gh.hub.remote_of(s).unwrap_or_default();
            r.insert("gh".into(), json!(self.key));
            self.gh.hub.set_remote(s, r);
            self.gh.hub.mark_started(s, NAME, None);
        }
    }
    fn quiet(&self, line: String) -> String {
        if self.open { line } else { first_part(&line) }
    }
    fn run_line(&self, line: String) -> String {
        if self.open { line } else { first_part(&line) }
    }
    fn later(&self) -> Option<Later> {
        let (gh, repo, number, open) = (self.gh.clone(), self.repo.clone(), self.number, self.open);
        Some(Arc::new(move |t: String| {
            let (gh2, repo2) = (gh.clone(), repo.clone());
            let line = if open { t } else { "The answer is on the task in wisp.".to_owned() };
            gh.hub.spawn(Box::pin(async move {
                let _ = gh2.post(&repo2, number, &line).await;
            }));
        }))
    }
    /// a task from wisp, followed up here: this turn's report comes back, and nothing after it
    fn before_run(&self, session_id: &str) -> Option<Box<dyn FnOnce() + Send>> {
        if self.gh.hub.started_from(session_id).is_some_and(|(c, _)| c == NAME) {
            return None;
        }
        let mut r = self.gh.hub.remote_of(session_id).unwrap_or_default();
        r.insert("ghOnce".into(), json!(self.key));
        self.gh.hub.set_remote(session_id, r);
        let (hub, sid) = (self.gh.hub.clone(), session_id.to_owned());
        Some(Box::new(move || {
            if let Some(mut r) = hub.remote_of(&sid) {
                r.remove("ghOnce");
                hub.set_remote(&sid, r);
            }
        }))
    }
    fn failed(&self, what: &str, err: &WireError) -> String {
        if self.open {
            failed_line(what, err)
        } else if what == "start it" {
            "Couldn’t start it. wisp can say why if you start it there.".into()
        } else {
            format!("Couldn’t {what}.")
        }
    }
}

#[async_trait]
impl Transport for Gh {
    fn name(&self) -> &str {
        NAME
    }
    fn ready(&self) -> bool {
        self.cfg()["enabled"] == true
    }
    fn kind(&self) -> TransportKind {
        TransportKind::Thread
    }

    async fn start(&self, stop: CancellationToken) {
        if !self.ready() {
            return;
        }
        let Some(me) = self.this.upgrade() else { return };
        let (mut next, mut fails): (BTreeMap<String, i64>, BTreeMap<String, u32>) = (BTreeMap::new(), BTreeMap::new());
        let poll_ms = self.hub.tune("ghPollMs").unwrap_or(POLL_MS);
        while !stop.is_cancelled() {
            let mut wake = poll_ms;
            match me.whoami().await {
                Err(e) => self.mark(Some(format!("GitHub: {e}"))),
                Ok(id) => {
                    for (repo, project) in me.repos().await {
                        if stop.is_cancelled() {
                            return;
                        }
                        let now = self.hub.now_ms();
                        if next.get(&repo).is_none_or(|at| *at <= now) {
                            let ms = me.poll(&repo, &project, &id, &mut fails).await;
                            next.insert(repo.clone(), self.hub.now_ms() + i64::try_from(ms).unwrap_or(i64::MAX / 4));
                        }
                        let left = next.get(&repo).map_or(0, |at| *at - self.hub.now_ms());
                        wake = wake.min(u64::try_from(left).unwrap_or(0));
                    }
                }
            }
            tokio::select! {
                () = stop.cancelled() => return,
                () = self.hub.sleep(wake.max(10)) => {}
            }
        }
    }

    fn reports(&self, s: Option<&SessionView>) -> bool {
        s.is_some_and(|s| {
            self.hub.started_from(&s.id).is_some_and(|(c, _)| c == NAME)
                || self.hub.remote_of(&s.id).is_some_and(|r| r.contains_key("ghOnce"))
        })
    }

    /// Only for a task started here, or one turn of one followed up here.
    async fn publish(&self, msg: &Msg, sv: Option<&SessionView>) -> Result<()> {
        let Some(sv) = sv else { return Ok(()) };
        let mut r = self.hub.remote_of(&sv.id).unwrap_or_default();
        let asks = sv.state == "waiting" || sv.ask.is_some();
        // an ask leaves the turn open: its answer's report is still to come
        let once = if asks { r.get("ghOnce").cloned() } else { r.remove("ghOnce") };
        if once.is_some() && !asks {
            self.hub.set_remote(&sv.id, r.clone());
        }
        let Some(key) = r.get("gh").or(once.as_ref()).and_then(Value::as_str).map(str::to_owned) else { return Ok(()) };
        let Some((repo, number)) = key.rsplit_once('#').and_then(|(r, n)| Some((r.to_owned(), n.parse::<u64>().ok()?))) else {
            return Ok(());
        };
        let open = self.open(&repo).await;
        let failed = sv.state == "error";
        let by = self.hub.started_from(&sv.id).and_then(|(_, by)| by);
        let choices: Vec<&str> = msg.actions.iter().filter(|a| a.kind != ActionKind::Done).map(|a| a.label.as_str()).collect();
        let text = if open { gc::report(&msg.title, &msg.text, &choices, by.as_deref()) } else { gc::fixed_line(asks, failed).to_owned() };
        self.post(&repo, number, &text).await?;
        self.hub.phone().count("report", Some(if open { "full" } else { "fixed" }));
        Ok(())
    }
}
