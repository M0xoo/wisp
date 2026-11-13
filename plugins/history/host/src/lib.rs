//! wisp-history: a repo's agent history in `.wisp/` (ADR-0033, 0042). `history.track` / `save` /
//! `untrack` write a task's files (spec, report, transcript, and the harness's own session log) through
//! the repo's `history.store@1` (`files`, `notes`, `lfs`, or a plugin's); `history.blame` answers who
//! wrote what through `history.blame@1` (`git`); a task marked done is saved by itself (`track: auto`) or
//! offered (`ask`); resume requests from agents wait for the user's yes; and, opted in
//! (`history: { inject: true }`), a new task starts with the past tasks on the files its prompt names.
//!
//! resources: data-only (its one table holds resume requests; its settings are the repo's own `.wisp/wisp.yml`
//! `history:` section, read where they apply)

mod calls;
mod git;
mod stores;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::{Value, json};
use wisp_history_api::{self as api, BLAME, BlameSource, HistoryStore, STORE, Tracked};
use wisp_history_core::{Doc, repo};
use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_proc::Proc;
use wisp_runtime_api::model::{Session, SessionState};
use wisp_runtime_api::paths::Folder;

#[derive(Debug, Default)]
pub struct HistoryPlugin;

/// The repo a folder belongs to: the nearest folder up with `.wisp/`, else git's top, else the folder.
async fn root_of(proc: &Proc, cwd: &str) -> PathBuf {
    let start = Path::new(cwd);
    for d in start.ancestors() {
        if tokio::fs::metadata(d.join(".wisp")).await.is_ok_and(|m| m.is_dir()) {
            return d.to_owned();
        }
    }
    git::run(proc, "git", start, &["rev-parse", "--show-toplevel"]).await.map_or_else(|| start.to_owned(), |t| PathBuf::from(t.trim()))
}

/// The repo of a task's folder. A task with no folder (or a relative one) has no repo: never the server's own folder.
async fn root_of_task(proc: &Proc, task: &Session) -> Result<PathBuf> {
    let dir =
        Folder::of(&task.cwd).map_err(|e| WireError::invalid(format!("task {} has {e}, so no repo: name one (repo)", task.id.as_str())))?;
    Ok(root_of(proc, &dir.to_string()).await)
}

/// A repo named in a command's args: `""` or a relative path would be the server's own folder's `.wisp/`.
pub(crate) fn named_repo(repo: &str) -> Result<PathBuf> {
    Folder::of(repo).map(Folder::into_path).map_err(|e| WireError::invalid(format!("repo: {e} (name the repo's full path)")))
}

/// A `history:` setting of the repo (`.wisp/wisp.yml`).
async fn setting(root: &Path, key: &str, default: &str) -> String {
    let text = tokio::fs::read_to_string(root.join(".wisp/wisp.yml")).await.unwrap_or_default();
    repo::history_setting(&text, key, default)
}

fn store_for(ctx: &Ctx, id: &str) -> Result<Arc<dyn HistoryStore>> {
    let all = ctx.contributions(&STORE);
    all.iter()
        .find(|s| s.id() == id)
        .cloned()
        .ok_or_else(|| WireError::invalid(format!("no history store `{id}` (transcripts: files | notes | lfs, or a plugin's)")))
}

fn blame_for(ctx: &Ctx, id: &str) -> Result<Arc<dyn BlameSource>> {
    let all = ctx.contributions(&BLAME);
    all.iter()
        .find(|s| s.id() == id)
        .or_else(|| all.first())
        .cloned()
        .ok_or_else(|| WireError::unavailable("no blame source (history.blame@1)"))
}

fn proc(ctx: &Ctx) -> Result<Arc<Proc>> {
    ctx.service::<Proc>()
}

/// Every task file under `root/.wisp/tasks`, read.
pub async fn docs(root: &Path) -> Vec<Doc> {
    let mut out = Vec::new();
    let mut stack = vec![root.join(".wisp/tasks")];
    while let Some(d) = stack.pop() {
        let Ok(mut rd) = tokio::fs::read_dir(&d).await else { continue };
        while let Ok(Some(e)) = rd.next_entry().await {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.to_string_lossy().ends_with(".task.yml")
                && let Ok(text) = tokio::fs::read_to_string(&p).await
                && let Ok(doc) = serde_saphyr::from_str::<Value>(&text)
            {
                out.push(Doc { path: p.strip_prefix(root).map_or_else(|_| p.display().to_string(), |r| r.display().to_string()), doc });
            }
        }
    }
    out
}

