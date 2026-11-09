//! A repo's agent history (ADR-0033, ADR-0035) from the terminal: `wisp track` / `untrack`, `wisp blame`,
//! `wisp log`, `wisp tasks --touching|--tracked`, `wisp ls --repo`, `wisp resume`, `wisp adopt`,
//! `wisp skill install`, and `wisp mcp` (a stdio MCP server with `wisp_history`, `wisp_blame`, `wisp_task`
//! and `wisp_resume`). Reading needs no running wisp: it's `.wisp/tasks` and git (commit trailers).
use std::collections::BTreeMap;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use wisp_share_api::Bundle;
use wisp_share_core::repo;

use crate::client::{CliError, Client, Result};
use crate::code::Opts;
use crate::scripted::say;

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn git(root: &Path, args: &[&str]) -> Option<String> {
    let o = std::process::Command::new("git").args(args).current_dir(root).output().ok()?;
    o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned())
}

/// The repo `cwd` is in (its top), or `cwd`.
pub fn root(cwd: &Path) -> PathBuf {
    git(cwd, &["rev-parse", "--show-toplevel"]).map_or_else(|| cwd.to_owned(), |r| PathBuf::from(r.trim()))
}

/// A tracked task: its file (relative to the repo) and what it says.
#[derive(Debug, Clone)]
pub struct Tracked {
    pub path: String,
    pub doc: Value,
}

impl Tracked {
    pub fn id(&self) -> &str {
        s(&self.doc, "id")
    }
    fn files(&self) -> Vec<String> {
        self.doc.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
    }
    fn line(&self) -> String {
        let at = self.doc.get("createdAt").and_then(Value::as_i64).unwrap_or(0);
        let day = repo::year_month(at).replace('/', "-");
        let commits = self.doc.get("commits").and_then(Value::as_array).map_or(0, Vec::len);
        let pr = s(&self.doc, "pr");
        format!("{}  {day}  {:<8}  {}{}{}", repo::short(self.id()), s(&self.doc["spec"], "agent"), s(&self.doc, "title"), if commits > 0 { format!("  ({commits} commit{})", if commits == 1 { "" } else { "s" }) } else { String::new() }, if pr.is_empty() { String::new() } else { format!("  {pr}") })
    }
}

/// Every task file in the repo's `.wisp/tasks`, newest first.
pub fn tracked(root: &Path) -> Vec<Tracked> {
    let mut out = Vec::new();
    let mut stack = vec![root.join(".wisp/tasks")];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.to_string_lossy().ends_with(".task.yml")
                && let Ok(text) = std::fs::read_to_string(&p)
                && let Some(doc) = wisp_resources_core::formula::documents(&text, wisp_resources_core::formula::Format::Yaml).ok().and_then(|d| d.into_iter().next())
            {
                out.push(Tracked { path: p.strip_prefix(root).map_or_else(|_| p.display().to_string(), |r| r.display().to_string()), doc });
            }
        }
    }
    out.sort_by_key(|t| std::cmp::Reverse(t.doc.get("createdAt").and_then(Value::as_i64).unwrap_or(0)));
    out
}

fn find<'a>(all: &'a [Tracked], id: &str) -> Option<&'a Tracked> {
    all.iter().find(|t| t.id() == id || (id.len() >= 6 && t.id().starts_with(id)))
}

/// The commits that name `id` in their trailer.
fn commits_of(root: &Path, id: &str) -> Vec<String> {
    git(root, &["log", "--all", "--format=%H", &format!("--grep=Wisp-Task: {}", repo::short(id))]).unwrap_or_default().lines().map(str::to_owned).filter(|l| !l.is_empty()).collect()
}

