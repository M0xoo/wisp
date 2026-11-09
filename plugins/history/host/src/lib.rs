//! wisp-history: a repo's agent history in `.wisp/` (ADR-0033, 0042). `history.track` / `save` /
//! `untrack` write a task's files (spec, report, transcript, and the harness's own session log) through
//! the repo's `history.store@1` (`files`, `notes`, `lfs`, or a plugin's); `history.blame` answers who
//! wrote what through `history.blame@1` (`git`); a task marked done is saved by itself (`track: auto`) or
//! offered (`ask`); resume requests from agents wait for the user's yes; and, opted in
//! (`history: { inject: true }`), a new task starts with the past tasks on the files its prompt names.
//!
//! resources: data-only (its one table holds resume requests; its settings are the repo's own `.wisp/wisp.yml`
//! `history:` section, read where they apply)

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
use wisp_share_api::Bundle;

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

/// A `history:` setting of the repo (`.wisp/wisp.yml`).
async fn setting(root: &Path, key: &str, default: &str) -> String {
    let text = tokio::fs::read_to_string(root.join(".wisp/wisp.yml")).await.unwrap_or_default();
    repo::history_setting(&text, key, default)
}

fn store_for(ctx: &Ctx, id: &str) -> Result<Arc<dyn HistoryStore>> {
    let all = ctx.contributions(&STORE);
    all.iter().find(|s| s.id() == id).cloned().ok_or_else(|| WireError::invalid(format!("no history store `{id}` (transcripts: files | notes | lfs, or a plugin's)")))
}

fn blame_for(ctx: &Ctx, id: &str) -> Result<Arc<dyn BlameSource>> {
    let all = ctx.contributions(&BLAME);
    all.iter().find(|s| s.id() == id).or_else(|| all.first()).cloned().ok_or_else(|| WireError::unavailable("no blame source (history.blame@1)"))
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
    let task = ctx.run_json(call, "runtime.get", json!({ "id": a.id })).await?;
    let id = task.get("id").and_then(Value::as_str).unwrap_or(&a.id).to_owned();
    let p = proc(ctx)?;
    let root = match &a.repo {
        Some(r) => PathBuf::from(r),
        None => root_of(&p, task.get("cwd").and_then(Value::as_str).unwrap_or_default()).await,
    };
    let level = a.level.clone().unwrap_or_else(|| "full".into());
    let preview = ctx.run_json(call, "share.preview", json!({ "id": id, "level": level })).await?;
    let mut b: Bundle = serde_json::from_value(preview["bundle"].clone()).map_err(|e| WireError::internal(e.to_string()))?;
    id.clone_into(&mut b.id);
    let blame = blame_for(ctx, &setting(&root, "blame", "git").await)?;
    let commits = blame.grep(root.clone(), format!("{} {}", repo::TRAILER, repo::short(&id))).await;
    let branch = task.pointer("/ext/wisp.worktrees/branch").and_then(Value::as_str).unwrap_or_default();
    let pr = git::pr_of(&p, &root, &commits, branch).await;
    let store = store_for(ctx, &setting(&root, "transcripts", "files").await)?;
    // tracked again: what it wrote before goes first (one file each, never two)
    let before = wisp_history_core::files_of(&listing(&root).await, &id);
    let _ = store.remove(root.clone(), before).await;
    let me = git::run(&p, "git", &root, &["config", "user.name"]).await.unwrap_or_default();
    let session = task.get("resumeId").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|sid| (task.get("agent").and_then(Value::as_str).unwrap_or_default().to_owned(), sid.to_owned()));
    let mut files = repo::files_with(&b, &commits, pr.as_deref(), me.trim(), session.as_ref().map(|(h, s)| (h.as_str(), s.as_str())));
    if let Some(native) = native_log(ctx, &task).await {
        files.push((format!("history/{id}.native.jsonl.zst"), native));
    }
    let written = store.write(root.clone(), files).await?;
    let scrubbed = preview["redactions"].as_array().map_or(0, |r| u32::try_from(r.len()).unwrap_or(u32::MAX));
    let out = Tracked { repo: root.display().to_string(), store: store.id().to_owned(), files: written, pr, commits, scrubbed };
    let _ = ctx.run_json(call, "runtime.setExt", json!({ "id": id, "plugin": api::EXT, "value": { "tracked": { "repo": out.repo, "files": out.files, "store": out.store }, "offer": false } })).await;
    Ok(out)
}