/// Every path under `.wisp/` (relative to it).
async fn listing(root: &Path) -> Vec<String> {
    let base = root.join(".wisp");
    let mut out = Vec::new();
    let mut stack = vec![base.clone()];
    while let Some(d) = stack.pop() {
        let Ok(mut rd) = tokio::fs::read_dir(&d).await else { continue };
        while let Ok(Some(e)) = rd.next_entry().await {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(r) = p.strip_prefix(&base) {
                out.push(r.display().to_string());
            }
        }
    }
    out
}

/// A task written into its repo's history: the bundle at `level`, its commits and PR, through its store.
async fn track(ctx: &Ctx, call: &Call, a: &api::TrackArgs) -> Result<Tracked> {
    let task = calls::task(ctx, call, &a.id).await?;
    let id = task.id.as_str().to_owned();
    let p = proc(ctx)?;
    let root = match &a.repo {
        Some(r) => named_repo(r)?,
        None => root_of_task(&p, &task).await?,
    };
    let preview = calls::preview(ctx, call, &id, a.level.as_deref().unwrap_or("full")).await?;
    let mut b = preview.bundle;
    id.clone_into(&mut b.id);
    let blame = blame_for(ctx, &setting(&root, "blame", "git").await)?;
    let commits = blame.grep(root.clone(), format!("{} {}", repo::TRAILER, repo::short(&id))).await;
    let branch = task.ext_of("wisp.worktrees").get("branch").and_then(Value::as_str).unwrap_or_default();
    let pr = git::pr_of(&p, &root, &commits, branch).await;
    let store = store_for(ctx, &setting(&root, "transcripts", "files").await)?;
    // tracked again: what it wrote before goes first (one file each, never two)
    let before = wisp_history_core::files_of(&listing(&root).await, &id);
    calls::warn("removing the files it wrote before", store.remove(root.clone(), before).await);
    let me = git::run(&p, "git", &root, &["config", "user.name"]).await.unwrap_or_default();
    let session = task.resume_id.as_deref().filter(|s| !s.is_empty()).map(|sid| (task.agent.clone(), sid.to_owned()));
    let mut files = repo::files_with(&b, &commits, pr.as_deref(), me.trim(), session.as_ref().map(|(h, s)| (h.as_str(), s.as_str())));
    if let Some(native) = native_log(ctx, &task).await {
        files.push((format!("history/{id}.native.jsonl.zst"), native));
    }
    let written = store.write(root.clone(), files).await?;
    let scrubbed = u32::try_from(preview.redactions.len()).unwrap_or(u32::MAX);
    let out = Tracked { repo: root.display().to_string(), store: store.id().to_owned(), files: written, pr, commits, scrubbed };
    calls::set_ext(ctx, call, &id, json!({ "tracked": { "repo": out.repo, "files": out.files, "store": out.store }, "offer": false }))
        .await;
    Ok(out)
}

/// The harness's own session log of a task (Claude Code's `.jsonl`), compressed, so `wisp open` on another
/// computer can resume it there. None when the harness keeps none or it isn't on this computer.
async fn native_log(ctx: &Ctx, task: &Session) -> Option<Vec<u8>> {
    let sid = task.resume_id.as_deref().filter(|s| !s.is_empty())?;
    let h = ctx.contributions(&wisp_runtime_api::harness::sessions::SESSIONS).into_iter().find(|h| h.harness() == task.agent)?;
    let raw = h.raw(sid).await?;
    Some(repo::compress(&raw))
}