/// `wisp track <id> [--level full|report|spec] [--repo <path>]`: the task written into `.wisp/` (with its
/// transcript at `full`, the default), for you to commit.
#[allow(clippy::many_single_char_names)]
pub async fn track(c: &Client, o: &Opts, cwd: &Path) -> Result<i32> {
    let id = o.words.first().ok_or_else(|| CliError::said("wisp track <task id>"))?;
    let level = o.level.clone().unwrap_or_else(|| "full".into());
    let root = root(&o.project.as_ref().map_or_else(|| cwd.to_owned(), PathBuf::from));
    let p = c.cmd("share.preview", json!({ "id": id, "level": level })).await?;
    let mut b: Bundle = serde_json::from_value(p["bundle"].clone()).map_err(|e| CliError::said(e.to_string()))?;
    let task = c.cmd("runtime.get", json!({ "id": id })).await.unwrap_or_default();
    // in a repo a task is known by its own id (the trailer's), not the share's
    if let Some(tid) = task.get("id").and_then(Value::as_str) {
        tid.clone_into(&mut b.id);
    }
    let pr = task.pointer("/ext/wisp.ship/pr/url").and_then(Value::as_str).map(str::to_owned);
    let me = git(&root, &["config", "user.name"]).unwrap_or_default();
    let written = write_task(&root, &b, &commits_of(&root, &b.id), pr.as_deref(), me.trim())?;
    let st = crate::cli::style();
    for f in &written {
        say(&format!("  {} .wisp/{f}", wisp_cli_core::term::paint(&st, wisp_cli_core::term::GREEN, "+")));
    }
    let n = p["redactions"].as_array().map_or(0, Vec::len);
    say(&format!("  tracked {} ({level}{}): commit .wisp/ with your changes", repo::short(&b.id), if n > 0 { format!(", {n} things scrubbed") } else { String::new() }));
    Ok(0)
}

/// The task's files written under `<root>/.wisp`. → their paths, relative to `.wisp/`.
pub fn write_task(root: &Path, b: &Bundle, commits: &[String], pr: Option<&str>, by: &str) -> Result<Vec<String>> {
    let dot = root.join(".wisp");
    // a lower level than before: what isn't kept goes
    let _ = remove_task(root, &b.id, None);
    let mut out = Vec::new();
    for (rel, bytes) in repo::files_for(b, commits, pr, by) {
        let p = dot.join(&rel);
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).map_err(|e| CliError::said(e.to_string()))?;
        }
        std::fs::write(&p, bytes).map_err(|e| CliError::said(format!("{}: {e}", p.display())))?;
        out.push(rel);
    }
    Ok(out)
}

/// Removes a task's files, or (with `keep`) what's above that level. → what went.
fn remove_task(root: &Path, id: &str, keep: Option<&str>) -> Vec<String> {
    let all = tracked(root);
    let Some(t) = find(&all, id) else { return Vec::new() };
    let base = t.path.trim_end_matches(".task.yml").to_owned();
    let full_id = t.id().to_owned();
    let mut gone = Vec::new();
    let mut rm = |p: PathBuf| {
        if std::fs::remove_file(&p).is_ok() {
            gone.push(p.strip_prefix(root).map_or_else(|_| p.display().to_string(), |r| r.display().to_string()));
        }
    };
    rm(root.join(".wisp/history").join(format!("{full_id}.jsonl.zst")));
    if keep != Some("report") {
        rm(root.join(format!("{base}.report.md")));
    }
    if keep.is_none() {
        rm(root.join(format!("{base}.task.yml")));
    }
    gone
}

/// `wisp untrack <id> [--keep report|spec]`.
pub fn untrack(o: &Opts, cwd: &Path) -> Result<i32> {
    let id = o.words.first().ok_or_else(|| CliError::said("wisp untrack <task id> [--keep report|spec]"))?;
    let keep = o.level.as_deref().filter(|l| matches!(*l, "report" | "spec"));
    let gone = remove_task(&root(cwd), id, keep);
    if gone.is_empty() {
        return Err(CliError::said(format!("{id} isn't tracked here")));
    }
    for g in gone {
        say(&format!("  - {g}"));
    }
    say("  (git history keeps what was committed before)");
    Ok(0)
}

