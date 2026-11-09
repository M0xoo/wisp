//! `history.blame`: which task made a line, a file, a folder, a commit or range, a PR; or a task's
//! commits, PR, files and how much of what it wrote is still there.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use wisp_history_api::{BlameArgs, BlameSource};
use wisp_history_core::{Doc, find, shares, still_there, tasks_of_commit};
use wisp_kernel::{Ctx, Result};

#[allow(clippy::needless_pass_by_value)] // built in place at each call
fn card(all: &[Doc], id: &str, what: Value) -> Value {
    let t = find(all, id);
    json!({ "task": t.map_or(id, Doc::id), "title": t.map(Doc::title), "prompt": t.and_then(|t| t.doc.pointer("/spec/prompt")).and_then(Value::as_str), "agent": t.and_then(|t| t.doc.pointer("/spec/agent")).and_then(Value::as_str), "pr": t.and_then(|t| t.doc.get("pr")).and_then(Value::as_str), "file": t.map(|t| t.path.clone()), "tracked": t.is_some(), "what": what })
}

async fn of_commit(b: &dyn BlameSource, root: &Path, all: &[Doc], sha: &str) -> Vec<String> {
    let msg = b.message(root.to_owned(), sha.to_owned()).await;
    tasks_of_commit(all, sha, &msg)
}

/// A task's commits (its trailer's, and the ones its file lists), and how much of what they added the
/// current tree still has from them.
async fn task_answer(b: &dyn BlameSource, root: &Path, all: &[Doc], d: &Doc) -> Value {
    let mut commits = b.grep(root.to_owned(), format!("{} {}", wisp_history_core::repo::TRAILER, wisp_history_core::repo::short(d.id()))).await;
    for c in d.commits() {
        if !commits.iter().any(|x| x == c) {
            commits.push(c.to_owned());
        }
    }
    let (mut added, mut files) = (0u32, Vec::<String>::new());
    for c in &commits {
        for (f, n) in b.added(root.to_owned(), c.clone()).await {
            added += n;
            if !files.contains(&f) {
                files.push(f);
            }
        }
    }
    let mut surviving = 0u32;
    for f in &files {
        if tokio::fs::metadata(root.join(f)).await.is_ok() {
            surviving += b.blame(root.to_owned(), f.clone(), None).await.iter().filter(|(s, _)| commits.contains(s)).map(|(_, n)| n).sum::<u32>();
        }
    }
    let listed: Vec<&str> = d.files();
    let files: Vec<String> = if files.is_empty() { listed.iter().map(|f| (*f).to_owned()).collect() } else { files };
    json!({ "target": d.id(), "kind": "task", "tasks": [card(all, d.id(), json!({ "commits": commits, "files": files, "added": added, "surviving": surviving, "stillThere": still_there(surviving, added) }))] })
}

/// Every line of a file (or of `range`) with the task that wrote it, for a why-gutter: `{n, text, task, title,
/// why}`, `task` null for a line written by hand. A source that can't list lines answers none.
async fn by_line(b: &dyn BlameSource, root: &Path, all: &[Doc], path: &str, range: Option<(u32, u32)>, of: &mut std::collections::HashMap<String, Vec<String>>) -> Vec<Value> {
    let lines = b.lines(root.to_owned(), path.to_owned()).await;
    let (from, to) = range.unwrap_or((1, u32::MAX));
    let mut out = Vec::new();
    for (i, (sha, text)) in lines.into_iter().enumerate() {
        let n = u32::try_from(i + 1).unwrap_or(u32::MAX);
        if n < from || n > to {
            continue;
        }
        if !of.contains_key(&sha) {
            let ids = of_commit(b, root, all, &sha).await;
            of.insert(sha.clone(), ids);
        }
        let task = of.get(&sha).and_then(|ids| ids.first()).cloned();
        let doc = task.as_deref().and_then(|t| find(all, t));
        out.push(json!({
            "n": n,
            "text": text,
            "task": task,
            "title": doc.map(Doc::title),
            "why": doc.and_then(|t| t.doc.pointer("/spec/prompt")).and_then(Value::as_str),
            "commit": sha.get(..12).unwrap_or(&sha),
        }));
    }
    out
}

