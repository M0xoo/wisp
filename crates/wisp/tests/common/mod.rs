//! What the serve e2e tests share: `wisp serve` on a temp home with wisp-testkit's fake harnesses on
//! the env, and a client for `POST /api/cmd`.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// The server, killed and its home removed when the test ends (passing or not).
pub struct Serve {
    pub child: Child,
    pub dir: PathBuf,
    pub keep: bool,
}

impl Serve {
    /// Stops the server and keeps its home, for a restart on the same `WISP_HOME`.
    pub fn stop(mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_file(self.dir.join("home/server.json"));
        self.keep = true;
    }
}

impl Drop for Serve {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if !self.keep {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

/// wisp-testkit's fake harness is a bin of another crate: cargo doesn't build it for this one's
/// tests, so build it into the same target dir and profile first.
/// The fake CLIs the server is pointed at, by file name and override variable.
pub const FAKES: [(&str, &str); 7] = [
    ("claude", "WISP_CLAUDE_BIN"),
    ("codex", "WISP_CODEX_BIN"),
    ("opencode", "WISP_OPENCODE_BIN"),
    ("cursor-agent", "WISP_CURSOR_BIN"),
    ("copilot", "WISP_COPILOT_BIN"),
    ("grok", "WISP_GROK_BIN"),
    ("agy", "WISP_ANTIGRAVITY_BIN"),
];

pub fn fake_agent() -> PathBuf {
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

pub fn start(dir: &Path) -> (Serve, u16) {
    start_with(dir, &[])
}

pub fn start_with(dir: &Path, env: &[(&str, &str)]) -> (Serve, u16) {
    let bin = dir.join("bin");
    fake_agent();
    wisp_testkit::install_fakes(&bin, &FAKES.map(|(n, _)| n)).unwrap();
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let log = std::fs::File::create(dir.join("serve.log")).unwrap();
    let child = Command::new(env!("CARGO_BIN_EXE_wisp"))
        .args(["serve", "--port", "0"])
        .env("WISP_HOME", &home)
        .envs(FAKES.map(|(n, var)| (var, bin.join(format!("{n}{}", std::env::consts::EXE_SUFFIX)))))
        // no real CLI config leaks in: each CLI's home is under the test's folder
        .env("CODEX_HOME", dir.join("codex-home"))
        .env("WISP_WEB_DIR", dir.join("no-web"))
        .env("RUST_LOG", "warn")
        .envs(env.iter().copied())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()
        .unwrap();
    let serve = Serve { child, dir: dir.to_owned(), keep: false };
    let at = Instant::now();
    loop {
        if let Some(port) = std::fs::read(home.join("server.json")).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).and_then(|v| v["port"].as_u64()) {
            return (serve, u16::try_from(port).unwrap());
        }
        assert!(at.elapsed() < Duration::from_secs(30), "wisp serve never advertised its port: {}", std::fs::read_to_string(dir.join("serve.log")).unwrap_or_default());
        std::thread::sleep(Duration::from_millis(50));
    }
}

pub async fn cmd(http: &reqwest::Client, port: u16, key: &str, name: &str, args: Value) -> Value {
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


pub fn temp(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("wisp-{name}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(dir.join("proj")).unwrap();
    std::fs::write(dir.join("proj/math.js"), "export const add = (a, b) => a - b;\n").unwrap();
    dir
}

pub struct Api {
    pub http: reqwest::Client,
    pub port: u16,
    pub n: std::sync::atomic::AtomicU32,
}

impl Api {
    pub async fn cmd(&self, name: &str, args: Value) -> Value {
        let n = self.n.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        cmd(&self.http, self.port, &format!("{name}-{n}"), name, args).await
    }

    /// The raw answer, for a command that may be refused.
    pub async fn try_cmd(&self, name: &str, args: Value) -> Value {
        let n = self.n.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let r = self.http.post(format!("http://127.0.0.1:{}/api/cmd", self.port)).header("content-type", "application/json").header("idempotency-key", format!("{name}-{n}")).body(json!({ "cmd": name, "args": args }).to_string()).send().await.unwrap();
        serde_json::from_slice(&r.bytes().await.unwrap()).unwrap()
    }

    pub async fn turns(&self, id: &str) -> Vec<Value> {
        self.cmd("runtime.turns", json!({ "id": id })).await.as_array().cloned().unwrap_or_default()
    }

    /// Waits until `f` holds for the task's turns.
    pub async fn until(&self, id: &str, what: &str, f: impl Fn(&[Value]) -> bool) -> Vec<Value> {
        let at = Instant::now();
        loop {
            let t = self.turns(id).await;
            if f(&t) {
                return t;
            }
            assert!(at.elapsed() < Duration::from_secs(60), "{what}: {t:?}");
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

pub fn ended(t: &Value) -> bool {
    t["status"] != "running" && t["status"] != "held"
}


/// Runs one task on `agent` to its end and returns (the turn, the task). The project has `math.js`.
pub async fn run_task(api: &Api, dir: &Path, agent: &str) -> (Value, Value) {
    let made = api.cmd("runtime.create", json!({ "prompt": "fix the add bug TOPIC[Fix add]", "cwd": dir.join("proj"), "agent": agent })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    let turns = api.until(&id, "the turn ends", |t| t.last().is_some_and(ended)).await;
    let task = api.cmd("runtime.get", json!({ "id": id })).await;
    (turns.last().cloned().unwrap_or_default(), task)
}