/// Who wrote what: (task id or "", lines) per commit of a blame.
fn blame_lines(root: &Path, file: &str, range: Option<(u32, u32)>) -> Vec<(String, u32)> {
    let mut args = vec!["blame".to_owned(), "--porcelain".to_owned()];
    if let Some((a, b)) = range {
        args.push("-L".into());
        args.push(format!("{a},{b}"));
    }
    args.push("--".into());
    args.push(file.to_owned());
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = git(root, &refs).unwrap_or_default();
    let mut per: BTreeMap<String, u32> = BTreeMap::new();
    for l in out.lines() {
        let mut w = l.split_whitespace();
        if let (Some(sha), Some(_), Some(_)) = (w.next(), w.next(), w.next())
            && sha.len() == 40
            && sha.bytes().all(|b| b.is_ascii_hexdigit())
        {
            *per.entry(sha.to_owned()).or_default() += 1;
        }
    }
    per.into_iter().collect()
}

/// The tasks a commit is for: its trailers, else the task files that list it (a backfilled task).
fn tasks_of_commit(root: &Path, sha: &str) -> Vec<String> {
    let ids = repo::trailers(&git(root, &["show", "-s", "--format=%B", sha]).unwrap_or_default());
    if !ids.is_empty() {
        return ids;
    }
    tracked(root).into_iter().filter(|t| t.doc.get("commits").and_then(Value::as_array).is_some_and(|c| c.iter().any(|x| x.as_str() == Some(sha)))).map(|t| t.id().to_owned()).collect()
}

/// The answer to `wisp blame <target>`: tasks (with lines or commits) and what no task wrote.
pub fn blame(root: &Path, target: &str) -> Value {
    let all = tracked(root);
    let card = |id: &str, extra: Value| {
        let t = find(&all, id);
        json!({ "task": t.map_or(id, Tracked::id), "title": t.map(|t| s(&t.doc, "title")), "prompt": t.map(|t| s(&t.doc["spec"], "prompt")), "agent": t.map(|t| s(&t.doc["spec"], "agent")), "pr": t.map(|t| s(&t.doc, "pr")), "file": t.map(|t| t.path.clone()), "tracked": t.is_some(), "what": extra })
    };
    // a task id: its commits, PR and files
    if let Some(t) = find(&all, target) {
        let mut commits = commits_of(root, t.id());
        for c in t.doc.get("commits").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            if !commits.iter().any(|x| x == c) {
                commits.push(c.to_owned());
            }
        }
        return json!({ "target": target, "kind": "task", "tasks": [card(t.id(), json!({ "commits": commits, "files": t.files() }))] });
    }
    // a PR: the tasks that made it
    if target.starts_with('#') || target.contains("/pull/") {
        let n = target.trim_start_matches('#');
        let hits: Vec<Value> = all.iter().filter(|t| s(&t.doc, "pr") == target || s(&t.doc, "pr").ends_with(&format!("/pull/{n}")) || s(&t.doc, "pr") == format!("#{n}")).map(|t| card(t.id(), json!({}))).collect();
        return json!({ "target": target, "kind": "pr", "tasks": hits });
    }
    // file:line or file:a-b, a file, a folder
    let (path, range) = match target.rsplit_once(':') {
        Some((p, r)) if r.chars().all(|c| c.is_ascii_digit() || c == '-') && !r.is_empty() => {
            let (a, b) = r.split_once('-').unwrap_or((r, r));
            (p.to_owned(), Some((a.parse().unwrap_or(1), b.parse().unwrap_or(1))))
        }
        _ => (target.to_owned(), None),
    };
    let full = root.join(&path);
    if full.is_file() {
        let lines = blame_lines(root, &path, range);
        let total: u32 = lines.iter().map(|(_, n)| n).sum();
        let mut by: BTreeMap<String, u32> = BTreeMap::new();
        for (sha, n) in &lines {
            let ids = tasks_of_commit(root, sha);
            *by.entry(ids.first().cloned().unwrap_or_default()).or_default() += n;
        }
        let hand = by.remove("").unwrap_or(0);
        let mut tasks: Vec<(String, u32)> = by.into_iter().collect();
        tasks.sort_by_key(|(_, n)| std::cmp::Reverse(*n));
        return json!({ "target": target, "kind": if range.is_some() { "lines" } else { "file" }, "lines": total, "byHand": hand, "tasks": tasks.iter().map(|(id, n)| card(id, json!({ "lines": n, "share": if total > 0 { f64::from(*n) / f64::from(total) } else { 0.0 } }))).collect::<Vec<_>>() });
    }
    if full.is_dir() {
        let log = git(root, &["log", "--format=%H", "--", &path]).unwrap_or_default();
        let mut seen: Vec<String> = Vec::new();
        for sha in log.lines() {
            for id in tasks_of_commit(root, sha) {
                if !seen.contains(&id) {
                    seen.push(id);
                }
            }
        }
        for t in all.iter().filter(|t| t.files().iter().any(|f| f.starts_with(path.trim_end_matches('/')))) {
            if !seen.iter().any(|x| t.id().starts_with(x.as_str()) || x == t.id()) {
                seen.push(t.id().to_owned());
            }
        }
        return json!({ "target": target, "kind": "folder", "tasks": seen.iter().map(|id| card(id, json!({}))).collect::<Vec<_>>() });
    }
    // a commit or a range
    let list = if target.contains("..") { git(root, &["rev-list", target]) } else { git(root, &["rev-parse", "--verify", &format!("{target}^{{commit}}")]) };
    let shas: Vec<String> = list.unwrap_or_default().lines().map(str::to_owned).collect();
    let mut tasks: Vec<Value> = Vec::new();
    let mut hand = 0;
    for sha in &shas {
        let ids = tasks_of_commit(root, sha);
        if ids.is_empty() {
            hand += 1;
        }
        for id in ids {
            tasks.push(card(&id, json!({ "commit": sha })));
        }
    }
    json!({ "target": target, "kind": if shas.is_empty() { "unknown" } else { "commits" }, "commits": shas.len(), "byHand": hand, "tasks": tasks })
}

