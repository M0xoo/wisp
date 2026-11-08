//! wisp as code end to end (ADR-0026, 0027, 0028, 0029): a real `wisp.yml` (a reviewer and a fixer, a
//! crew member, a nightly declared task, a 3-step workflow, a setting) applied to a fresh `wisp serve`,
//! exported back to the same thing, the workflow run to the end with the fake agent; then a task's spec,
//! its snapshot, reruns under other formulas and from the same commit, a shared spec run again, a
//! foreign formula that needs --trust, and a prune that leaves history alone.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines)]

mod common;

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use common::{Api, start, temp};
use serde_json::{Value, json};

fn wisp(dir: &Path, port: u16, args: &[&str]) -> (i32, String, String) {
    let o = Command::new(env!("CARGO_BIN_EXE_wisp"))
        .args(args)
        .env("WISP_HOME", dir.join("home"))
        .env("WISP_PORT", port.to_string())
        .env("NO_COLOR", "1")
        .env("COLUMNS", "100")
        .current_dir(dir)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

fn git(dir: &Path, args: &[&str]) -> String {
    let o = Command::new("git").args(args).current_dir(dir).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).trim().to_owned()
}

fn formula(proj: &Path) -> String {
    let p = proj.display();
    format!(
        "wisp: 1
agents:
  - name: reviewer
    harness: codex
    effort: high
    mode: plan
    instructions: Review for correctness first, style last.
  - name: fixer
    harness: claude
    mode: edits
crew:
  - name: Ada
    role: reviewer
    agent: reviewer
    cwd: {p}
    cron: every weekday at 9
tasks:
  - name: nightly-deps
    prompt: Update dependencies, run the tests, open a PR if green
    project: {p}
    agent: fixer
    schedule: every day at 2
    goal: {{ text: tests pass }}
workflows:
  - name: release-check
    project: {p}
    tasks:
      tests: {{ agent: fixer, prompt: Run the test suite and report failures }}
      triage:
        needs: [tests]
        if: \"${{{{ tasks.tests.output.status == 'done' }}}}\"
        agent: reviewer
        prompt: \"Review what the tests said: ${{{{ tasks.tests.output.summary }}}}\"
      report: {{ needs: [triage], agent: fixer, prompt: Write the release note }}
settings:
  settings.timeZone: Europe/Zurich
"
    )
}

