//! A stand-in for the claude / codex / … CLIs (port of the core of v1 test/fixtures/fake-agent.mjs).
//! The CLI it plays comes from its file name (link it as `claude`, `codex`, …). It speaks each one's
//! stream format, edits `math.js` for real (`a - b` → `a + b`) and ends with a wisp block.
//!
//!   `FAKE_RECORD`      directory; each run appends {argv, stdin, cwd, pid} to `<name>.jsonl`
//!   `FAKE_HANG=1`      stop after the first events and wait to be killed
//!   `FAKE_FAIL=1`      exit 1 with an error on stderr, no result
//!   `FAKE_LIMIT_ONCE`  a file: the first run with a prompt hits a usage limit (stderr, exit 1); later runs work
//!   `FAKE_DELAY` / `FAKE_LINGER`  ms to wait before answering / after the result
//!   `FAKE_REPLAY`      claude: print this .jsonl as its stream and exit (a recorded run)
//!   `FAKE_CLI_VERSION` what --version says (9.9.9); `FAKE_AUTH_PROFILE`, `FAKE_AUTH_FAIL` for `auth status --text`
//!   TOPIC[…] in the prompt: the hero names it
#![allow(clippy::print_stdout, clippy::unwrap_used, clippy::expect_used)]
use std::io::{Read, Write};
use std::path::Path;

use serde_json::{Value, json};

/// A run: it was given a prompt. A harness's detect probe (`models`, `--help`, `auth list`) has none, runs in
/// the server's folder, and must never edit a file there (it left math.js and notes.txt in crates/wisp).
static RUN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn edit(path: &Path, text: &str) {
    if RUN.load(std::sync::atomic::Ordering::Relaxed) {
        let _ = std::fs::write(path, text);
    }
}