async fn untrack(ctx: &Ctx, call: &Call, a: &api::UntrackArgs) -> Result<api::Gone> {
    let p = proc(ctx)?;
    let root = if let Some(r) = &a.repo {
        named_repo(r)?
    } else {
        // a task that can't be read has no repo here: never the server's own folder
        let task = calls::task(ctx, call, &a.id)
            .await
            .map_err(|e| WireError::not_found(format!("{} isn't a task here ({}): name its repo", a.id, e.message)))?;
        root_of_task(&p, &task).await?
    };
    let all = docs(&root).await;
    let id = wisp_history_core::find(&all, &a.id).map_or_else(|| a.id.clone(), |d| d.id().to_owned());
    let mine = wisp_history_core::files_of(&listing(&root).await, &id);
    let mut go: Vec<String> = mine.iter().filter(|f| f.starts_with("history/")).cloned().collect();
    if a.keep.as_deref() != Some("report") {
        go.extend(mine.iter().filter(|f| f.ends_with(".report.md")).cloned());
    }
    if a.keep.is_none() {
        go.extend(mine.iter().filter(|f| f.ends_with(".task.yml")).cloned());
    }
    // a transcript kept as a note isn't in the listing
    go.push(format!("history/{id}.jsonl.zst"));
    go.push(format!("history/{id}.native.jsonl.zst"));
    go.sort();
    go.dedup();
    let store = store_for(ctx, &setting(&root, "transcripts", "files").await)?;
    let files = store.remove(root, go).await?;
    if files.is_empty() {
        return Err(WireError::not_found(format!("{} isn't tracked here", a.id)));
    }
    Ok(api::Gone { files })
}

mod blame;
mod requests;

/// A task marked done in a repo that keeps its history: `auto` saves it, `ask` offers it (a notice and
/// `ext["wisp.history"].offer`), `manual` does nothing. Once per turn count.
async fn on_done(ctx: &Ctx, id: &str) {
    let call = ctx.root_call();
    // a task that went away between the event and now: nothing to save
    let Ok(task) = calls::task(ctx, &call, id).await else { return };
    if task.state != SessionState::Done || task.parent_id.is_some() {
        return;
    }
    let Ok(p) = proc(ctx) else { return };
    let Ok(root) = root_of_task(&p, &task).await else { return };
    if tokio::fs::metadata(root.join(".wisp/wisp.yml")).await.is_err() {
        return;
    }
    let turns = calls::turn_count(ctx, &call, id).await;
    let seen = task.ext_of(api::EXT).get("seenTurns").and_then(Value::as_u64);
    if seen == Some(turns as u64) {
        return;
    }
    let mark = |extra: Value| {
        let mut v = Some(task.ext_of(api::EXT).clone()).filter(Value::is_object).unwrap_or_else(|| json!({}));
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
            o.insert("seenTurns".into(), json!(turns));
        }
        v
    };
    match setting(&root, "track", "ask").await.as_str() {
        "auto" => {
            if let Err(e) =
                track(ctx, &call, &api::TrackArgs { id: id.to_owned(), level: None, repo: Some(root.display().to_string()) }).await
            {
                tracing::warn!(task = id, "history: not saved: {}", e.message);
            }
            // what track just wrote, plus the turn count: a refused read would drop `tracked`, so it's skipped
            match calls::task(ctx, &call, id).await {
                Ok(after) => {
                    let mut v = Some(after.ext_of(api::EXT).clone()).filter(Value::is_object).unwrap_or_else(|| json!({}));
                    v["seenTurns"] = json!(turns);
                    calls::set_ext(ctx, &call, id, v).await;
                }
                Err(e) => tracing::warn!(task = id, "history: runtime.get: {}", e.message),
            }
        }
        "ask" => {
            calls::set_ext(ctx, &call, id, mark(json!({ "offer": true, "repo": root.display().to_string() }))).await;
            if let Ok(n) = wisp_kernel::services::notify(ctx) {
                n.notice(
                    "history.offer",
                    json!({ "task": id, "title": task.title, "repo": root.display().to_string(), "text": "Save it to the repo?" }),
                    None,
                );
            }
        }
        _ => {}
    }
}

/// What the injection knows: each repo's tasks and whether it opted in, read before a run.
#[derive(Default)]
struct Known(Mutex<HashMap<String, (bool, Vec<Doc>)>>);

struct Inject(Arc<Known>, Arc<Mutex<HashMap<String, String>>>);