#[allow(clippy::many_single_char_names, clippy::too_many_lines)] // one answer per kind of target
pub async fn answer(ctx: &Ctx, a: &BlameArgs) -> Result<Value> {
    let root = PathBuf::from(&a.repo);
    let b = super::blame_for(ctx, &super::setting(&root, "blame", "git").await)?;
    let all = super::docs(&root).await;
    let target = a.target.as_str();
    if let Some(d) = find(&all, target) {
        return Ok(task_answer(b.as_ref(), &root, &all, d).await);
    }
    if target.starts_with('#') || target.contains("/pull/") {
        let n = target.trim_start_matches('#');
        let hits: Vec<Value> = all.iter().filter(|t| t.doc.get("pr").and_then(Value::as_str).is_some_and(|p| p == target || p.ends_with(&format!("/pull/{n}")))).map(|t| card(&all, t.id(), json!({}))).collect();
        return Ok(json!({ "target": target, "kind": "pr", "tasks": hits }));
    }
    if !b.knows(root.clone()).await {
        return Ok(json!({ "target": target, "kind": "unknown", "tasks": [], "note": format!("{} isn't under {}: blame needs it", a.repo, b.id()) }));
    }
    let (path, range) = match target.rsplit_once(':') {
        Some((p, r)) if !r.is_empty() && r.chars().all(|c| c.is_ascii_digit() || c == '-') => {
            let (x, y) = r.split_once('-').unwrap_or((r, r));
            (p.to_owned(), Some((x.parse().unwrap_or(1), y.parse().unwrap_or(1))))
        }
        _ => (target.to_owned(), None),
    };
    let full = root.join(&path);
    if tokio::fs::metadata(&full).await.is_ok_and(|m| m.is_file()) {
        let lines = b.blame(root.clone(), path.clone(), range).await;
        let mut of = std::collections::HashMap::new();
        for (sha, _) in &lines {
            of.insert(sha.clone(), of_commit(b.as_ref(), &root, &all, sha).await);
        }
        let (total, hand, by) = shares(&lines, &|s| of.get(s).cloned().unwrap_or_default());
        let tasks: Vec<Value> = by.iter().map(|(id, n)| card(&all, id, json!({ "lines": n, "share": if total > 0 { f64::from(*n) / f64::from(total) } else { 0.0 } }))).collect();
        let mut out = json!({ "target": target, "kind": if range.is_some() { "lines" } else { "file" }, "lines": total, "byHand": hand, "tasks": tasks });
        if a.by_line {
            out["byLine"] = Value::Array(by_line(b.as_ref(), &root, &all, &path, range, &mut of).await);
        }
        return Ok(out);
    }
    let is_dir = tokio::fs::metadata(&full).await.is_ok_and(|m| m.is_dir());
    let shas = if is_dir { b.commits(root.clone(), String::new(), path.clone()).await } else { b.commits(root.clone(), target.to_owned(), String::new()).await };
    let (mut tasks, mut seen, mut hand) = (Vec::new(), Vec::<String>::new(), 0);
    for sha in &shas {
        let ids = of_commit(b.as_ref(), &root, &all, sha).await;
        if ids.is_empty() {
            hand += 1;
        }
        for id in ids {
            if !seen.contains(&id) {
                seen.push(id.clone());
                tasks.push(card(&all, &id, if is_dir { json!({}) } else { json!({ "commit": sha }) }));
            }
        }
    }
    Ok(json!({ "target": target, "kind": if is_dir { "folder" } else if shas.is_empty() { "unknown" } else { "commits" }, "commits": shas.len(), "byHand": hand, "tasks": tasks }))
}
