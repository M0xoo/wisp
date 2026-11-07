//! Drives the real binary over stdio, as the server does.
#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::panic, reason = "a test: failing loudly is the point")]

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use serde_json::{Value, json};

const WAIT: Duration = Duration::from_secs(10);

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    rx: Receiver<Value>,
    seen: Vec<Value>,
}

impl Helper {
    fn start() -> Helper {
        let mut child = Command::new(env!("CARGO_BIN_EXE_wisp-native"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdout = child.stdout.take().unwrap();
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if tx.send(serde_json::from_str::<Value>(&line).unwrap()).is_err() {
                    break;
                }
            }
        });
        let stdin = child.stdin.take();
        let mut h = Helper { child, stdin, rx, seen: Vec::new() };
        let hello = h.next(|e| e["type"] == "hello");
        assert_eq!(hello["protocol"], 1);
        h
    }

    fn send(&mut self, v: &Value) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{v}").unwrap();
        stdin.flush().unwrap();
    }

    /// The next event matching `want`; every event read is kept in `seen`.
    fn next(&mut self, want: impl Fn(&Value) -> bool) -> Value {
        if let Some(i) = self.seen.iter().position(&want) {
            return self.seen.remove(i);
        }
        let end = Instant::now() + WAIT;
        loop {
            let left = end.saturating_duration_since(Instant::now());
            let e = self.rx.recv_timeout(left).unwrap_or_else(|_| panic!("timed out; saw {:?}", self.seen));
            if want(&e) {
                return e;
            }
            self.seen.push(e);
        }
    }

    fn exit_of(&mut self, id: &str) -> Value {
        self.next(|e| e["type"] == "exit" && e["id"] == id)
    }

    /// Everything `id` printed on `stream` among the events seen so far.
    fn printed(&self, id: &str, stream: &str) -> String {
        let bytes: Vec<u8> = self
            .seen
            .iter()
            .filter(|e| e["type"] == "data" && e["id"] == id && e["stream"] == stream)
            .flat_map(|e| B64.decode(e["data"].as_str().unwrap()).unwrap())
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    }

    fn wait_printed(&mut self, id: &str, needle: &str) -> String {
        let end = Instant::now() + WAIT;
        loop {
            let text = self.printed(id, "stdout");
            if text.contains(needle) {
                return text;
            }
            assert!(Instant::now() < end, "no {needle:?} in {text:?}");
            if let Ok(e) = self.rx.recv_timeout(Duration::from_millis(50)) {
                self.seen.push(e);
                self.seen.extend(self.rx.try_iter());
            }
        }
    }

    fn type_in(&mut self, id: &str, text: &str) {
        self.send(&json!({"type": "data", "id": id, "data": B64.encode(text)}));
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        drop(self.stdin.take());
        let _ = self.child.wait();
    }
}

/// Running (not a zombie), per ps(1).
fn running(pid: u32) -> bool {
    let out = Command::new("ps").args(["-o", "stat=", "-p", &pid.to_string()]).output().unwrap();
    let stat = String::from_utf8_lossy(&out.stdout);
    !stat.trim().is_empty() && !stat.trim().starts_with('Z')
}

fn gone_soon(pids: &[u32]) -> Vec<u32> {
    let end = Instant::now() + Duration::from_secs(3);
    loop {
        let left: Vec<u32> = pids.iter().copied().filter(|&p| running(p)).collect();
        if left.is_empty() || Instant::now() > end {
            return left;
        }
        thread::sleep(Duration::from_millis(20));
    }
}

fn pids_in(text: &str) -> Vec<u32> {
    text.split_whitespace().filter_map(|w| w.parse().ok()).collect()
}

#[test]
fn a_pty_has_its_size_from_the_first_line_resizes_and_takes_input() {
    let mut h = Helper::start();
    let script = "stty size; read l; stty size; echo \"got $l\"; exit 7";
    h.send(&json!({"type": "spawn", "id": "t", "cmd": "sh", "args": ["-c", script], "pty": {"cols": 90, "rows": 33}}));
    let started = h.next(|e| e["type"] == "started");
    assert!(started["pid"].as_u64().unwrap() > 1);
    h.wait_printed("t", "33 90");
    h.send(&json!({"type": "resize", "id": "t", "cols": 120, "rows": 40}));
    thread::sleep(Duration::from_millis(100));
    h.type_in("t", "hello\r");
    let exit = h.exit_of("t");
    assert_eq!(exit["code"], 7);
    assert_eq!(exit["signal"], Value::Null);
    let out = h.printed("t", "stdout");
    assert!(out.contains("40 120\r\ngot hello"), "{out:?}");
}

#[test]
fn pipes_keep_stdout_and_stderr_apart_and_eof_closes_stdin() {
    let mut h = Helper::start();
    h.send(&json!({"type": "spawn", "id": "p", "cmd": "sh", "args": ["-c", "cat; echo bye >&2"], "env": {"PATH": "/usr/bin:/bin"}}));
    h.next(|e| e["type"] == "started");
    h.type_in("p", "one\ntwo\n");
    h.send(&json!({"type": "eof", "id": "p"}));
    assert_eq!(h.exit_of("p")["code"], 0);
    assert_eq!(h.printed("p", "stdout"), "one\ntwo\n");
    assert_eq!(h.printed("p", "stderr"), "bye\n");
}

#[test]
fn the_environment_given_is_the_whole_environment() {
    let mut h = Helper::start();
    h.send(&json!({"type": "spawn", "id": "e", "cmd": "/usr/bin/env", "env": {"ONLY": "this"}}));
    h.exit_of("e");
    assert_eq!(h.printed("e", "stdout"), "ONLY=this\n");
}

