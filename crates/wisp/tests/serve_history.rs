//! A repo's agent history (ADR-0033) and adopting outside sessions (ADR-0035), end to end on a real
//! `wisp serve` with the fake agent: `wisp init`, `wisp track` (spec, report, transcript), the commit
//! trailer and `wisp blame` (line, file, commit, task), `wisp log` / `tasks --touching`, `untrack --keep`,
//! `wisp mcp` over stdio, `wisp resume`, `track: auto`, the history tools given to runs, and `wisp adopt`
//! of a Claude Code session (whose follow-up resumes it there) with `--track`, and the SessionEnd hook.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines, clippy::format_collect, clippy::doc_markdown)]

mod common;

use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use common::{Api, ended, start_with, temp};
use serde_json::{Value, json};

fn wisp(dir: &Path, cwd: &Path, port: u16, args: &[&str], stdin: Option<&str>) -> (i32, String, String) {
    let mut c = Command::new(env!("CARGO_BIN_EXE_wisp"))
        .args(args)
        .env("WISP_HOME", dir.join("home"))
        .env("WISP_PORT", port.to_string())
        .env("NO_COLOR", "1")
        .env("CLAUDE_CONFIG_DIR", dir.join("claude-cfg"))
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    if let Some(i) = stdin {
        c.stdin.take().unwrap().write_all(i.as_bytes()).unwrap();
    } else {
        drop(c.stdin.take());
    }
    let o = c.wait_with_output().unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

fn git(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git").args(args).current_dir(dir).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_owned()
}

fn task_files(repo: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![repo.join(".wisp")];
    while let Some(d) = stack.pop() {
        for e in std::fs::read_dir(&d).into_iter().flatten().flatten() {
            if e.path().is_dir() {
                stack.push(e.path());
            } else {
                out.push(e.path().strip_prefix(repo).unwrap().display().to_string());
            }
        }
    }
    out.sort();
    out
}

async fn until(what: &str, f: impl AsyncFn() -> bool) {
    let at = Instant::now();
    while !f().await {
        assert!(at.elapsed() < Duration::from_secs(30), "{what}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn track_blame_log_resume_mcp_and_auto_track() {
    let dir = temp("serve-history");
    let repo = std::fs::canonicalize(dir.join("proj")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    let rec = dir.join("rec");
    std::fs::create_dir_all(&rec).unwrap();
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };

    let (code, out, err) = wisp(&dir, &repo, port, &["init"], None);
    assert_eq!(code, 0, "{out}{err}");
    assert!(std::fs::read_to_string(repo.join(".wisp/wisp.yml")).unwrap().contains("track: ask"));
    assert!(std::fs::read_to_string(repo.join("AGENTS.md")).unwrap().contains("wisp tasks --touching"));

    // a task runs (in the repo: it gets the history tools), then is tracked: spec, report, transcript
    let made = api.cmd("runtime.create", json!({ "prompt": "fix the add bug TOPIC[Fix add]", "cwd": repo, "agent": "claude", "worktree": false })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
    let argv = common::record_text(&rec.join("claude.jsonl"));
    assert!(argv.contains("wisp-history") && argv.contains("\\\"mcp\\\""), "a run in the repo gets wisp mcp: {}", &argv[..argv.len().min(400)]);
    let (code, out, err) = wisp(&dir, &repo, port, &["track", &id], None);
    assert_eq!(code, 0, "{out}{err}");
    let files = task_files(&repo);
    let short = &id[..12];
    assert!(files.iter().any(|f| f.starts_with(".wisp/tasks/") && f.contains(short) && f.ends_with(".task.yml")), "{files:?}");
    assert!(files.iter().any(|f| f.ends_with(".report.md")), "{files:?}");
    assert!(files.iter().any(|f| *f == format!(".wisp/history/{id}.jsonl.zst")), "the transcript, always: {files:?}");

    // the commit says which task it is for; blame finds it from a line, the file, the commit, the task
    git(&repo, &["add", "math.js"]);
    git(&repo, &["commit", "-qm", &format!("fix: add\n\nWisp-Task: {short}")]);
    let sha = git(&repo, &["rev-parse", "HEAD"]);
    let blame = |t: &str| {
        let (_, out, err) = wisp(&dir, &repo, port, &["blame", t, "--json"], None);
        serde_json::from_str::<Value>(&out).unwrap_or_else(|_| panic!("{out}{err}"))
    };
    let b = blame("math.js:1");
    assert_eq!(b["tasks"][0]["task"], id.as_str(), "{b}");
    assert_eq!(b["tasks"][0]["title"], "Fix add");
    std::fs::write(repo.join("NOTES.md"), "by hand\n").unwrap();
    std::fs::write(repo.join("math.js"), format!("{}// a note\n", std::fs::read_to_string(repo.join("math.js")).unwrap())).unwrap();
    git(&repo, &["commit", "-qam", "a note by hand"]);
    let b = blame("math.js");
    assert_eq!((b["byHand"].clone(), b["tasks"][0]["what"]["lines"].clone()), (json!(1), json!(1)), "{b}");
    assert_eq!(blame(&sha)["tasks"][0]["task"], id.as_str());
    assert_eq!(blame("HEAD")["byHand"], 1);
    let b = blame(&id);
    assert!(b["tasks"][0]["what"]["commits"].as_array().unwrap().contains(&json!(sha)), "{b}");
    let (_, out, _) = wisp(&dir, &repo, port, &["log"], None);
    assert!(out.contains("Fix add") && out.contains(short), "{out}");
    let (_, out, _) = wisp(&dir, &repo, port, &["ls", "--repo", "--json"], None);
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap().as_array().unwrap().len(), 1, "{out}");

    // wisp mcp, with no wisp needed: the history tools over stdio
    let msgs = [json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }), json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "wisp_blame", "arguments": { "target": "math.js:1" } } }), json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "wisp_task", "arguments": { "id": short } } })];
    let input: String = msgs.iter().map(|m| format!("{m}\n")).collect();
    let (code, out, err) = wisp(&dir, &repo, 1, &["mcp"], Some(&input));
    assert_eq!(code, 0, "{err}");
    let replies: Vec<Value> = out.lines().filter_map(|l| serde_json::from_str(l).ok()).collect();
    assert_eq!(replies.len(), 4, "{out}");
    let names: Vec<&str> = replies[1]["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    assert_eq!(names, ["wisp_history", "wisp_blame", "wisp_task", "wisp_resume"]);
    assert!(replies[2].to_string().contains(&id) && replies[3].to_string().contains("Fix add"), "{out}");

    // resume: a new task carrying on from it
    let (code, out, err) = wisp(&dir, &repo, port, &["resume", short], None);
    assert_eq!(code, 0, "{out}{err}");
    let new = out.split_whitespace().skip_while(|w| *w != "as").nth(1).unwrap().to_owned();
    let spec = api.cmd("runtime.spec", json!({ "id": new })).await;
    assert_eq!(spec["lineage"]["forkOf"], id.as_str());
    assert!(spec["prompt"].as_str().unwrap().contains("Carry on with an earlier task: \"Fix add\""), "{spec}");

    // untrack --keep report: the transcript goes, the report stays
    let (code, _, _) = wisp(&dir, &repo, port, &["untrack", short, "--level", "report"], None);
    assert_eq!(code, 0);
    let files = task_files(&repo);
    assert!(!files.iter().any(|f| f.ends_with(".jsonl.zst")) && files.iter().any(|f| f.ends_with(".report.md")), "{files:?}");

    // track: auto: a task marked done is saved by itself
    std::fs::write(repo.join(".wisp/wisp.yml"), "wisp: 1\nhistory: { track: auto }\n").unwrap();
    let made = api.cmd("runtime.create", json!({ "prompt": "write the notes TOPIC[Notes]", "cwd": repo, "agent": "claude", "worktree": false })).await;
    let auto = made["id"].as_str().unwrap().to_owned();
    api.until(&auto, "the turn ends", |t| t.last().is_some_and(ended)).await;
    api.cmd("runtime.setState", json!({ "id": auto, "state": "done" })).await;
    let want = format!(".wisp/history/{auto}.jsonl.zst");
    until("auto-tracked", async || task_files(&repo).contains(&want)).await;
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claude_code_session_is_adopted_tracked_and_continued() {
    let dir = temp("serve-adopt");
    let repo = std::fs::canonicalize(dir.join("proj")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    let cwd = repo.display().to_string();
    let store = dir.join("claude-cfg/projects").join(cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>());
    std::fs::create_dir_all(&store).unwrap();
    let sid = "5f1c2e1a-0000-4000-8000-00000000abcd";
    let lines = [
        json!({ "type": "user", "message": { "role": "user", "content": "rename the helper" }, "cwd": cwd, "sessionId": sid, "timestamp": "2026-11-08T10:00:00.000Z" }),
        json!({ "type": "assistant", "message": { "role": "assistant", "model": "claude-opus-4", "content": [{ "type": "text", "text": "Renamed it." }] }, "timestamp": "2026-11-08T10:00:09.000Z" }),
        json!({ "type": "user", "message": { "role": "user", "content": "and its tests" }, "timestamp": "2026-11-08T10:01:00.000Z" }),
        json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": "Done." }] }, "timestamp": "2026-11-08T10:01:20.000Z" }),
    ];
    std::fs::write(store.join(format!("{sid}.jsonl")), lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
    let rec = dir.join("rec");
    std::fs::create_dir_all(&rec).unwrap();
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap()), ("CLAUDE_CONFIG_DIR", dir.join("claude-cfg").to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    assert_eq!(wisp(&dir, &repo, port, &["init"], None).0, 0);

    let (code, out, err) = wisp(&dir, &repo, port, &["adopt"], None);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains(sid) && out.contains("rename the helper") && out.contains("2 prompts"), "{out}");
    let (code, out, err) = wisp(&dir, &repo, port, &["adopt", sid, "--track"], None);
    assert_eq!(code, 0, "{out}{err}");
    let task = out.split_whitespace().skip_while(|w| *w != "task").nth(1).unwrap().to_owned();
    let t = api.cmd("runtime.get", json!({ "id": task })).await;
    assert_eq!((t["ext"]["wisp.adopted"]["from"].clone(), t["resumeId"].clone()), (json!("claude-code"), json!(sid)), "{t}");
    let turns = api.turns(&task).await;
    assert_eq!((turns.len(), turns[1]["text"].clone()), (2, json!("Done.")));
    assert_eq!(api.cmd("runtime.spec", json!({ "id": task })).await["steps"], json!(["and its tests"]));
    assert!(task_files(&repo).iter().any(|f| *f == format!(".wisp/history/{task}.jsonl.zst")), "tracked too");

    // a follow-up continues the same session in Claude Code
    api.cmd("runtime.followUp", json!({ "id": task, "text": "one more thing" })).await;
    api.until(&task, "the follow-up ends", |t| t.len() == 3 && ended(&t[2])).await;
    let argv = common::record_text(&rec.join("claude.jsonl"));
    assert!(argv.contains("--resume") && argv.contains(sid), "it resumed the session there");

    // the SessionEnd hook: installed by wisp skill install, adopting per history.adopt
    let (code, out, err) = wisp(&dir, &repo, port, &["skill", "install", "--agent", "claude"], None);
    assert_eq!(code, 0, "{out}{err}");
    assert!(std::fs::read_to_string(repo.join(".claude/settings.json")).unwrap().contains("adopt --hook"));
    assert!(std::fs::read_to_string(repo.join(".mcp.json")).unwrap().contains("\"mcp\""));
    let hook_in = json!({ "session_id": sid, "cwd": cwd }).to_string();
    let (_, out, _) = wisp(&dir, &repo, port, &["adopt", "--hook"], Some(&hook_in));
    assert!(out.contains(&format!("wisp adopt {sid} --track")), "ask mode only asks: {out}");
    std::fs::write(repo.join(".wisp/wisp.yml"), "wisp: 1\nhistory: { track: manual, adopt: auto }\n").unwrap();
    let before = api.cmd("runtime.list", json!({})).await.as_array().unwrap().len();
    let (code, out, err) = wisp(&dir, &repo, port, &["adopt", "--hook"], Some(&hook_in));
    assert_eq!(code, 0, "{out}{err}");
    assert_eq!(api.cmd("runtime.list", json!({})).await.as_array().unwrap().len(), before, "auto, the same session: its task, never a second");
    // a session the hook hasn't seen: adopted
    let sid2 = "5f1c2e1a-0000-4000-8000-00000000abce";
    std::fs::write(store.join(format!("{sid2}.jsonl")), format!("{}\n", lines[0])).unwrap();
    let (code, out, err) = wisp(&dir, &repo, port, &["adopt", "--hook"], Some(&json!({ "session_id": sid2, "cwd": cwd }).to_string()));
    assert_eq!(code, 0, "{out}{err}");
    assert_eq!(api.cmd("runtime.list", json!({})).await.as_array().unwrap().len(), before + 1, "auto: adopted");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_same_session_is_adopted_once_and_the_pr_comes_from_gh() {
    let dir = temp("serve-history-once");
    let repo = std::fs::canonicalize(dir.join("proj")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    let cwd = repo.display().to_string();
    let store = dir.join("claude-cfg/projects").join(cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>());
    std::fs::create_dir_all(&store).unwrap();
    let sid = "6a2d3f2b-0000-4000-8000-00000000beef";
    let line = |role: &str, text: &str, at: &str| if role == "user" { json!({ "type": "user", "message": { "role": "user", "content": text }, "cwd": cwd, "timestamp": at }) } else { json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] }, "timestamp": at }) };
    let file = store.join(format!("{sid}.jsonl"));
    let write = |lines: &[Value]| std::fs::write(&file, lines.iter().map(|l| format!("{l}\n")).collect::<String>()).unwrap();
    let mut lines = vec![line("user", "rename it", "2026-11-08T10:00:00.000Z"), line("assistant", "Done.", "2026-11-08T10:00:05.000Z")];
    write(&lines);
    // gh: a PR whose head is the task's commit, and an unrelated one
    let bin = dir.join("ghbin");
    common::install_fakes(&bin, &["gh"]);
    let state = dir.join("gh-state.json");
    let (serve, port) = start_with(&dir, &[("CLAUDE_CONFIG_DIR", dir.join("claude-cfg").to_str().unwrap()), ("WISP_GH_BIN", bin.join("gh").to_str().unwrap()), ("FAKE_GH_STATE", state.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    assert_eq!(wisp(&dir, &repo, port, &["init"], None).0, 0);

    // the_same_session_is_adopted_once
    let adopt = || wisp(&dir, &repo, port, &["adopt", sid], None);
    let task_of = |out: &str| out.split_whitespace().skip_while(|w| *w != "task").nth(1).unwrap_or_default().to_owned();
    let (code, out, err) = adopt();
    assert_eq!(code, 0, "{out}{err}");
    let first = task_of(&out);
    let n = api.cmd("runtime.list", json!({})).await.as_array().unwrap().len();
    let (_, out, _) = adopt();
    assert_eq!(task_of(&out), first, "the same task");
    assert_eq!(api.cmd("runtime.list", json!({})).await.as_array().unwrap().len(), n, "no new one");
    // adopting_again_adds_only_new_turns
    lines.push(line("user", "and the docs", "2026-11-08T10:05:00.000Z"));
    lines.push(line("assistant", "Docs too.", "2026-11-08T10:05:09.000Z"));
    write(&lines);
    let (_, out, _) = adopt();
    assert_eq!(task_of(&out), first);
    let turns = api.turns(&first).await;
    assert_eq!((turns.len(), turns[1]["prompt"].clone()), (2, json!("and the docs")));
    // a_session_id_never_leaves_the_store
    let bad = api.try_cmd("runtime.adoptSession", json!({ "harness": "claude", "id": "../../etc/passwd" })).await;
    assert!(bad["ok"] == false && bad.to_string().contains("isn't a session id"), "{bad}");

    // track_finds_the_pr_through_gh
    git(&repo, &["commit", "-q", "--allow-empty", "-m", &format!("work\n\nWisp-Task: {}", &first[..12])]);
    let sha = git(&repo, &["rev-parse", "HEAD"]);
    std::fs::write(&state, json!({ "prs": { "7": { "number": 7, "url": "https://github.com/acme/app/pull/7", "headRefName": "other-branch", "headRefOid": "0000000000000000000000000000000000000000", "state": "OPEN" }, "8": { "number": 8, "url": "https://github.com/acme/app/pull/8", "headRefName": "wisp/rename", "headRefOid": sha, "state": "OPEN" } } }).to_string()).unwrap();
    let (code, out, err) = wisp(&dir, &repo, port, &["track", &first], None);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("https://github.com/acme/app/pull/8"), "{out}");
    // no_pr_when_nothing_matches: only an unrelated PR
    std::fs::write(&state, json!({ "prs": { "7": { "number": 7, "url": "https://github.com/acme/app/pull/7", "headRefName": "other-branch", "headRefOid": "0000000000000000000000000000000000000000", "state": "OPEN" } } }).to_string()).unwrap();
    let (_, out, _) = wisp(&dir, &repo, port, &["track", &first], None);
    assert!(!out.contains("/pull/"), "never a guess: {out}");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn offers_the_mark_resume_requests_and_injection() {
    let dir = temp("serve-history-ask");
    let repo = std::fs::canonicalize(dir.join("proj")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    let rec = dir.join("rec");
    std::fs::create_dir_all(&rec).unwrap();
    let env = [("FAKE_RECORD", rec.to_str().unwrap())];
    let (serve, port) = start_with(&dir, &env);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    assert_eq!(wisp(&dir, &repo, port, &["init"], None).0, 0);
    let run = async |prompt: &str| {
        let made = api.cmd("runtime.create", json!({ "prompt": prompt, "cwd": repo, "agent": "claude", "worktree": false })).await;
        let id = made["id"].as_str().unwrap().to_owned();
        api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
        id
    };
    let ext = async |id: &str| api.cmd("runtime.get", json!({ "id": id })).await["ext"]["wisp.history"].clone();

    // ask_mode_offers_then_saves
    let id = run("fix math.js TOPIC[Fix add]").await;
    api.cmd("runtime.setState", json!({ "id": id, "state": "done" })).await;
    until("offered", async || ext(&id).await["offer"] == true).await;
    assert!(task_files(&repo).iter().all(|f| !f.contains("tasks/2026")), "ask mode writes nothing by itself");
    let saved = api.cmd("history.save", json!({ "id": id })).await;
    assert!(saved["files"].to_string().contains(".task.yml"), "{saved}");
    // the_in_repo_mark_names_the_repo_and_files
    let mark = ext(&id).await;
    assert_eq!((mark["offer"].clone(), mark["tracked"]["store"].clone()), (json!(false), json!("files")), "{mark}");
    assert_eq!(mark["tracked"]["repo"], repo.display().to_string());

    // manual_mode_offers_nothing
    std::fs::write(repo.join(".wisp/wisp.yml"), "wisp: 1\nhistory: { track: manual }\n").unwrap();
    let other = run("write the notes").await;
    api.cmd("runtime.setState", json!({ "id": other, "state": "done" })).await;
    tokio::time::sleep(Duration::from_millis(800)).await;
    assert!(ext(&other).await.get("offer").is_none(), "{}", ext(&other).await);

    // a_resume_request_waits_for_the_user, and asking again doesn't make a second one
    let n = api.cmd("runtime.list", json!({})).await.as_array().unwrap().len();
    let r = api.cmd("history.resumeRequest", json!({ "id": id, "by": "an agent", "repo": repo })).await;
    assert_eq!(r["state"], "pending");
    assert_eq!(api.cmd("history.resumeRequest", json!({ "id": id, "repo": repo })).await["id"], r["id"]);
    assert_eq!(api.cmd("runtime.list", json!({})).await.as_array().unwrap().len(), n, "nothing started");
    // resume_requests_survive_a_restart
    serve.stop();
    let (serve, port) = start_with(&dir, &env);
    let api = Api { http: reqwest::Client::new(), port, n: 100.into() };
    let pending = api.cmd("history.requests", json!({})).await;
    assert_eq!(pending[0]["id"], r["id"], "{pending}");
    // a_denied_request_starts_nothing
    let denied = api.cmd("history.resumeAnswer", json!({ "request": r["id"], "approve": false })).await;
    assert_eq!(denied["state"], "denied");
    assert_eq!(api.cmd("runtime.list", json!({})).await.as_array().unwrap().len(), n);
    // an_approved_request_starts_once
    let again = api.cmd("history.resumeRequest", json!({ "id": id, "repo": repo })).await;
    let ok = api.cmd("history.resumeAnswer", json!({ "request": again["id"], "approve": true })).await;
    let started = ok["started"].as_str().unwrap().to_owned();
    assert_eq!(api.cmd("runtime.spec", json!({ "id": started })).await["lineage"]["forkOf"], id.as_str());
    let twice = api.try_cmd("history.resumeAnswer", json!({ "request": again["id"], "approve": true })).await;
    assert!(twice["ok"] == false && twice.to_string().contains("approved already"), "{twice}");

    // injection_is_off_by_default
    let argv = || common::record_text(&rec.join("claude.jsonl"));
    assert!(!argv().contains("Earlier tasks on these files"), "off by default");
    // injection_names_the_tasks_on_files_the_prompt_names (the saved task touched math.js)
    std::fs::write(repo.join(".wisp/wisp.yml"), "wisp: 1\nhistory: { track: manual, inject: true }\n").unwrap();
    std::fs::write(rec.join("claude.jsonl"), "").unwrap();
    let api2 = &api;
    let made = api2.cmd("runtime.create", json!({ "prompt": "make it faster", "cwd": repo, "agent": "claude", "worktree": false })).await;
    api2.until(made["id"].as_str().unwrap(), "ends", |t| t.last().is_some_and(ended)).await;
    assert!(!argv().contains("Earlier tasks on these files"), "a prompt naming no file gets nothing");
    let made = api2.cmd("runtime.create", json!({ "prompt": "the bug in math.js again", "cwd": repo, "agent": "claude", "worktree": false })).await;
    api2.until(made["id"].as_str().unwrap(), "ends", |t| t.last().is_some_and(ended)).await;
    assert!(argv().contains("Earlier tasks on these files") && argv().contains("Fix add"), "{}", &argv()[..argv().len().min(300)]);
    drop(serve);
}