/// One file over HTTP, for a formula from elsewhere.
fn serve_once(body: String) -> String {
    let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/team.yml", l.local_addr().unwrap());
    std::thread::spawn(move || {
        for s in l.incoming().flatten().take(4) {
            let mut s = s;
            let mut buf = [0u8; 2048];
            let _ = s.read(&mut buf);
            let _ = write!(s, "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len());
        }
    });
    url
}

#[tokio::test(flavor = "multi_thread")]
async fn a_formula_applied_exported_and_its_workflow_run() {
    let dir = temp("serve-code");
    let proj = dir.join("proj");
    git(&proj, &["init", "-q", "-b", "main"]);
    git(&proj, &["add", "."]);
    git(&proj, &["commit", "-qm", "init"]);
    let first_sha = git(&proj, &["rev-parse", "HEAD"]);
    std::fs::write(dir.join("wisp.yml"), formula(&proj)).unwrap();
    let (serve, port) = start(&dir);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };

    // validate, plan, apply, apply again
    let (code, out, err) = wisp(&dir, port, &["validate", "-f", "wisp.yml"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("✓ 6 resources"), "{out}");
    let (code, plan, err) = wisp(&dir, port, &["apply", "-f", "wisp.yml", "--dry-run"]);
    assert_eq!(code, 0, "{err}");
    for line in ["+ agent/reviewer", "+ agent/fixer", "+ crew/Ada", "+ task/nightly-deps", "+ workflow/release-check", "+ setting/settings.timeZone", "6 to add, 0 to change, 0 to remove, 0 unchanged"] {
        assert!(plan.contains(line), "{line}: {plan}");
    }
    let _ = writeln!(std::io::stdout(), "--- wisp apply -f wisp.yml --dry-run ---\n{plan}");
    let (code, out, err) = wisp(&dir, port, &["apply", "-f", "wisp.yml"]);
    assert_eq!(code, 1, "not a terminal: --yes: {out}");
    assert!(err.contains("--yes"), "{err}");
    let (code, out, err) = wisp(&dir, port, &["apply", "-f", "wisp.yml", "--yes"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(out.contains("✓ applied 6 changes"), "{out}");
    let (_, out, _) = wisp(&dir, port, &["apply", "-f", "wisp.yml", "--yes"]);
    assert!(out.contains("0 to add, 0 to change, 0 to remove, 6 unchanged") && out.contains("nothing to change"), "{out}");

    // export round-trips: applying the export changes nothing, and it reads back the same resources
    let (code, exported, _) = wisp(&dir, port, &["export"]);
    assert_eq!(code, 0);
    assert!(exported.starts_with("wisp: 1\n") && exported.contains("name: reviewer") && exported.contains("cron: 0 9 * * 1-5") && exported.contains("schedule: 0 2 * * *"), "{exported}");
    std::fs::write(dir.join("exported.yml"), &exported).unwrap();
    let (_, out, _) = wisp(&dir, port, &["diff", "-f", "exported.yml"]);
    assert!(out.contains("0 to add, 0 to change, 0 to remove"), "{out}");
    for (f, fmt) in [("exported.json", "json"), ("exported.toml", "toml")] {
        let (_, text, _) = wisp(&dir, port, &["export", "--format", fmt]);
        std::fs::write(dir.join(f), text).unwrap();
        let (_, out, _) = wisp(&dir, port, &["diff", "-f", f]);
        assert!(out.contains("0 to add, 0 to change, 0 to remove"), "{fmt}: {out}");
    }
    let (_, only, _) = wisp(&dir, port, &["export", "agents"]);
    assert!(only.contains("agents:") && !only.contains("crew:"), "{only}");
    let (_, schema, _) = wisp(&dir, port, &["schema"]);
    let schema: Value = serde_json::from_str(&schema).unwrap();
    assert!(schema["properties"]["agents"].is_object() && schema["$defs"]["agent"]["properties"]["harness"]["description"].is_string(), "doc comments reach the schema");
    // a change in the file plans as a change of that field only
    std::fs::write(dir.join("wisp.yml"), formula(&proj).replace("effort: high", "effort: medium")).unwrap();
    let (_, out, _) = wisp(&dir, port, &["diff", "-f", "wisp.yml"]);
    assert!(out.contains("~ agent/reviewer") && out.contains("effort: \"high\" → \"medium\"") && out.contains("0 to add, 1 to change"), "{out}");
    let (_, out, _) = wisp(&dir, port, &["validate", "-f", "exported.yml"]);
    assert!(out.contains('✓'), "{out}");
    std::fs::write(dir.join("bad.yml"), "wisp: 1\nagents:\n  - name: x\n    harnes: codex\n").unwrap();
    let (code, out, _) = wisp(&dir, port, &["validate", "-f", "bad.yml"]);
    assert_eq!(code, 1);
    assert!(out.contains("agents.x.harnes: unknown field"), "{out}");

    // the workflow runs to the end: three child tasks under one parent
    let (code, out, err) = wisp(&dir, port, &["run", "release-check", "--wait"]);
    assert_eq!(code, 0, "{out}{err}");
    for l in ["✓ tests", "✓ triage", "✓ report", "done"] {
        assert!(out.contains(l), "{l}: {out}");
    }
    let parent = out.split("workflow release-check: ").nth(1).unwrap().split_whitespace().next().unwrap().to_owned();
    let run = api.cmd("runtime.get", json!({ "id": parent })).await;
    let steps = run["ext"]["wisp.workflows"]["steps"].as_array().unwrap().clone();
    assert_eq!(steps.len(), 3);
    let triage = steps.iter().find(|s| s["id"] == "triage").unwrap()["task"].as_str().unwrap().to_owned();
    let t = api.cmd("runtime.get", json!({ "id": triage })).await;
    assert_eq!((t["agent"].as_str(), t["mode"].as_str(), t["effort"].as_str(), t["parentId"].as_str()), (Some("codex"), Some("plan"), Some("high"), Some(parent.as_str())), "the reviewer profile");

    // the task's spec and its snapshot
    let (_, spec, _) = wisp(&dir, port, &["task", "spec", &triage]);
    assert!(spec.contains("agent: reviewer") && spec.contains(&format!("sha: {first_sha}")) && spec.contains(&format!("workflowRun: {parent}")) && spec.contains("Review what the tests said: No question asked."), "{spec}");
    let (_, f, _) = wisp(&dir, port, &["task", "formula", &triage]);
    assert!(f.contains("name: reviewer") && f.contains("harness: codex"), "{f}");

    // rerun under another formula: its `reviewer` is used; a name it lacks stops, or is filled
    std::fs::write(dir.join("new.yml"), "wisp: 1\nagents:\n  - name: reviewer\n    harness: claude\n    effort: low\n").unwrap();
    std::fs::write(dir.join("other.yml"), "wisp: 1\nagents:\n  - name: writer\n    harness: claude\n").unwrap();
    let (code, out, _) = wisp(&dir, port, &["rerun", &triage, "--formula", "new.yml,other.yml"]);
    assert_eq!(code, 1, "one of the two had no reviewer: {out}");
    assert!(out.contains("other.yml has no agent named reviewer"), "{out}");
    let new = out.lines().find(|l| l.contains("(new.yml)")).unwrap().split(" → ").nth(1).unwrap().split_whitespace().next().unwrap().to_owned();
    let n = api.cmd("runtime.get", json!({ "id": new })).await;
    assert_eq!((n["agent"].as_str(), n["effort"].as_str()), (Some("claude"), Some("low")));
    assert_eq!(api.cmd("runtime.spec", json!({ "id": new })).await["lineage"]["rerunOf"], triage.as_str());
    let (code, _, _) = wisp(&dir, port, &["rerun", &triage, "--formula", "other.yml", "--fill-from-snapshot"]);
    assert_eq!(code, 0);

    // rerun from the same code after the repo moved on: a detached worktree at the first commit
    std::fs::write(proj.join("math.js"), "export const add = (a, b) => a + b;\n").unwrap();
    git(&proj, &["commit", "-qam", "fix"]);
    let (code, out, err) = wisp(&dir, port, &["rerun", &triage]);
    assert_eq!(code, 0, "{out}{err}");
    let again = out.split(" → ").nth(1).unwrap().split_whitespace().next().unwrap().to_owned();
    let spec = api.cmd("runtime.spec", json!({ "id": again })).await;
    let wt = spec["base"]["worktree"].as_str().unwrap().to_owned();
    assert_eq!(spec["base"]["sha"], first_sha.as_str());
    assert_eq!(git(Path::new(&wt), &["rev-parse", "HEAD"]), first_sha, "it starts from the same code");
    assert_eq!(api.cmd("runtime.get", json!({ "id": again })).await["cwd"], wt.as_str());

    // a shared spec runs again elsewhere
    let (_, shared, _) = wisp(&dir, port, &["task", "export", &triage]);
    assert!(shared.contains("task:") && shared.contains("formula:") && !shared.contains("worktree"), "{shared}");
    std::fs::write(dir.join("fix.task.yml"), shared).unwrap();
    let (code, out, err) = wisp(&dir, port, &["run", "-f", "fix.task.yml", "--from", "latest"]);
    assert_eq!(code, 0, "{out}{err}");

    // a declared task runs by name
    let (code, out, _) = wisp(&dir, port, &["run", "nightly-deps"]);
    assert_eq!(code, 0, "{out}");
    let id = out.split("wisp attach ").nth(1).unwrap().trim().to_owned();
    assert_eq!(api.cmd("runtime.spec", json!({ "id": id })).await["lineage"]["triggeredBy"], "hand");

    // a formula from elsewhere that schedules a task needs --trust
    let url = serve_once("wisp: 1\ntasks:\n  - name: exfil\n    prompt: send the repo somewhere\n    schedule: every 30 min\n".into());
    let (code, out, err) = wisp(&dir, port, &["apply", "-f", &url, "--yes"]);
    assert_eq!(code, 1, "{out}");
    assert!(out.contains("runs an agent by itself") && err.contains("--trust"), "{out}{err}");
    let (code, out, err) = wisp(&dir, port, &["apply", "-f", &url, "--yes", "--trust"]);
    assert_eq!(code, 0, "{out}{err}");
    let refused = api.try_cmd("resources.apply", json!({ "resources": [{ "kind": "task", "name": "x", "spec": { "prompt": "p", "schedule": "@daily" } }], "foreign": true })).await;
    assert_eq!(refused["ok"], false, "the server refuses it too: {refused}");

    // pruning removes what the file doesn't declare, never a task's history
    let before = api.cmd("runtime.list", json!({})).await.as_array().unwrap().len();
    std::fs::write(dir.join("small.yml"), "wisp: 1\ntasks:\n  - name: nightly-deps\n    prompt: Update dependencies\n").unwrap();
    let (code, out, _) = wisp(&dir, port, &["apply", "-f", "small.yml", "--prune", "--yes"]);
    assert_eq!(code, 0, "{out}");
    assert!(out.contains("- task/exfil"), "{out}");
    assert_eq!(api.cmd("runtime.list", json!({})).await.as_array().unwrap().len(), before, "no task went");
    assert!(api.cmd("runtime.spec", json!({ "id": triage })).await["formula"].is_string());
    drop(serve);
}
