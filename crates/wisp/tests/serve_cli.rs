//! The command line against `wisp serve` with the fake agent (ADR-0022): the real binary, as a user
//! types it. Generated verbs, help, completions, refusals and their exit codes in a pipe; `wisp "task"`
//! attached in a pty (its steps, the answer, a question answered inline, the reply box, Ctrl-C twice).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use common::{Api, ended, start, start_with, temp};
use serde_json::{Value, json};

/// `wisp …` at the test's server, its output read whole (stdin closed: not a terminal).
fn wisp(dir: &Path, port: u16, args: &[&str]) -> (i32, String, String) {
    let o = Command::new(env!("CARGO_BIN_EXE_wisp"))
        .args(args)
        .env("WISP_HOME", dir.join("home"))
        .env("WISP_PORT", port.to_string())
        .env("NO_COLOR", "1")
        .current_dir(dir.join("proj"))
        .stdin(Stdio::null())
        .output()
        .unwrap();
    (o.status.code().unwrap_or(-1), String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned())
}

fn strip(s: &str) -> String {
    let mut out = String::new();
    let mut it = s.chars().peekable();
    while let Some(c) = it.next() {
        if c == '\x1b' {
            match it.next() {
                Some('[') => {
                    for d in it.by_ref() {
                        if ('@'..='~').contains(&d) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    while let Some(d) = it.next() {
                        if d == '\x07' || (d == '\x1b' && it.next().is_some()) {
                            break;
                        }
                    }
                }
                _ => {}
            }
        } else if c != '\r' {
            out.push(c);
        }
    }
    out
}

/// `wisp …` in a pseudo-terminal: what it printed (escapes taken out), keys typed in.
struct Pty {
    out: Arc<Mutex<String>>,
    w: Box<dyn Write + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

impl Pty {
    fn spawn(dir: &Path, port: u16, args: &[&str]) -> Self {
        let sys = portable_pty::native_pty_system();
        let pair = sys.openpty(portable_pty::PtySize { rows: 40, cols: 80, pixel_width: 0, pixel_height: 0 }).unwrap();
        let mut cmd = portable_pty::CommandBuilder::new(env!("CARGO_BIN_EXE_wisp"));
        cmd.args(args);
        cmd.env("WISP_HOME", dir.join("home"));
        cmd.env("WISP_PORT", port.to_string());
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLUMNS", "80");
        cmd.cwd(dir.join("proj"));
        let child = pair.slave.spawn_command(cmd).unwrap();
        drop(pair.slave);
        let mut r = pair.master.try_clone_reader().unwrap();
        let w = pair.master.take_writer().unwrap();
        let out = Arc::new(Mutex::new(String::new()));
        let o2 = out.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            while let Ok(n) = r.read(&mut buf) {
                if n == 0 {
                    break;
                }
                o2.lock().unwrap().push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        });
        // the master must outlive the child: keep it in the reader's thread scope
        std::mem::forget(pair.master);
        Self { out, w, child }
    }

    fn text(&self) -> String {
        strip(&self.out.lock().unwrap())
    }

    /// Waits until the output (escapes out) holds `needle` `n` times.
    fn expect_n(&self, needle: &str, n: usize) -> String {
        let at = Instant::now();
        loop {
            let t = self.text();
            if t.matches(needle).count() >= n {
                return t;
            }
            assert!(at.elapsed() < Duration::from_secs(30), "never saw {needle:?} ×{n} in:\n{t}");
            std::thread::sleep(Duration::from_millis(30));
        }
    }

    fn expect(&self, needle: &str) -> String {
        self.expect_n(needle, 1)
    }

    fn keys(&mut self, s: &str) {
        self.w.write_all(s.as_bytes()).unwrap();
        self.w.flush().unwrap();
    }

    fn exit(&mut self) -> u32 {
        let at = Instant::now();
        loop {
            if let Some(s) = self.child.try_wait().unwrap() {
                return s.exit_code();
            }
            assert!(at.elapsed() < Duration::from_secs(20), "wisp didn't exit:\n{}", self.text());
            std::thread::sleep(Duration::from_millis(30));
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn generated_verbs_help_completions_refusals_and_detached_runs() {
    let dir = temp("serve-cli");
    let (serve, port) = start(&dir);
    let (code, out, _) = wisp(&dir, port, &["help"]);
    assert_eq!(code, 0);
    assert!(out.contains("wisp runtime") && out.contains("wisp settings") && out.contains("wisp crew"), "{out}");
    let (_, out, _) = wisp(&dir, port, &["help", "settings"]);
    assert!(out.contains("set ") && out.contains("Change a setting"), "{out}");
    let (code, out, _) = wisp(&dir, port, &["settings", "set", "--help"]);
    assert_eq!(code, 0);
    assert!(out.contains("usage: wisp settings set <key> <value>") && out.contains("--key TEXT"), "{out}");
    // a write through a generated verb, read back with another, --json for scripts
    let (code, _, err) = wisp(&dir, port, &["settings", "set", "settings.timeZone", "Europe/Zurich"]);
    assert_eq!(code, 0, "{err}");
    let (_, out, _) = wisp(&dir, port, &["settings", "get", "settings.timeZone", "--json"]);
    assert_eq!(serde_json::from_str::<Value>(&out).unwrap(), json!("Europe/Zurich"));
    // refusals: non-zero with the wire message; a command line that doesn't fit: 2
    let (code, _, err) = wisp(&dir, port, &["runtime", "get", "nope"]);
    assert_eq!(code, 1);
    assert!(err.contains("✗") && err.to_lowercase().contains("nope"), "{err}");
    let (code, _, err) = wisp(&dir, port, &["crew", "create", "--colour", "red"]);
    assert_eq!(code, 2, "{err}");
    assert!(err.contains("--name"), "{err}");
    let (code, out, _) = wisp(&dir, port, &["completions", "zsh"]);
    assert_eq!(code, 0);
    assert!(out.starts_with("#compdef wisp") && out.contains("settings)") && out.contains("--key"), "{out}");
    let (_, out, _) = wisp(&dir, port, &["completions", "fish"]);
    assert!(out.contains("complete -c wisp"), "{out}");
    // `wisp "task"` outside a terminal: detached, with its id
    let (code, out, err) = wisp(&dir, port, &["fix the add bug", "--agent", "claude"]);
    assert_eq!(code, 0, "{err}");
    let id = out.split("wisp attach ").nth(1).unwrap().trim().to_owned();
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    api.until(&id, "the run", |t| t.len() == 1 && ended(&t[0])).await;
    // the next command in this terminal says the detached task finished, once
    let (_, _, err) = wisp(&dir, port, &["runtime", "list"]);
    assert!(err.contains("finished · wisp attach") && err.contains(&id), "{err:?}");
    let (_, _, err) = wisp(&dir, port, &["runtime", "list"]);
    assert!(!err.contains("finished"), "said once: {err}");
    let (_, out, _) = wisp(&dir, port, &["ls"]);
    assert!(out.contains(&id) && !out.contains("asks:"), "nothing is asked: {out}");
    // show --watch on a finished task: its answer, then it returns
    let (code, out, _) = wisp(&dir, port, &["show", &id, "--watch"]);
    assert_eq!(code, 0);
    assert!(out.contains("Fake claude finished"), "{out}");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn attached_run_answers_a_question_inline_and_replies_from_the_box() {
    let dir = temp("serve-cli-pty");
    let (serve, port) = start(&dir);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let mut t = Pty::spawn(&dir, port, &["fix the add bug", "--agent", "claude"]);
    let seen = t.expect("Enter to leave");
    assert!(seen.contains("▸ Reading math.js") && seen.contains("✓ Fake claude finished"), "{seen}");
    let id = api.cmd("runtime.list", json!({})).await[0]["id"].as_str().unwrap().to_owned();
    // the agent asks (as its MCP tool does); the terminal asks you and sends your pick
    let api2 = api;
    let ask = api2.cmd("runtime.ask", json!({ "id": id, "question": "Which branch?", "options": ["main", "dev"] })).await;
    let seen = t.expect("Which branch?");
    assert!(seen.contains("1. main") && seen.contains("2. dev"), "{seen}");
    t.keys("2\r");
    let ask_id = ask["askId"].as_str().unwrap().to_owned();
    let at = Instant::now();
    loop {
        let p = api2.cmd("runtime.pollAnswer", json!({ "askId": ask_id })).await;
        if p["state"] == "answered" {
            assert_eq!(p["answer"], "dev");
            break;
        }
        assert!(at.elapsed() < Duration::from_secs(10), "never answered: {p}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    // the reply box: a follow-up runs in the same task, streamed the same way
    t.expect_n("Enter to leave", 2);
    t.keys("now the tests\r");
    let seen = t.expect_n("Enter to leave", 3);
    assert_eq!(seen.matches("✓ Fake claude finished").count(), 2, "{seen}");
    assert_eq!(api2.turns(&id).await.len(), 2);
    t.keys("\r");
    assert_eq!(t.exit(), 0, "{}", t.text());
    let _ = writeln!(std::io::stdout(), "--- transcript ---\n{}", t.text());
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn ctrl_c_detaches_and_a_second_ctrl_c_stops() {
    let dir = temp("serve-cli-ctrlc");
    let (serve, port) = start_with(&dir, &[("FAKE_HANG", "1")]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    // once: detached, still running
    let mut t = Pty::spawn(&dir, port, &["fix the add bug", "--agent", "claude"]);
    t.expect("▸ Reading");
    t.keys("\x03");
    let seen = t.expect("Ctrl-C again");
    assert!(seen.contains("detached") && seen.contains("wisp attach"), "{seen}");
    assert_eq!(t.exit(), 0);
    let id = api.cmd("runtime.list", json!({})).await[0]["id"].as_str().unwrap().to_owned();
    assert_eq!(api.cmd("runtime.get", json!({ "id": id })).await["state"], "running");
    // attach again: twice stops it
    let mut t = Pty::spawn(&dir, port, &["attach", &id]);
    t.expect("▸ Reading");
    t.keys("\x03");
    t.expect("Ctrl-C again");
    t.keys("\x03");
    t.expect("stopped");
    assert_eq!(t.exit(), 130);
    api.until(&id, "the stop", |t| t.last().is_some_and(ended)).await;
    drop(serve);
}
