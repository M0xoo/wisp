//! `wisp serve` runs a task end to end (verify round 1, #25): the real binary with every plugin this
//! build has (`DefaultPlugins`), a temp `WISP_HOME`, and wisp-testkit's fake `claude` (it speaks
//! Claude Code's stream-json, edits `math.js` for real and ends with a wisp block). The task is made
//! over `POST /api/cmd` like the web app makes it, and the test waits for its turn to finish.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// The server, killed and its home removed when the test ends (passing or not).
struct Serve {
    child: Child,
    dir: PathBuf,
}

impl Drop for Serve {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// wisp-testkit's fake harness is a bin of another crate: cargo doesn't build it for this one's
/// tests, so build it into the same target dir and profile first.
fn fake_agent() -> PathBuf {
    let bin = wisp_testkit::fake_agent_bin();
    if bin.is_file() {
        return bin;
    }
    let exe = std::env::current_exe().unwrap();
    let profile_dir = exe.parent().and_then(Path::parent).unwrap();
    let target = profile_dir.parent().unwrap();
    let mut cmd = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()));
    cmd.args(["build", "--quiet", "-p", "wisp-testkit", "--bin", "wisp-fake-agent", "--target-dir"]).arg(target);
    if profile_dir.ends_with("release") {
        cmd.arg("--release");
    }
    assert!(cmd.status().unwrap().success(), "building wisp-fake-agent");
    assert!(bin.is_file(), "{} after the build", bin.display());
    bin
}

fn start(dir: &Path) -> (Serve, u16) {
    let bin = dir.join("bin");
    fake_agent();
    wisp_testkit::install_fakes(&bin, &["claude"]).unwrap();
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let log = std::fs::File::create(dir.join("serve.log")).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_wisp"))
        .args(["serve", "--port", "0"])
        .env("WISP_HOME", &home)
        .env("WISP_CLAUDE_BIN", bin.join(format!("claude{}", std::env::consts::EXE_SUFFIX)))
        .env("WISP_WEB_DIR", dir.join("no-web"))
        .env("RUST_LOG", "warn")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()
        .unwrap();
    let serve = Serve { child, dir: dir.to_owned() };
    let at = Instant::now();
    loop {
        if let Some(port) = std::fs::read(home.join("server.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["port"].as_u64()) {
            return (serve, u16::try_from(port).unwrap());
        }
        assert!(at.elapsed() < Duration::from_secs(30), "wisp serve never advertised its port: {}", std::fs::read_to_string(dir.join("serve.log")).unwrap_or_default());
        std::thread::sleep(Duration::from_millis(50));
    }
}

async fn cmd(http: &reqwest::Client, port: u16, key: &str, name: &str, args: Value) -> Value {
    let r = http
        .post(format!("http://127.0.0.1:{port}/api/cmd"))
        .header("content-type", "application/json")
        .header("idempotency-key", key)
        .body(json!({ "cmd": name, "args": args }).to_string())
        .send()
        .await
        .unwrap();
    let v: Value = serde_json::from_slice(&r.bytes().await.unwrap()).unwrap();
    assert_eq!(v["ok"], true, "{name}: {v}");
    v["result"].clone()
}

#[tokio::test(flavor = "multi_thread")]
async fn serve_runs_a_task_through_the_fake_claude_to_finished() {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("wisp-serve-task-{}-{nanos}", std::process::id()));
    let proj = dir.join("proj");
    std::fs::create_dir_all(&proj).unwrap();
    std::fs::write(proj.join("math.js"), "export const add = (a, b) => a - b;\n").unwrap();
    let (serve, port) = start(&dir);
    let http = reqwest::Client::new();

    let made = cmd(&http, port, "create-1", "runtime.create", json!({ "prompt": "fix add TOPIC[Fix add]", "cwd": proj, "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();

    let at = Instant::now();
    let mut n = 0;
    let turn = loop {
        n += 1;
        let turns = cmd(&http, port, &format!("turns-{n}"), "runtime.turns", json!({ "id": id })).await;
        if let Some(t) = turns.as_array().and_then(|l| l.last()).filter(|t| t["status"] != "running" && t["status"] != "held") {
            break t.clone();
        }
        assert!(at.elapsed() < Duration::from_secs(60), "the turn never finished: {turns}\n{}", std::fs::read_to_string(dir.join("serve.log")).unwrap_or_default());
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(turn["status"], "done", "{turn}");
    assert_eq!(turn["agent"], "claude");
    assert_eq!(turn["changedFiles"], 1);
    assert_eq!(turn["presentation"]["blocks"][0]["title"], "Fake claude finished");
    assert_eq!(std::fs::read_to_string(proj.join("math.js")).unwrap(), "export const add = (a, b) => a + b;\n");

    let task = cmd(&http, port, "get-1", "runtime.get", json!({ "id": id })).await;
    assert_eq!(task["title"], "Fix add", "named after its first answer's topic");
    assert_eq!(task["state"], "review", "Finished: waiting for the user to look");
    assert_eq!(task["resumeId"], "claude-session-1");

    // ADR-0019: OpenAPI comes from the route table every plugin filled, so check that table here,
    // with every plugin this build has: each documented route says what it does.
    let doc: Value = serde_json::from_slice(&http.get(format!("http://127.0.0.1:{port}/api/openapi.json")).send().await.unwrap().bytes().await.unwrap()).unwrap();
    let paths = doc["paths"].as_object().unwrap();
    let mut ops = 0;
    for (path, item) in paths {
        for (verb, op) in item.as_object().unwrap() {
            ops += 1;
            assert!(op["summary"].as_str().is_some_and(|s| !s.trim().is_empty()), "{} {path} has no summary (owner {})", verb.to_uppercase(), op["tags"]);
        }
    }
    assert!(paths.contains_key("/api/sessions") && paths.contains_key("/api/cmd"), "runtime's and the edge's routes are listed");
    assert!(ops > 20, "{ops} operations");
    drop(serve);
}
