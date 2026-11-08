//! A stand-in for the claude / codex / … CLIs (port of the core of v1 test/fixtures/fake-agent.mjs).
//! The CLI it plays comes from its file name (link it as `claude`, `codex`, …). It speaks each one's
//! stream format, edits `math.js` for real (`a - b` → `a + b`) and ends with a wisp block.
//!
//!   `FAKE_RECORD`      directory; each run appends {argv, stdin, cwd, pid} to `<name>.jsonl`
//!   `FAKE_HANG=1`      stop after the first events and wait to be killed
//!   `FAKE_FAIL=1`      exit 1 with an error on stderr, no result
//!   `FAKE_LIMIT_ONCE`  a file: the first run hits a usage limit (stderr, exit 1); later runs work
//!   `FAKE_DELAY` / `FAKE_LINGER`  ms to wait before answering / after the result
//!   `FAKE_REPLAY`      claude: print this .jsonl as its stream and exit (a recorded run)
//!   `FAKE_CLI_VERSION` what --version says (9.9.9); `FAKE_AUTH_PROFILE`, `FAKE_AUTH_FAIL` for `auth status --text`
//!   TOPIC[…] in the prompt: the hero names it
#![allow(clippy::print_stdout, clippy::unwrap_used, clippy::expect_used)]
use std::io::{Read, Write};
use std::path::Path;

use serde_json::{Value, json};

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
    let line = json!({ "argv": argv, "stdin": prompt, "cwd": std::env::current_dir().ok(), "pid": std::process::id() });
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(Path::new(&dir).join(format!("{name}.jsonl")))
    {
        let _ = writeln!(f, "{line}");
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
        let _ = std::fs::write(target, after);
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
    let _ = std::fs::write(target, after);
    let cwd = target.parent().unwrap_or(Path::new("."));
    let _ = std::fs::write(cwd.join("notes.txt"), "new file\n");
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
    record(&name, &argv, &prompt);
    if let Some(f) = env("FAKE_LIMIT_ONCE")
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
        _ => {
            let _ = std::fs::write(&target, &after);
            println!("{}", final_text(&name, &prompt));
        }
    }
    wait_ms("FAKE_LINGER");
}