fn show_blame(b: &Value) {
    let tasks = b["tasks"].as_array().cloned().unwrap_or_default();
    if tasks.is_empty() {
        say(&format!("  {}: no task behind it (written by hand, or not tracked)", s(b, "target")));
    }
    for t in &tasks {
        let what = &t["what"];
        let share = what.get("share").and_then(Value::as_f64).map(|x| format!("  {:.0}% ({} lines)", x * 100.0, what["lines"])).unwrap_or_default();
        say(&format!("  {}  {}{share}", repo::short(s(t, "task")), t["title"].as_str().unwrap_or("(not in .wisp/: a task from another clone, or untracked)")));
        if let Some(p) = t["prompt"].as_str().filter(|p| !p.is_empty()) {
            say(&format!("      asked: {}", p.lines().next().unwrap_or_default().chars().take(100).collect::<String>()));
        }
        if let Some(pr) = t["pr"].as_str().filter(|p| !p.is_empty()) {
            say(&format!("      {pr}"));
        }
    }
    if let Some(n) = b.get("byHand").and_then(Value::as_u64).filter(|n| *n > 0) {
        say(&format!("  {n} {} by hand", if b["kind"] == "commits" { "commits" } else { "lines" }));
    }
}

/// `wisp blame <file:line|file|folder|commit|range|#PR|task id> [--json]`.
#[allow(clippy::unnecessary_wraps)] // every command answers a Result
pub fn blame_cmd(o: &Opts, cwd: &Path) -> Result<i32> {
    let target = o.words.first().ok_or_else(|| CliError::said("wisp blame <file>:<line> | <file> | <commit> | #<pr> | <task id>"))?;
    let b = blame(&root(cwd), target);
    if o.json {
        say(&serde_json::to_string_pretty(&b).unwrap_or_default());
    } else {
        show_blame(&b);
    }
    Ok(0)
}