impl wisp_runtime_api::points::PromptPart for Inject {
    fn id(&self) -> &'static str {
        "wisp.history"
    }
    fn part(&self, s: &wisp_runtime_api::model::Session) -> String {
        let Some(root) = self.1.lock().unwrap_or_else(PoisonError::into_inner).get(s.id.as_str()).cloned() else { return String::new() };
        let known = self.0.0.lock().unwrap_or_else(PoisonError::into_inner);
        let Some((true, all)) = known.get(&root) else { return String::new() };
        let prompt = s.ext.get("wisp.runtime").and_then(|o| o.pointer("/spec/prompt")).and_then(Value::as_str).unwrap_or(&s.title);
        wisp_history_core::inject_text(&wisp_history_core::relevant(all, prompt, 5))
    }
}

fn hooks(s: &mut Setup) {
    let (known, roots) = (Arc::new(Known::default()), Arc::new(Mutex::new(HashMap::new())));
    let part: Arc<dyn wisp_runtime_api::points::PromptPart> = Arc::new(Inject(known.clone(), roots.clone()));
    s.contribute(&wisp_runtime_api::points::PROMPT, part);
    s.intercept::<wisp_runtime_api::hooks::BeforeRun, _, _>(
        wisp_kernel::InterceptOpts { priority: 70, failure: wisp_kernel::Failure::Open, timeout_ms: 2000 },
        move |ctx, _call, c| {
            let (known, roots) = (known.clone(), roots.clone());
            async move {
                // a run with no folder has no repo (never the server's own folder)
                if let Ok(p) = proc(&ctx)
                    && Folder::of(&c.cwd).is_ok()
                {
                    let root = root_of(&p, &c.cwd).await;
                    let on = setting(&root, "inject", "false").await == "true";
                    let all = if on { docs(&root).await } else { Vec::new() };
                    let key = root.display().to_string();
                    known.0.lock().unwrap_or_else(PoisonError::into_inner).insert(key.clone(), (on, all));
                    roots.lock().unwrap_or_else(PoisonError::into_inner).insert(c.session_id.as_str().to_owned(), key);
                }
                wisp_kernel::Verdict::Continue
            }
        },
    );
    s.on::<wisp_runtime_api::events::SessionChanged, _, _>(|ctx, e| {
        let (c, id) = (ctx.clone(), e.id.as_str().to_owned());
        ctx.spawn(async move { on_done(&c, &id).await });
        async {}
    });
}

impl Plugin for HistoryPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.contribute(&STORE, Arc::new(stores::Files) as Arc<dyn HistoryStore>);
        s.contribute(&STORE, Arc::new(stores::Lfs) as Arc<dyn HistoryStore>);
        let ctx = s.ctx();
        let lazy = Arc::new(stores::LazyNotes(ctx.clone()));
        s.contribute(&STORE, lazy as Arc<dyn HistoryStore>);
        s.contribute(&BLAME, Arc::new(git::LazyGit(ctx)) as Arc<dyn BlameSource>);
        s.command::<api::Track, _, _>(|ctx, call, a| async move { track(&ctx, &call, &a).await });
        s.command::<api::Save, _, _>(|ctx, call, a| async move { track(&ctx, &call, &a).await });
        s.command::<api::Untrack, _, _>(|ctx, call, a| async move { untrack(&ctx, &call, &a).await });
        s.command::<api::BlameCmd, _, _>(|ctx, _call, a| async move { blame::answer(&ctx, &a).await });
        // the Repo tab (ADR-0033): the repo's committed agent history, and one task's read-only report
        s.command::<api::List, _, _>(|_ctx, _call, a| async move {
            let all = docs(&named_repo(&a.repo)?).await;
            Ok(wisp_history_core::repo_list(&all, a.path.as_deref(), a.agent.as_deref(), a.grep.as_deref()))
        });
        s.command::<api::Report, _, _>(|_ctx, _call, a| async move {
            let root = named_repo(&a.repo)?;
            let all = docs(&root).await;
            let d = wisp_history_core::find(&all, &a.id)
                .ok_or_else(|| WireError::not_found(format!("no task {} in this repo's history", a.id)))?;
            let report = tokio::fs::read_to_string(root.join(d.path.replace(".task.yml", ".report.md"))).await.unwrap_or_default();
            let prompt = d.doc.pointer("/spec/prompt").and_then(Value::as_str).unwrap_or_default().to_owned();
            Ok(api::RepoReport { task: wisp_history_core::repo_task(d), prompt, report })
        });
        requests::register(s);
        hooks(s);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
