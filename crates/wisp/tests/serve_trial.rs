//! Try it two ways end to end (v1 #650, F-comp-31; ADR-0056), on the real binary with the fake claude: `runtime.trial`
//! starts two linked runs, each in a worktree of its own, run B with its one setting changed (the CLI really gets
//! `--disable-slash-commands`, or its subagent model in the env); both rows carry the link; Keep this marks one and
//! archives the other; a harness that can't run the change, Auto, Plan and a folder outside git are refused.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines)]

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;

use common::{Api, ended, records, start_with, temp, until_records};
use serde_json::{Value, json};

fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

fn repo(dir: &Path) -> PathBuf {
    let repo = std::fs::canonicalize(dir.join("proj")).unwrap();
    std::fs::write(repo.join("README.md"), "hi\n").unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    repo
}

fn refusal(v: &Value) -> String {
    v["error"]["message"].as_str().map_or_else(|| v.to_string(), str::to_owned)
}

#[tokio::test(flavor = "multi_thread")]
async fn try_it_two_ways_runs_one_task_twice_in_two_worktrees_with_one_setting_changed_and_keep_marks_one() {
    let dir = temp("serve-trial");
    let rec = dir.join("rec");
    let repo = repo(&dir);
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let task = json!({ "prompt": "fix it", "cwd": repo, "agent": "claude", "mode": "auto" });

    let made = api.cmd("runtime.trial", json!({ "task": task, "vary": { "skills": "off" } })).await;
    let runs: Vec<String> = made["runs"].as_array().unwrap().iter().map(|r| r["id"].as_str().unwrap().to_owned()).collect();
    assert_eq!(runs.len(), 2, "{made}");
    assert_eq!(made["differs"], json!([{ "key": "skills", "values": ["on", "off"] }]));
    for id in &runs {
        api.until(id, "its first turn ends", |t| t.last().is_some_and(ended)).await;
    }
    let recs = until_records(&rec.join("claude.jsonl"), "both runs", |r| r.len() >= 2).await;
    let argv_has = |r: &Value, f: &str| r["argv"].as_array().unwrap().iter().any(|a| a == f);
    let (a, b) = (api.cmd("runtime.get", json!({ "id": runs[0] })).await, api.cmd("runtime.get", json!({ "id": runs[1] })).await);
    let (wa, wb) = (a["ext"]["wisp.worktrees"]["path"].as_str().unwrap(), b["ext"]["wisp.worktrees"]["path"].as_str().unwrap());
    assert!(wa != wb && wa != repo.display().to_string() && wb != repo.display().to_string(), "a worktree each: {wa} {wb}");
    // the recorded folder may be the canonical one (/private/var on macOS): match on the worktree's own name
    let ran_in = |p: &str| {
        let name = Path::new(p).file_name().unwrap().to_str().unwrap().to_owned();
        recs.iter()
            .find(|r| r["cwd"].as_str().is_some_and(|c| c.contains(&name)))
            .cloned()
            .unwrap_or_else(|| panic!("no run in {p}: {recs:?}"))
    };
    assert!(!argv_has(&ran_in(wa), "--disable-slash-commands"), "run A as given");
    assert!(argv_has(&ran_in(wb), "--disable-slash-commands"), "run B without its skills: {}", ran_in(wb));

    // both rows carry the link (the list's summary) and run B its variant; one group, so Compare runs shows them
    let list = api.cmd("runtime.list", json!({})).await;
    let rows: Vec<&Value> = list.as_array().unwrap().iter().filter(|r| runs.iter().any(|id| r["id"] == json!(id))).collect();
    assert_eq!(rows.len(), 2, "{list}");
    // runtime.list answers summaries, plugin fields flattened in (the synced row nests them under `summary`)
    for s in &rows {
        assert_eq!(s["trial"]["runs"], json!(runs), "{s}");
        assert_eq!(s["trial"]["differs"], made["differs"]);
        assert_eq!(s["groupId"], made["group"]);
    }
    let row_b = rows.iter().find(|r| r["id"] == json!(runs[1])).unwrap();
    assert_eq!(row_b["variant"], json!({ "skills": "off" }));
    assert_eq!(row_b["trial"]["run"], 1);

    // Keep this: both say run B was kept, run A is archived
    api.cmd("runtime.trial.keep", json!({ "id": runs[1] })).await;
    let (a, b) = (api.cmd("runtime.get", json!({ "id": runs[0] })).await, api.cmd("runtime.get", json!({ "id": runs[1] })).await);
    assert_eq!(a["ext"]["wisp.runtime"]["trial"]["kept"], json!(runs[1]));
    assert_eq!(b["ext"]["wisp.runtime"]["trial"]["kept"], json!(runs[1]));
    assert_eq!((a["archived"].as_bool(), b["archived"].as_bool().unwrap_or(false)), (Some(true), false), "{a}");

    // subagents on Haiku: the CLI gets it in its env
    let sub = api.cmd("runtime.trial", json!({ "task": task, "vary": { "subagentModel": "haiku" } })).await;
    let b2 = sub["runs"][1]["id"].as_str().unwrap().to_owned();
    api.until(&b2, "run B ends", |t| t.last().is_some_and(ended)).await;
    let recs = until_records(&rec.join("claude.jsonl"), "four runs", |r| r.len() >= 4).await;
    assert!(recs.iter().any(|r| r["subagentModel"] == "haiku"), "{recs:?}");

    // refused, and nothing starts: another harness, Auto, Plan, the same setup twice, a folder outside git
    let before = records(&rec.join("claude.jsonl")).len();
    let codex = api
        .try_cmd("runtime.trial", json!({ "task": { "prompt": "x", "cwd": repo, "agent": "codex" }, "vary": { "skills": "off" } }))
        .await;
    assert!(refusal(&codex).contains("can't run with its skills off"), "{codex}");
    let auto =
        api.try_cmd("runtime.trial", json!({ "task": { "prompt": "x", "cwd": repo, "agent": "auto" }, "vary": { "skills": "off" } })).await;
    assert!(refusal(&auto).contains("Pick a harness first"), "{auto}");
    let plan = api
        .try_cmd(
            "runtime.trial",
            json!({ "task": { "prompt": "x", "cwd": repo, "agent": "claude", "mode": "plan" }, "vary": { "skills": "off" } }),
        )
        .await;
    assert!(refusal(&plan).contains("Plan"), "{plan}");
    let same = api.try_cmd("runtime.trial", json!({ "task": task, "vary": { "skills": "on" } })).await;
    assert!(refusal(&same).contains("same as run A"), "{same}");
    let loose = dir.join("loose");
    std::fs::create_dir_all(&loose).unwrap();
    let outside = api
        .try_cmd("runtime.trial", json!({ "task": { "prompt": "x", "cwd": loose, "agent": "claude" }, "vary": { "skills": "off" } }))
        .await;
    assert!(refusal(&outside).contains("project in git"), "{outside}");
    // runtime.create refuses a variant the same way (the CLI, an agent, a formula all go through it)
    let one = api.try_cmd("runtime.create", json!({ "prompt": "x", "cwd": repo, "agent": "codex", "subagentModel": "haiku" })).await;
    assert!(refusal(&one).contains("can't run its subagents"), "{one}");
    assert_eq!(records(&rec.join("claude.jsonl")).len(), before, "no refused trial ran");
    drop(serve);
}