/// The tracked tasks, filtered: a path they touched, an agent, words, `--since`.
pub fn filtered(root: &Path, path: Option<&str>, agent: Option<&str>, grep: Option<&str>) -> Vec<Tracked> {
    tracked(root)
        .into_iter()
        .filter(|t| path.is_none_or(|p| t.files().iter().any(|f| f.starts_with(p.trim_end_matches('/')))))
        .filter(|t| agent.is_none_or(|a| s(&t.doc["spec"], "agent") == a))
        .filter(|t| grep.is_none_or(|g| format!("{} {}", s(&t.doc, "title"), s(&t.doc["spec"], "prompt")).to_lowercase().contains(&g.to_lowercase())))
        .collect()
}

/// `wisp log [path]`, `wisp tasks --touching <path>|--tracked`, `wisp ls --repo [--path p] [--agent a] [--grep w]`.
#[allow(clippy::unnecessary_wraps)] // every command answers a Result
pub fn log(argv: &[String], o: &Opts, cwd: &Path) -> Result<i32> {
    let flag = |k: &str| argv.iter().position(|a| a == k).and_then(|i| argv.get(i + 1)).map(String::as_str);
    let path = flag("--touching").or_else(|| flag("--path")).or_else(|| o.words.first().map(String::as_str).filter(|w| !w.starts_with('-')));
    let list = filtered(&root(o.project.as_ref().map_or(cwd, Path::new)), path, flag("--agent"), flag("--grep"));
    if o.json {
        say(&serde_json::to_string_pretty(&list.iter().map(|t| t.doc.clone()).collect::<Vec<_>>()).unwrap_or_default());
        return Ok(0);
    }
    if list.is_empty() {
        say("  no tracked tasks here yet (wisp track <id>, or history: { track: auto } in .wisp/wisp.yml)");
    }
    for t in list {
        say(&format!("⎇ {}", t.line()));
    }
    Ok(0)
}

/// `wisp resume <id>`: a new task that carries on from where that one stopped, on today's code.
pub async fn resume(c: &Client, o: &Opts, cwd: &Path) -> Result<i32> {
    let id = o.words.first().ok_or_else(|| CliError::said("wisp resume <task id>"))?;
    let root = root(cwd);
    let all = tracked(&root);
    let (title, spec, report, full) = if let Some(t) = find(&all, id) {
        let md = std::fs::read_to_string(root.join(t.path.replace(".task.yml", ".report.md"))).unwrap_or_default();
        (s(&t.doc, "title").to_owned(), t.doc["spec"].clone(), md, t.id().to_owned())
    } else {
        let task = c.cmd("runtime.get", json!({ "id": id })).await?;
        let spec = c.cmd("runtime.spec", json!({ "id": id })).await.unwrap_or_default();
        let p = c.cmd("share.preview", json!({ "id": id, "level": "report" })).await.unwrap_or_default();
        let md = p.pointer("/bundle/report").map(|r| repo::report_md(s(&task, "title"), r)).unwrap_or_default();
        (s(&task, "title").to_owned(), spec, md, s(&task, "id").to_owned())
    };
    let report: String = report.chars().take(6000).collect();
    let prompt = format!("Carry on with an earlier task: \"{title}\".\n\nWhat was asked then:\n{}\n\nWhat happened (its report):\n{report}\n\nPick it up from there, on the code as it is today.", s(&spec, "prompt"));
    let mut a = json!({ "prompt": prompt, "title": format!("{title} (resumed)"), "cwd": root.display().to_string(), "lineage": { "forkOf": full } });
    if let Some(ag) = spec.get("agent").and_then(Value::as_str).filter(|x| !x.is_empty()) {
        a["agent"] = json!(ag);
    }
    for (k, v) in &o.over {
        a[k] = v.clone();
    }
    let made = c.cmd("runtime.create", a).await?;
    say(&format!("  ◌ resumed {} as {}  wisp attach {}", repo::short(&full), s(&made, "id"), s(&made, "id")));
    Ok(0)
}