fn out(v: &Value) {
    println!("{v}");
    let _ = std::io::stdout().flush();
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

fn wait_ms(k: &str) {
    if let Some(ms) = env(k).and_then(|v| v.parse::<u64>().ok()) {
        std::thread::sleep(std::time::Duration::from_millis(ms));
    }
}

fn hang() -> ! {
    loop {
        std::thread::sleep(std::time::Duration::from_secs(3600));
    }
}

fn final_text(name: &str, prompt: &str) -> String {
    let mut hero = json!({ "type": "hero", "title": format!("Fake {name} finished"), "summary": "No question asked.", "status": "done" });
    if let Some(t) = prompt
        .split_once("TOPIC[")
        .and_then(|(_, r)| r.split_once(']'))
        .map(|(t, _)| t)
    {
        hero["topic"] = Value::from(t);
    }
    format!("All done.\n```wisp\n{}\n```", json!({ "blocks": [hero] }))
}

/// `--version`, sign-in checks and sign-out: answered without a run.
fn meta(name: &str, argv: &[String]) -> Option<i32> {
    let joined = argv.join(" ");
    if matches!(argv.first().map(String::as_str), Some("--version" | "-v")) {
        let v = env("FAKE_CLI_VERSION").unwrap_or_else(|| "9.9.9".into());
        let line = match name {
            "claude" => format!("{v} (Fake Claude Code)"),
            "codex" => format!("fake-codex {v}"),
            _ => format!("fake-{name} 9.9.9"),
        };
        println!("{line}");
        return Some(0);
    }
    if name == "codex" && joined == "login --device-auth" {
        // v1 agent-login: a link and a one-time code, then signed in
        println!("Open https://auth.example.dev/codex/device\nand enter this one-time code ABCD-12345");
        let _ = std::io::stdout().flush();
        wait_ms("FAKE_LOGIN_MS");
        if let Some(home) = env("CODEX_HOME") {
            let _ = std::fs::create_dir_all(&home);
            let _ = std::fs::write(Path::new(&home).join("auth.json"), "{}");
        }
        return Some(0);
    }
    if name == "codex" && joined == "login status" {
        let signed = env("CODEX_HOME").is_some_and(|h| Path::new(&h).join("auth.json").is_file());
        println!("{}", if signed { "Logged in using ChatGPT" } else { "Not logged in" });
        return Some(i32::from(!signed));
    }
    if name == "codex" && joined == "app-server" {
        // the usage read Codex's own status line does (v1 live-limits.js)
        let mut input = String::new();
        let _ = std::io::stdin().read_to_string(&mut input);
        for line in input.lines() {
            let Ok(m) = serde_json::from_str::<Value>(line) else { continue };
            match m["id"].as_i64() {
                Some(1) => out(&json!({ "id": 1, "result": {} })),
                Some(2) => out(&json!({ "id": 2, "result": { "rateLimits": { "primary": { "usedPercent": 42, "windowDurationMins": 300, "resetsAt": 1_900_000_000 } } } })),
                _ => {}
            }
        }
        return Some(0);
    }
    if name == "codex" && joined == "debug models" {
        // no catalog: detect falls back to $CODEX_HOME/models_cache.json
        return Some(1);
    }
    if name == "claude" && joined == "auth status --text" {
        if env("FAKE_AUTH_FAIL").is_some() {
            eprintln!("Error: could not read the sign-in");
            return Some(1);
        }
        println!("Login method: Claude Max Account");
        if let Some(p) = env("FAKE_AUTH_PROFILE") {
            println!("Profile: {p}");
        }
        return Some(0);
    }
    [
        "auth status",
        "auth logout",
        "login status",
        "logout",
        "status",
    ]
    .contains(&joined.as_str())
    .then_some(0)
}

fn record(name: &str, argv: &[String], prompt: &str) {
    let Some(dir) = env("FAKE_RECORD") else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    let line = json!({ "argv": argv, "stdin": prompt, "cwd": std::env::current_dir().ok(), "pid": std::process::id(), "codexHome": env("CODEX_HOME") });
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(Path::new(&dir).join(format!("{name}.jsonl")))
    {
        // one write per line: `writeln!` may split a long argv line, and a reader would see half of it
        let _ = f.write_all(format!("{line}\n").as_bytes());
    }
}

fn claude(prompt: &str, target: &Path, before: &str, after: &str) {
    let s = "claude-session-1";
    if let Some(f) = env("FAKE_REPLAY") {
        print!("{}", std::fs::read_to_string(f).unwrap_or_default());
        return;
    }
    let t = target.display().to_string();
    out(
        &json!({ "type": "system", "subtype": "init", "session_id": s, "claude_code_version": env("FAKE_CLI_VERSION").unwrap_or_else(|| "9.9.9".into()), "apiKeySource": "none" }),
    );
    out(
        &json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "t1", "name": "Read", "input": { "file_path": t } }] } }),
    );
    if env("FAKE_HANG").is_some() {
        hang();
    }
    out(
        &json!({ "type": "user", "session_id": s, "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": [{ "type": "text", "text": before }] }] } }),
    );
    out(
        &json!({ "type": "assistant", "session_id": s, "message": { "content": [{ "type": "tool_use", "id": "t2", "name": "Edit", "input": { "file_path": t, "old_string": "a - b", "new_string": "a + b" } }] } }),
    );
    // as a real Edit: no change, no write
    if after != before {
        edit(target, after);
    }
    out(
        &json!({ "type": "result", "subtype": "success", "is_error": false, "result": final_text("claude", prompt), "session_id": s, "duration_ms": 5, "num_turns": 1, "total_cost_usd": 0.01, "usage": { "input_tokens": 10, "output_tokens": 5 } }),
    );
}

fn codex(prompt: &str, target: &Path, after: &str) {
    out(&json!({ "type": "thread.started", "thread_id": "codex-session-1" }));
    out(&json!({ "type": "turn.started" }));
    out(
        &json!({ "type": "item.started", "item": { "id": "i0", "type": "command_execution", "command": "/bin/bash -lc 'npm test'", "status": "in_progress" } }),
    );
    if env("FAKE_HANG").is_some() {
        hang();
    }
    out(
        &json!({ "type": "item.completed", "item": { "id": "i0", "type": "command_execution", "command": "npm test", "exit_code": 1, "aggregated_output": "1 failing", "status": "failed" } }),
    );
    edit(target, after);
    let cwd = target.parent().unwrap_or(Path::new("."));
    edit(&cwd.join("notes.txt"), "new file\n");
    out(
        &json!({ "type": "item.completed", "item": { "id": "i1", "type": "file_change", "changes": [{ "path": target, "kind": "update" }, { "path": "notes.txt", "kind": "add" }], "status": "completed" } }),
    );
    out(
        &json!({ "type": "item.completed", "item": { "id": "i2", "type": "agent_message", "text": final_text("codex", prompt) } }),
    );
    out(
        &json!({ "type": "turn.completed", "usage": { "input_tokens": 10, "cached_input_tokens": 0, "output_tokens": 5 } }),
    );
}