#[test]
fn bad_requests_are_answered_not_fatal() {
    let mut h = Helper::start();
    h.send(&json!({"type": "spawn", "id": "x", "cmd": "sh", "cwd": "/definitely/not/here"}));
    assert_eq!(h.next(|e| e["type"] == "error")["code"], "spawn_failed");
    h.send(&json!({"type": "spawn", "id": "x", "cmd": "definitely-not-a-cli-wisp"}));
    assert_eq!(h.next(|e| e["type"] == "error")["code"], "spawn_failed");
    h.send(&json!({"type": "resize", "id": "nobody", "cols": 1, "rows": 1}));
    assert_eq!(h.next(|e| e["type"] == "error")["code"], "unknown_id");
    h.send(&json!({"type": "spawn", "id": "s", "cmd": "sleep", "args": ["5"]}));
    h.next(|e| e["type"] == "started");
    h.send(&json!({"type": "spawn", "id": "s", "cmd": "sleep", "args": ["5"]}));
    assert_eq!(h.next(|e| e["type"] == "error")["code"], "duplicate_id");
    h.send(&json!({"type": "resize", "id": "s", "cols": 1, "rows": 1}));
    assert_eq!(h.next(|e| e["type"] == "error")["code"], "unsupported");
    h.send(&json!({"type": "signal", "id": "s", "signal": "SIGNOPE"}));
    assert_eq!(h.next(|e| e["type"] == "error")["code"], "bad_request");
    h.stdin.as_mut().unwrap().write_all(b"not json\n").unwrap();
    assert_eq!(h.next(|e| e["type"] == "error")["code"], "bad_request");
    h.send(&json!({"type": "list", "ref": "l"}));
    let list = h.next(|e| e["type"] == "list");
    assert_eq!(list["items"][0]["id"], "s");
}

const TREE: &str = "sleep 60 & echo $!; sh -c 'sleep 60 & echo $!; wait' & echo $!; sleep 0.2; echo ready; wait";

#[test]
fn killing_a_tree_leaves_no_process_behind() {
    let mut h = Helper::start();
    // A process that leaves the group (setsid) is found through its parent.
    let escape = "import os, time; os.setsid(); print(os.getpid(), flush=True); time.sleep(60)";
    let has_python = Command::new("python3").arg("-c").arg("1").status().is_ok_and(|s| s.success());
    let script = if has_python { format!("python3 -c '{escape}' & {TREE}") } else { TREE.to_owned() };
    h.send(&json!({"type": "spawn", "id": "k", "cmd": "sh", "args": ["-c", script]}));
    let root = u32::try_from(h.next(|e| e["type"] == "started")["pid"].as_u64().unwrap()).unwrap();
    let mut pids = pids_in(&h.wait_printed("k", "ready"));
    pids.push(root);
    assert!(pids.len() >= 4, "{pids:?}");
    h.send(&json!({"type": "kill", "id": "k", "ref": "r"}));
    let killed = h.next(|e| e["type"] == "killed");
    assert_eq!(killed["ref"], "r");
    assert_eq!(killed["survivors"], 0);
    assert!(killed["signalled"].as_u64().unwrap() >= 4);
    h.exit_of("k");
    assert_eq!(gone_soon(&pids), Vec::<u32>::new());
}

#[test]
fn what_an_exited_program_left_behind_can_still_be_killed() {
    let mut h = Helper::start();
    h.send(&json!({"type": "spawn", "id": "x", "cmd": "sh", "args": ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"]}));
    h.exit_of("x");
    let pids = pids_in(&h.printed("x", "stdout"));
    assert!(running(pids[0]));
    h.send(&json!({"type": "kill", "id": "x", "graceMs": 100}));
    assert_eq!(h.next(|e| e["type"] == "killed")["survivors"], 0);
    assert_eq!(gone_soon(&pids), Vec::<u32>::new());
}

#[test]
fn closing_stdin_kills_every_tree_then_exits() {
    let mut h = Helper::start();
    h.send(&json!({"type": "spawn", "id": "a", "cmd": "sh", "args": ["-c", TREE]}));
    h.send(&json!({"type": "spawn", "id": "b", "cmd": "sh", "args": ["-c", TREE], "pty": {"cols": 80, "rows": 24}}));
    let mut pids = pids_in(&h.wait_printed("a", "ready"));
    pids.extend(pids_in(&h.wait_printed("b", "ready")));
    drop(h.stdin.take());
    let status = h.child.wait().unwrap();
    assert!(status.success());
    assert_eq!(gone_soon(&pids), Vec::<u32>::new());
}

#[test]
fn a_big_paste_goes_in_whole_while_the_program_prints() {
    let mut h = Helper::start();
    h.send(&json!({"type": "spawn", "id": "c", "cmd": "cat", "pty": {"cols": 100, "rows": 30}}));
    h.next(|e| e["type"] == "started");
    let line = |i: usize| format!("pasted line {i} {}\r", "x".repeat(40));
    let text = (0..4000).map(line).collect::<Vec<_>>().concat();
    h.type_in("c", &text);
    let out = h.wait_printed("c", "pasted line 3999");
    // Each line comes back twice (the terminal's echo and cat's copy) and the two may interleave;
    // a line counts once one intact copy of it arrived.
    let whole = format!(" {}", "x".repeat(40));
    let intact: std::collections::BTreeSet<usize> = out
        .split("pasted line ")
        .filter_map(|rest| {
            let digits = rest.find(' ')?;
            rest[digits..].starts_with(&whole).then(|| rest[..digits].parse().ok())?
        })
        .collect();
    assert_eq!(intact.len(), 4000, "every line arrived whole");
    h.send(&json!({"type": "signal", "id": "c", "signal": "SIGHUP", "tree": true}));
    assert_eq!(h.exit_of("c")["signal"], "SIGHUP");
}