fn track_mode(root: &Path, key: &str, default: &str) -> String {
    let text = std::fs::read_to_string(root.join(".wisp/wisp.yml")).unwrap_or_default();
    let doc = wisp_resources_core::formula::documents(&text, wisp_resources_core::formula::Format::Yaml).ok().and_then(|d| d.into_iter().next()).unwrap_or_default();
    doc.pointer(&format!("/history/{key}")).and_then(Value::as_str).unwrap_or(default).to_owned()
}

/// `wisp adopt [<session id>|--all [--since 7d]] [--track]`, and `--hook` (Claude Code's `SessionEnd`: the
/// session on stdin, adopted per `history: { adopt: ask|auto|off }`).
pub async fn adopt(c: &Client, argv: &[String], o: &Opts, cwd: &Path) -> Result<i32> {
    let has = |k: &str| argv.iter().any(|a| a == k);
    let root = root(cwd);
    let flags = ["--track", "--hook", "--all", "--session"];
    let (mut want, mut track): (Vec<String>, bool) = (o.words.iter().filter(|w| !flags.contains(&w.as_str())).cloned().collect(), has("--track"));
    let mut dir = cwd.display().to_string();
    if has("--hook") {
        let mut input = String::new();
        let _ = std::io::stdin().lock().read_line(&mut input);
        let v: Value = serde_json::from_str(&input).unwrap_or_default();
        if let Some(c) = v.get("cwd").and_then(Value::as_str) {
            c.clone_into(&mut dir);
        }
        let root = self::root(Path::new(&dir));
        match track_mode(&root, "adopt", "ask").as_str() {
            "auto" => {
                want = vec![s(&v, "session_id").to_owned()];
                track = track_mode(&root, "track", "ask") == "auto";
            }
            "off" => return Ok(0),
            _ => {
                say(&format!("wisp: track this session? wisp adopt {} --track", s(&v, "session_id")));
                return Ok(0);
            }
        }
    }
    if let Some(i) = argv.iter().position(|a| a == "--session") {
        want = argv.get(i + 1).cloned().into_iter().collect();
    }
    let list = c.cmd("runtime.sessions", json!({ "cwd": dir })).await?;
    let sessions = list.as_array().cloned().unwrap_or_default();
    if has("--all") {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0));
        let since = o.since.as_deref().and_then(|t| crate::history_cli::since_ms(t, now).ok()).unwrap_or(0);
        want = sessions.iter().filter(|x| x["updatedAt"].as_i64().unwrap_or(0) >= since).map(|x| s(x, "id").to_owned()).collect();
    }
    if want.is_empty() {
        if sessions.is_empty() {
            say("  no sessions outside wisp in this folder (Claude Code, Codex)");
        }
        for x in &sessions {
            say(&format!("  {}  {:<7}  {} prompts  {}", s(x, "id"), s(x, "harness"), x["prompts"], s(x, "title")));
        }
        if !sessions.is_empty() {
            say("  wisp adopt <id> [--track], or --all --since 7d");
        }
        return Ok(0);
    }
    for id in want {
        let harness = sessions.iter().find(|x| s(x, "id") == id).map_or_else(|| if id.len() == 36 && id.contains('-') { "claude" } else { "codex" }.to_owned(), |x| s(x, "harness").to_owned());
        let made = c.cmd("runtime.adoptSession", json!({ "harness": harness, "id": id })).await?;
        let task = s(&made, "id").to_owned();
        say(&format!("  ✓ {harness} session {id} → task {task} (a follow-up continues it there)"));
        if track {
            let mut o2 = o.clone();
            o2.words = vec![task];
            track_in(c, &o2, &root).await?;
        }
    }
    Ok(0)
}

async fn track_in(c: &Client, o: &Opts, root: &Path) -> Result<i32> {
    let mut o = o.clone();
    o.project = Some(root.display().to_string());
    track(c, &o, root).await
}