/// Each other CLI's recorded turn (the G6 fixtures), with this run's folder and answer.
fn recorded(name: &str) -> Option<&'static str> {
    Some(match name {
        "opencode" => include_str!("../../../plugins/opencode/core/tests/fixtures/turn.jsonl"),
        "cursor-agent" => include_str!("../../../plugins/cursor/core/tests/fixtures/turn.jsonl"),
        "copilot" => include_str!("../../../plugins/copilot/core/tests/fixtures/turn.jsonl"),
        "grok" => include_str!("../../../plugins/grok/core/tests/fixtures/turn.jsonl"),
        "agy" => include_str!("../../../plugins/antigravity/core/tests/fixtures/turn.jsonl"),
        _ => return None,
    })
}

/// Strings in a recorded line: the folder is this run's, the answer names this prompt's topic.
fn fill(v: &mut Value, cwd: &str, answer: &str) {
    match v {
        Value::String(s) if s.starts_with("All done.\n```wisp") => answer.clone_into(s),
        Value::String(s) => *s = s.replace("@CWD@", cwd),
        Value::Array(a) => a.iter_mut().for_each(|x| fill(x, cwd, answer)),
        Value::Object(o) => o.values_mut().for_each(|x| fill(x, cwd, answer)),
        _ => {}
    }
}

fn replay_turn(name: &str, stream: &str, prompt: &str, target: &Path, after: &str) {
    let cwd = target.parent().unwrap_or(Path::new("."));
    edit(target, after);
    edit(&cwd.join("notes.txt"), "new file\n");
    let short = name.split('-').next().unwrap_or(name);
    let answer = final_text(short, prompt);
    for (i, line) in stream.lines().enumerate() {
        if i == 2 && env("FAKE_HANG").is_some() {
            hang();
        }
        let Ok(mut v) = serde_json::from_str::<Value>(line) else { continue };
        fill(&mut v, &cwd.display().to_string(), &answer);
        out(&v);
    }
}

fn main() {
    let mut args = std::env::args();
    let me = args.next().unwrap_or_default();
    let name = Path::new(&me)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("agent")
        .to_owned();
    let argv: Vec<String> = args.collect();
    if let Some(code) = meta(&name, &argv) {
        std::process::exit(code);
    }
    let mut prompt = String::new();
    let _ = std::io::stdin().read_to_string(&mut prompt);
    // agy takes it as a stream-json `user` event, grok as a file
    if name == "agy" {
        prompt = serde_json::from_str::<Value>(prompt.lines().next().unwrap_or("")).ok().and_then(|v| v["message"]["content"].as_str().map(str::to_owned)).unwrap_or_default();
    }
    if let Some(i) = argv.iter().position(|a| a == "--prompt-file") {
        prompt = std::fs::read_to_string(argv.get(i + 1).map_or("", String::as_str)).unwrap_or_default();
    }
    record(&name, &argv, &prompt);
    RUN.store(!prompt.trim().is_empty(), std::sync::atomic::Ordering::Relaxed);
    // only a run (it has a prompt) hits it: a harness's detect probe (`opencode models`, `auth list`) that
    // lands late must not use the limit up (serve_kinds' best-of-n flaked on that under CI load)
    if let Some(f) = env("FAKE_LIMIT_ONCE")
        && !prompt.trim().is_empty()
        && !Path::new(&f).exists()
    {
        let _ = std::fs::write(&f, "1");
        eprintln!(
            "{}",
            env("FAKE_LIMIT_TEXT")
                .unwrap_or_else(|| "Claude AI usage limit reached|1767225600".into())
        );
        std::process::exit(1);
    }
    if env("FAKE_FAIL").is_some() {
        eprintln!("Error: the fake {name} failed on purpose");
        std::process::exit(1);
    }
    wait_ms("FAKE_DELAY");
    let target = std::env::current_dir().unwrap_or_default().join("math.js");
    let before = std::fs::read_to_string(&target).unwrap_or_default();
    let after = before.replace("a - b", "a + b");
    match name.as_str() {
        "claude" => claude(&prompt, &target, &before, &after),
        "codex" => codex(&prompt, &target, &after),
        n if recorded(n).is_some() => replay_turn(n, recorded(n).unwrap_or_default(), &prompt, &target, &after),
        _ => {
            edit(&target, &after);
            println!("{}", final_text(&name, &prompt));
        }
    }
    wait_ms("FAKE_LINGER");
}
