//! `wisp open <task>` (ADR-0033, Open in), end to end: the command line it would run (`--print`), resuming
//! a task's own session in its CLI and adopting back what was done there, `--no-adopt`, a continuation in
//! another harness, an unknown task, a task from the repo whose native log is restored on another wisp, and
//! a task whose folder is gone opening at its base commit.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines)]

mod common;

use std::path::Path;
use std::process::{Command, Stdio};

use common::{Api, ended, start_with, temp};
use serde_json::{Value, json};

fn wisp(dir: &Path, home: &str, cwd: &Path, port: u16, args: &[&str], env: &[(&str, &str)]) -> (i32, String, String) {
    let o = Command::new(env!("CARGO_BIN_EXE_wisp"))
        .args(args)
        .env("WISP_HOME", dir.join(home))
        .env("WISP_PORT", port.to_string())
        .env("NO_COLOR", "1")
        .env("CLAUDE_CONFIG_DIR", dir.join("claude-cfg"))
        .envs(env.iter().copied())
        .current_dir(cwd)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

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

fn user(text: &str, at: &str) -> Value {
    json!({ "type": "user", "message": { "role": "user", "content": text }, "timestamp": at })
}

fn said(text: &str, at: &str) -> Value {
    json!({ "type": "assistant", "message": { "role": "assistant", "content": [{ "type": "text", "text": text }] }, "timestamp": at })
}

#[tokio::test(flavor = "multi_thread")]
async fn open_resumes_restores_continues_and_adopts_back() {
    let dir = temp("serve-open");
    let repo = std::fs::canonicalize(dir.join("proj")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    let cwd = repo.display().to_string();
    let store =
        dir.join("claude-cfg/projects").join(cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>());
    std::fs::create_dir_all(&store).unwrap();
    // the interactive CLI: says how it was run, and (resumed) adds a turn to its session log, as Claude Code does
    let log = dir.join("cli.log");
    let script = dir.join("claude-cli");
    let turn = format!("{}\n{}", user("one more from the CLI", "2026-11-09T10:00:00.000Z"), said("Did it.", "2026-11-09T10:00:05.000Z"));
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\necho \"$@\" >> '{}'\nif [ \"$1\" = \"--resume\" ]; then printf '%s\\n' '{}' >> \"$STORE/$2.jsonl\"; fi\n",
            log.display(),
            turn.replace('\'', "'\\''")
        ),
    )
    .unwrap();
    #[cfg(unix)]
    std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
    let cli: Vec<(&str, &str)> = vec![
        ("WISP_CLAUDE_BIN", script.to_str().unwrap()),
        ("WISP_CODEX_BIN", script.to_str().unwrap()),
        ("STORE", store.to_str().unwrap()),
    ];
    let cfg = dir.join("claude-cfg");
    let (serve, port) = start_with(&dir, &[("CLAUDE_CONFIG_DIR", cfg.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    assert_eq!(wisp(&dir, "home", &repo, port, &["init"], &[]).0, 0);

    let made = api
        .cmd("runtime.create", json!({ "prompt": "fix the add bug TOPIC[Fix add]", "cwd": repo, "agent": "claude", "worktree": false }))
        .await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
    let sid = api.cmd("runtime.get", json!({ "id": id })).await["resumeId"].as_str().unwrap().to_owned();
    // Claude Code keeps the run's session log (wisp's run was a Claude Code session)
    std::fs::write(
        store.join(format!("{sid}.jsonl")),
        format!("{}\n{}\n", user("fix the add bug", "2026-11-09T09:00:00.000Z"), said("Fixed.", "2026-11-09T09:00:05.000Z")),
    )
    .unwrap();

    // open_print_gives_the_command_line
    let (code, out, err) = wisp(&dir, "home", &repo, port, &["open", &id, "--print"], &cli);
    assert_eq!(code, 0, "{out}{err}");
    let plan: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(
        (plan["how"].clone(), plan["args"].clone(), plan["cwd"].clone()),
        (json!("resume"), json!(["--resume", sid]), json!(cwd)),
        "{plan}"
    );
    assert!(!log.exists(), "--print runs nothing");

    // open_resumes_its_own_session, open_adopts_back_after
    let (code, out, err) = wisp(&dir, "home", &repo, port, &["open", &id], &cli);
    assert_eq!(code, 0, "{out}{err}");
    assert_eq!(std::fs::read_to_string(&log).unwrap().trim(), format!("--resume {sid}"));
    let turns = api.turns(&id).await;
    assert_eq!((turns.len(), turns[1]["prompt"].clone()), (2, json!("one more from the CLI")), "back in the same task");
    // open_no_adopt_leaves_it
    let (code, _, _) = wisp(&dir, "home", &repo, port, &["open", &id, "--no-adopt"], &cli);
    assert_eq!(code, 0);
    assert_eq!(api.turns(&id).await.len(), 2, "not adopted");

    // open_in_another_harness_primes_a_continuation
    let (_, out, _) = wisp(&dir, "home", &repo, port, &["open", &id, "--in", "codex", "--print"], &cli);
    let plan: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(plan["how"], "continue");
    let prime = plan["args"][0].as_str().unwrap();
    assert!(
        prime.contains("You are continuing a task")
            && prime.contains("Fix add")
            && plan["note"].as_str().unwrap().contains("not the same session"),
        "{plan}"
    );

    // open_an_unknown_task_says_so
    let (code, _, err) = wisp(&dir, "home", &repo, port, &["open", "zzzzzzzz9"], &cli);
    assert_eq!(code, 1);
    assert!(err.contains("no task zzzzzzzz9"), "{err}");

    // open_restores_the_native_log_for_a_repo_task: tracked (with its native log), then opened on another
    // wisp, where Claude Code doesn't have it
    let (code, out, err) = wisp(&dir, "home", &repo, port, &["track", &id], &[]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(repo.join(format!(".wisp/history/{id}.native.jsonl.zst")).is_file(), "{out}");
    std::fs::remove_file(store.join(format!("{sid}.jsonl"))).unwrap();
    serve.stop();
    let other = temp("serve-open-other");
    let (serve, port) = start_with(&other, &[("CLAUDE_CONFIG_DIR", cfg.to_str().unwrap())]);
    let (code, out, err) =
        wisp(&other, "home", &repo, port, &["open", &id[..12], "--print"], &[("CLAUDE_CONFIG_DIR", cfg.to_str().unwrap())]);
    assert_eq!(code, 0, "{out}{err}");
    let plan: Value = serde_json::from_str(&out).unwrap();
    assert_eq!((plan["how"].clone(), plan["args"].clone()), (json!("restore"), json!(["--resume", sid])), "{plan}");
    let back = std::fs::read_to_string(store.join(format!("{sid}.jsonl"))).unwrap();
    assert!(back.contains("one more from the CLI"), "the log as it was: {back}");
    drop(serve);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_gone_opens_at_its_base() {
    let dir = temp("serve-open-base");
    let repo = std::fs::canonicalize(dir.join("proj")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let made = api.cmd("runtime.create", json!({ "prompt": "fix it", "cwd": repo, "agent": "claude", "worktree": true })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
    let tree = api.cmd("runtime.get", json!({ "id": id })).await["cwd"].as_str().unwrap().to_owned();
    assert_ne!(tree, repo.display().to_string(), "it ran in a worktree");
    std::fs::remove_dir_all(&tree).unwrap();
    let (code, out, err) = wisp(&dir, "home", &repo, port, &["open", &id, "--print"], &[]);
    assert_eq!(code, 0, "{out}{err}");
    let plan: Value = serde_json::from_str(&out).unwrap_or_else(|e| panic!("{e}: {out}"));
    let at = plan["cwd"].as_str().unwrap();
    assert!(at.contains("wisp-open-") && Path::new(at).join("math.js").is_file(), "a fresh worktree at the base: {plan}");
    drop(serve);
}