/// `wisp skill install --agent claude|codex`: wisp's MCP server (`wisp mcp`) for that harness, and for
/// Claude Code its `SessionEnd` hook (`wisp adopt --hook`) and wisp's skill.
pub fn skill_install(argv: &[String], cwd: &Path) -> Result<i32> {
    let agent = argv.iter().position(|a| a == "--agent").and_then(|i| argv.get(i + 1)).map_or("claude", String::as_str);
    let root = root(cwd);
    let exe = std::env::current_exe().map_or_else(|_| "wisp".into(), |p| p.display().to_string());
    let rw = |p: &Path, f: &dyn Fn(&mut Value)| -> Result<()> {
        let mut v: Value = std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_else(|| json!({}));
        f(&mut v);
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).map_err(|e| CliError::said(e.to_string()))?;
        }
        std::fs::write(p, format!("{}\n", serde_json::to_string_pretty(&v).unwrap_or_default())).map_err(|e| CliError::said(e.to_string()))
    };
    match agent {
        "claude" => {
            rw(&root.join(".mcp.json"), &|v| v["mcpServers"]["wisp"] = json!({ "command": exe, "args": ["mcp"] }))?;
            rw(&root.join(".claude/settings.json"), &|v| {
                let hook = json!({ "hooks": [{ "type": "command", "command": format!("{exe} adopt --hook") }] });
                let list = v["hooks"]["SessionEnd"].as_array().cloned().unwrap_or_default();
                if !list.iter().any(|h| h.to_string().contains("adopt --hook")) {
                    let mut l = list;
                    l.push(hook);
                    v["hooks"]["SessionEnd"] = Value::Array(l);
                }
            })?;
            let skill = root.join(".claude/skills/wisp/SKILL.md");
            std::fs::create_dir_all(skill.parent().unwrap_or(&root)).map_err(|e| CliError::said(e.to_string()))?;
            std::fs::write(&skill, "---\nname: wisp\ndescription: Read why code is the way it is: the wisp tasks behind a file, a line, a commit or a PR.\n---\n\nBefore changing a file, ask wisp which tasks shaped it: the `wisp_history` tool (paths) or `wisp_blame` (a file:line, a commit, a PR), then `wisp_task` for one task's prompt and report. To pick an old task up, `wisp_resume` asks the user. Without MCP: `wisp tasks --touching <path> --json`, `wisp blame <target> --json`, or read `.wisp/tasks/`.\n").map_err(|e| CliError::said(e.to_string()))?;
            say("  ✓ .mcp.json (wisp mcp), .claude/settings.json (SessionEnd: wisp adopt --hook), .claude/skills/wisp/SKILL.md");
        }
        "codex" => {
            let home = std::env::var("CODEX_HOME").map_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".codex"), PathBuf::from);
            let cfg = home.join("config.toml");
            let had = std::fs::read_to_string(&cfg).unwrap_or_default();
            if !had.contains("[mcp_servers.wisp]") {
                std::fs::create_dir_all(&home).map_err(|e| CliError::said(e.to_string()))?;
                std::fs::write(&cfg, format!("{had}\n[mcp_servers.wisp]\ncommand = \"{exe}\"\nargs = [\"mcp\"]\n")).map_err(|e| CliError::said(e.to_string()))?;
            }
            say(&format!("  ✓ {} ([mcp_servers.wisp]); Codex has no session-end hook: wisp adopt --all --since 1d", cfg.display()));
        }
        other => return Err(CliError::said(format!("wisp skill install --agent claude|codex (not {other} yet)"))),
    }
    Ok(0)
}

fn tool_text(text: &str) -> Value {
    json!({ "content": [{ "type": "text", "text": text }] })
}