/// The harness's own session log of a task (Claude Code's `.jsonl`), compressed, so `wisp open` on another
/// computer can resume it there. None when the harness keeps none or it isn't on this computer.
async fn native_log(ctx: &Ctx, task: &Value) -> Option<Vec<u8>> {
    let sid = task.get("resumeId").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    let agent = task.get("agent").and_then(Value::as_str).unwrap_or_default();
    let h = ctx.contributions(&wisp_runtime_api::harness::sessions::SESSIONS).into_iter().find(|h| h.harness() == agent)?;
    let raw = h.raw(sid).await?;
    Some(repo::compress(&raw))
}

async fn untrack(ctx: &Ctx, call: &Call, a: &api::UntrackArgs) -> Result<api::Gone> {
    let p = proc(ctx)?;
    let root = if let Some(r) = &a.repo {
        PathBuf::from(r)
    } else {
        let task = ctx.run_json(call, "runtime.get", json!({ "id": a.id })).await.unwrap_or_default();
        root_of(&p, task.get("cwd").and_then(Value::as_str).unwrap_or_default()).await
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
    let Ok(task) = ctx.run_json(&call, "runtime.get", json!({ "id": id })).await else { return };
    if task.get("state").and_then(Value::as_str) != Some("done") || task.get("parentId").is_some_and(|p| !p.is_null()) {
        return;
    }
    let Ok(p) = proc(ctx) else { return };
    let cwd = task.get("cwd").and_then(Value::as_str).unwrap_or_default();
    let root = root_of(&p, cwd).await;
    if tokio::fs::metadata(root.join(".wisp/wisp.yml")).await.is_err() {
        return;
    }
    let turns = ctx.run_json(&call, "runtime.turns", json!({ "id": id })).await.ok().and_then(|t| t.as_array().map(Vec::len)).unwrap_or(0);
    let seen = task.pointer("/ext/wisp.history/seenTurns").and_then(Value::as_u64);
    if seen == Some(turns as u64) {
        return;
    }
    let mark = |extra: Value| {
        let mut v = task.pointer("/ext/wisp.history").cloned().filter(Value::is_object).unwrap_or_else(|| json!({}));
        if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
            o.extend(e.clone());
            o.insert("seenTurns".into(), json!(turns));
        }
        v
    };
    match setting(&root, "track", "ask").await.as_str() {
        "auto" => {
            if let Err(e) = track(ctx, &call, &api::TrackArgs { id: id.to_owned(), level: None, repo: Some(root.display().to_string()) }).await {
                tracing::warn!(task = id, "history: not saved: {}", e.message);
            }
            let after = ctx.run_json(&call, "runtime.get", json!({ "id": id })).await.unwrap_or_default();
            let mut v = after.pointer("/ext/wisp.history").cloned().unwrap_or_else(|| json!({}));
            v["seenTurns"] = json!(turns);
            let _ = ctx.run_json(&call, "runtime.setExt", json!({ "id": id, "plugin": api::EXT, "value": v })).await;
        }
        "ask" => {
            let _ = ctx.run_json(&call, "runtime.setExt", json!({ "id": id, "plugin": api::EXT, "value": mark(json!({ "offer": true, "repo": root.display().to_string() })) })).await;
            if let Ok(n) = wisp_kernel::services::notify(ctx) {
                n.notice("history.offer", json!({ "task": id, "title": task.get("title"), "repo": root.display().to_string(), "text": "Save it to the repo?" }), None);
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
    s.intercept::<wisp_runtime_api::hooks::BeforeRun, _, _>(wisp_kernel::InterceptOpts { priority: 70, failure: wisp_kernel::Failure::Open, timeout_ms: 2000 }, move |ctx, _call, c| {
        let (known, roots) = (known.clone(), roots.clone());
        async move {
            if let Ok(p) = proc(&ctx) {
                let root = root_of(&p, &c.cwd).await;
                let on = setting(&root, "inject", "false").await == "true";
                let all = if on { docs(&root).await } else { Vec::new() };
                let key = root.display().to_string();
                known.0.lock().unwrap_or_else(PoisonError::into_inner).insert(key.clone(), (on, all));
                roots.lock().unwrap_or_else(PoisonError::into_inner).insert(c.session_id.as_str().to_owned(), key);
            }
            wisp_kernel::Verdict::Continue
        }
    });
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
        requests::register(s);
        hooks(s);
        Ok(())
    }
}

#[cfg(test)]
mod tests;