/// One MCP call on the repo's history. `resume` only asks: starting work is the user's.
fn mcp_tool(root: &Path, name: &str, args: &Value) -> Value {
    match name {
        "wisp_history" => {
            let paths: Vec<String> = args.get("paths").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect();
            let mut seen = Vec::new();
            let mut out = Vec::new();
            for p in if paths.is_empty() { vec![String::new()] } else { paths } {
                for t in filtered(root, Some(&p).filter(|p| !p.is_empty()).map(String::as_str), None, None) {
                    if !seen.contains(&t.id().to_owned()) {
                        seen.push(t.id().to_owned());
                        out.push(json!({ "id": t.id(), "title": s(&t.doc, "title"), "prompt": s(&t.doc["spec"], "prompt"), "agent": s(&t.doc["spec"], "agent"), "pr": s(&t.doc, "pr"), "files": t.files(), "file": t.path }));
                    }
                }
            }
            tool_text(&serde_json::to_string_pretty(&out).unwrap_or_default())
        }
        "wisp_blame" => tool_text(&serde_json::to_string_pretty(&blame(root, args.get("target").and_then(Value::as_str).unwrap_or_default())).unwrap_or_default()),
        "wisp_task" => {
            let all = tracked(root);
            match find(&all, args.get("id").and_then(Value::as_str).unwrap_or_default()) {
                Some(t) => {
                    let md = std::fs::read_to_string(root.join(t.path.replace(".task.yml", ".report.md"))).unwrap_or_default();
                    tool_text(&format!("{}\n\n{md}", wisp_resources_core::export::yaml(&t.doc)))
                }
                None => json!({ "content": [{ "type": "text", "text": "no tracked task with that id" }], "isError": true }),
            }
        }
        "wisp_resume" => tool_text(&format!("Resuming starts work, so it's the user's call. Ask them to run: wisp resume {}", args.get("id").and_then(Value::as_str).unwrap_or_default())),
        _ => json!({ "content": [{ "type": "text", "text": format!("{name} isn't a tool here") }], "isError": true }),
    }
}

fn mcp_tools() -> Value {
    let one = |name: &str, desc: &str, prop: &str, kind: Value| json!({ "name": name, "description": desc, "inputSchema": { "type": "object", "properties": { prop: kind }, "required": [prop] } });
    json!([
        one("wisp_history", "The wisp tasks that touched these paths (newest first): what was asked, the agent, the PR. Read them before changing those files.", "paths", json!({ "type": "array", "items": { "type": "string" } })),
        one("wisp_blame", "Which task made this: a file:line or file:10-40, a file or folder, a commit or range, a PR (#812) or a task id.", "target", json!({ "type": "string" })),
        one("wisp_task", "One tracked task: its spec and its report.", "id", json!({ "type": "string" })),
        one("wisp_resume", "Ask the user to resume an earlier task (they start it).", "id", json!({ "type": "string" })),
    ])
}

/// The reply to one JSON-RPC message (None for a notification).
pub fn mcp_reply(root: &Path, msg: &Value) -> Option<Value> {
    let id = msg.get("id")?.clone();
    let result = match msg.get("method").and_then(Value::as_str).unwrap_or_default() {
        "initialize" => json!({ "protocolVersion": msg.pointer("/params/protocolVersion").cloned().unwrap_or(json!("2025-06-18")), "capabilities": { "tools": {} }, "serverInfo": { "name": "wisp", "version": env!("CARGO_PKG_VERSION") } }),
        "tools/list" => json!({ "tools": mcp_tools() }),
        "tools/call" => mcp_tool(root, msg.pointer("/params/name").and_then(Value::as_str).unwrap_or_default(), msg.pointer("/params/arguments").unwrap_or(&json!({}))),
        "ping" => json!({}),
        m => return Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": format!("{m}: not a method here") } })),
    };
    Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
}

/// `wisp mcp [--repo <path>]`: the history tools over stdio, from the files and git (no wisp needed).
#[allow(clippy::unnecessary_wraps)] // every command answers a Result
pub fn mcp(argv: &[String], cwd: &Path) -> Result<i32> {
    let at = argv.iter().position(|a| a == "--repo").and_then(|i| argv.get(i + 1)).map_or_else(|| cwd.to_owned(), PathBuf::from);
    let root = root(&at);
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines().map_while(std::result::Result::ok) {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        if let Some(r) = mcp_reply(&root, &msg) {
            let _ = writeln!(out, "{r}");
            let _ = out.flush();
        }
    }
    Ok(0)
}
