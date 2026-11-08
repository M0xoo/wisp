//! `wisp serve` runs a task end to end (verify round 1, #25): the real binary with every plugin this
//! build has (`DefaultPlugins`), a temp `WISP_HOME`, and wisp-testkit's fake `claude` (it speaks
//! Claude Code's stream-json, edits `math.js` for real and ends with a wisp block). The task is made
//! over `POST /api/cmd` like the web app makes it, and the test waits for its turn to finish.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// The server, killed and its home removed when the test ends (passing or not).
struct Serve {
    child: Child,
    dir: PathBuf,
    keep: bool,
}

impl Serve {
    /// Stops the server and keeps its home, for a restart on the same `WISP_HOME`.
    fn stop(mut self) {
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
    start_with(dir, &[])
}

fn start_with(dir: &Path, env: &[(&str, &str)]) -> (Serve, u16) {
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
    let log = std::fs::read_to_string(dir.join("serve.log")).unwrap_or_default();
    assert!(!log.contains("refused"), "every plugin of the build starts:\n{log}");
    drop(serve);
}

fn temp(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("wisp-{name}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(dir.join("proj")).unwrap();
    std::fs::write(dir.join("proj/math.js"), "export const add = (a, b) => a - b;\n").unwrap();
    dir
}

struct Api {
    http: reqwest::Client,
    port: u16,
    n: std::sync::atomic::AtomicU32,
}

impl Api {
    async fn cmd(&self, name: &str, args: Value) -> Value {
        let n = self.n.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        cmd(&self.http, self.port, &format!("{name}-{n}"), name, args).await
    }

    /// The raw answer, for a command that may be refused.
    async fn try_cmd(&self, name: &str, args: Value) -> Value {
        let n = self.n.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let r = self.http.post(format!("http://127.0.0.1:{}/api/cmd", self.port)).header("content-type", "application/json").header("idempotency-key", format!("{name}-{n}")).body(json!({ "cmd": name, "args": args }).to_string()).send().await.unwrap();
        serde_json::from_slice(&r.bytes().await.unwrap()).unwrap()
    }

    async fn turns(&self, id: &str) -> Vec<Value> {
        self.cmd("runtime.turns", json!({ "id": id })).await.as_array().cloned().unwrap_or_default()
    }

    /// Waits until `f` holds for the task's turns.
    async fn until(&self, id: &str, what: &str, f: impl Fn(&[Value]) -> bool) -> Vec<Value> {
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

fn ended(t: &Value) -> bool {
    t["status"] != "running" && t["status"] != "held"
}

#[tokio::test(flavor = "multi_thread")]
async fn follow_up_queue_and_stop_keep_the_queue() {
    let dir = temp("serve-queue");
    // each fake run takes 1.5 s, so a follow-up sent meanwhile queues
    let (serve, port) = start_with(&dir, &[("FAKE_DELAY", "1500")]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let made = api.cmd("runtime.create", json!({ "prompt": "first", "cwd": dir.join("proj"), "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the first turn", |t| t.len() == 1 && ended(&t[0])).await;

    // a follow-up starts a second turn in the same conversation
    let f = api.cmd("runtime.followUp", json!({ "id": id, "text": "second" })).await;
    assert!(f["turnId"].is_string(), "{f}");
    api.until(&id, "the second turn running", |t| t.len() == 2 && t[1]["status"] == "running").await;
    // another one while it runs waits in the queue
    let q = api.cmd("runtime.followUp", json!({ "id": id, "text": "third", "queue": true })).await;
    assert!(q["queued"].is_string(), "queued while running: {q}");
    // Stop never throws the queue away: it holds it
    api.cmd("runtime.stop", json!({ "id": id })).await;
    let t = api.until(&id, "the second turn stopped", |t| t.len() == 2 && ended(&t[1])).await;
    assert_eq!(t[1]["status"], "stopped", "{:?}", t[1]);
    let s = api.cmd("runtime.get", json!({ "id": id })).await;
    assert_eq!(s["queue"].as_array().map(Vec::len), Some(1), "{s}");
    assert_eq!(s["queue"][0]["text"], "third");
    assert_eq!(s["queueHeld"], true);
    assert_eq!(s["resumeId"], "claude-session-1", "the follow-up resumed the conversation");

    // the held queue goes when you say so
    let item = s["queue"][0]["id"].as_str().unwrap().to_owned();
    api.cmd("runtime.queue.sendNow", json!({ "id": id, "itemId": item })).await;
    let t = api.until(&id, "the queued follow-up ran", |t| t.len() == 3 && ended(&t[2])).await;
    assert_eq!((t[2]["prompt"].as_str(), t[2]["status"].as_str()), (Some("third"), Some("done")));
    drop(serve);
}

async fn activity(api: &Api, id: &str, turn: &str) -> Vec<String> {
    let page = api.cmd("runtime.activity", json!({ "id": id, "turnId": turn })).await;
    page["items"].as_array().into_iter().flatten().filter_map(|x| x["label"].as_str().or_else(|| x["text"].as_str()).map(str::to_owned)).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_question_asked_mid_turn_survives_a_restart_and_the_reply_answers_it() {
    let dir = temp("serve-ask");
    // the fake agent works for 4 s: the question is asked while its turn runs
    let (serve, port) = start_with(&dir, &[("FAKE_DELAY", "4000")]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let made = api.cmd("runtime.create", json!({ "prompt": "hi", "cwd": dir.join("proj"), "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    let turn = made["turnId"].as_str().unwrap().to_owned();
    api.until(&id, "the turn running", |t| t.len() == 1 && t[0]["status"] == "running").await;
    // what wisp's MCP server does for the agent's ask_user tool (seven options: six are kept)
    let ask = api.cmd("runtime.ask", json!({ "id": id, "question": "Which branch?", "options": ["main", "dev", "a", "b", "c", "d", "e"] })).await;
    let ask_id = ask["askId"].as_str().unwrap().to_owned();
    let s = api.cmd("runtime.get", json!({ "id": id })).await;
    assert_eq!(s["state"], "waiting", "v1: a question makes the task wait");
    assert_eq!(s["unread"], true);
    assert_eq!(s["ext"]["wisp.runtime"]["ask"]["options"].as_array().map(Vec::len), Some(6));
    assert!(activity(&api, &id, &turn).await.iter().any(|l| l == "Asked you: Which branch?"));
    assert_eq!(api.cmd("runtime.pollAnswer", json!({ "askId": ask_id })).await, json!({ "state": "pending" }));

    // wisp restarts with the question open: it's still on the task, and still answerable
    serve.stop();
    let (serve, port) = start(&dir);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    assert_eq!(api.cmd("runtime.pollAnswer", json!({ "askId": ask_id })).await, json!({ "state": "pending" }), "pending across the restart");
    assert_eq!(api.cmd("runtime.get", json!({ "id": id })).await["state"], "waiting");
    // the user's reply answers it: no new turn starts
    let r = api.cmd("runtime.followUp", json!({ "id": id, "text": "dev" })).await;
    assert!(r["turnId"].is_null() && r["queued"].is_null(), "{r}");
    assert_eq!(api.cmd("runtime.pollAnswer", json!({ "askId": ask_id })).await, json!({ "state": "answered", "answer": "dev" }));
    assert_eq!(api.cmd("runtime.pollAnswer", json!({ "askId": ask_id })).await, json!({ "state": "cancelled" }), "an answer is read once");
    let s = api.cmd("runtime.get", json!({ "id": id })).await;
    assert_ne!(s["state"], "waiting");
    assert!(s["ext"]["wisp.runtime"]["ask"].is_null());
    assert!(activity(&api, &id, &turn).await.iter().any(|l| l == "You answered: dev"));
    assert_eq!(api.turns(&id).await.len(), 1);
    // nothing asked: answering is refused
    assert_eq!(api.try_cmd("runtime.answer", json!({ "id": id, "text": "x" })).await["ok"], false);
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn always_allow_grants_the_same_action_for_the_rest_of_the_task() {
    let dir = temp("serve-approve");
    let (serve, port) = start(&dir);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let made = api.cmd("runtime.create", json!({ "prompt": "hi", "cwd": dir.join("proj"), "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn", |t| t.len() == 1 && ended(&t[0])).await;
    // the approve tool waits on the user: ask it in the background
    let (a2, id2) = (api.clone(), id.clone());
    let pending = tokio::spawn(async move { a2.cmd("runtime.approval", json!({ "id": id2, "tool": "Bash", "input": { "command": "npm publish" } })).await });
    let mut q = Value::Null;
    for _ in 0..50 {
        q = api.cmd("runtime.get", json!({ "id": id })).await["ext"]["wisp.runtime"]["ask"].clone();
        if !q.is_null() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert_eq!(q["options"], json!(["Allow", "Always allow in this task", "Deny"]), "{q}");
    assert!(q["question"].as_str().unwrap().starts_with("Allow Claude Code to"));
    api.cmd("runtime.answer", json!({ "id": id, "text": "Always allow in this task" })).await;
    assert_eq!(pending.await.unwrap()["behavior"], "allow");
    // the same action again: allowed at once, no question
    let again = api.cmd("runtime.approval", json!({ "id": id, "tool": "Bash", "input": { "command": "npm publish" } })).await;
    assert_eq!(again["behavior"], "allow");
    assert!(api.cmd("runtime.get", json!({ "id": id })).await["ext"]["wisp.runtime"]["ask"].is_null());
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_lead_delegates_to_its_team_and_reads_the_reports() {
    let dir = temp("serve-delegate");
    let (serve, port) = start_with(&dir, &[("FAKE_DELAY", "1500")]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let team = json!({ "wisp.runtime": { "subagents": [{ "name": "helper", "agent": "claude" }], "capped": { "mode": "edits" } } });
    let made = api.cmd("runtime.create", json!({ "prompt": "lead", "cwd": dir.join("proj"), "agent": "claude", "ext": team })).await;
    let lead = made["id"].as_str().unwrap().to_owned();
    api.until(&lead, "the lead running", |t| t.len() == 1 && t[0]["status"] == "running").await;
    let out = api.cmd("runtime.delegate", json!({ "id": lead, "tasks": [{ "subagent": "helper", "prompt": "do x" }, { "subagent": "nobody", "prompt": "y" }, { "subagent": "helper", "prompt": "" }] })).await;
    assert!(out[0]["error"].is_null(), "{out}");
    assert_eq!(out[1]["error"], "No subagent named \"nobody\". The team: helper.");
    assert_eq!(out[2]["error"], "The task prompt is empty.");
    let child = out[0]["id"].as_str().unwrap().to_owned();
    let c = api.cmd("runtime.get", json!({ "id": child })).await;
    assert_eq!(c["parentId"], lead.as_str());
    assert_eq!(c["ext"]["wisp.runtime"]["capped"]["mode"], "edits", "the child keeps the lead's cap");
    // the member is busy: a second task for it is refused until it's done
    let busy = api.cmd("runtime.delegate", json!({ "id": lead, "tasks": [{ "subagent": "helper", "prompt": "more" }] })).await;
    assert!(busy[0]["error"].as_str().unwrap().contains("still working"), "{busy}");
    let reports = api.cmd("runtime.results", json!({ "id": lead, "ids": [], "wait": 30 })).await;
    assert_eq!(reports["reports"][0]["done"], true, "{reports}");
    assert_eq!(reports["reports"][0]["subagent"], "helper");
    let lt = made["turnId"].as_str().unwrap();
    assert!(activity(&api, &lead, lt).await.iter().any(|l| l == "Delegated to helper"));
    drop(serve);
    let _ = c;
}

#[tokio::test(flavor = "multi_thread")]
async fn my_stuff_saves_and_lists_over_http() {
    let dir = temp("serve-stuff");
    let (serve, port) = start(&dir);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let saved = api.cmd("stuff.save", json!({ "text": "# Notes\nkeep this", "name": "notes.md" })).await;
    assert_eq!(saved["kind"], "doc", "{saved}");
    let list: Value = serde_json::from_slice(&api.http.get(format!("http://127.0.0.1:{port}/api/stuff")).send().await.unwrap().bytes().await.unwrap()).unwrap();
    assert_eq!(list["items"].as_array().map(Vec::len), Some(1), "{list}");
    assert_eq!(list["items"][0]["id"], saved["id"]);
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn mcp_lists_its_tools_and_runs_one() {
    let dir = temp("serve-mcp");
    let (serve, port) = start(&dir);
    let http = reqwest::Client::new();
    let rpc = |body: Value| {
        let http = http.clone();
        async move {
            let r = http.post(format!("http://127.0.0.1:{port}/api/mcp")).header("content-type", "application/json").body(body.to_string()).send().await.unwrap();
            let status = r.status().as_u16();
            let bytes = r.bytes().await.unwrap();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null))
        }
    };
    let (_, init) = rpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "protocolVersion": "2025-06-18" } })).await;
    assert_eq!(init["result"]["serverInfo"]["name"], "wisp", "{init}");
    let (_, list) = rpc(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
    let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    for want in ["wisp_launch", "wisp_list", "wisp_get", "wisp_wait", "wisp_reply", "wisp_stop", "wisp_agents"] {
        assert!(names.contains(&want), "{want} in {names:?}");
    }
    // a notification gets no answer
    let (status, _) = rpc(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
    assert_eq!(status, 202);
    // a tool runs as the user's own command
    let api = Api { http: http.clone(), port, n: 0.into() };
    let made = api.cmd("runtime.create", json!({ "prompt": "fix add TOPIC[Fix add]", "cwd": dir.join("proj"), "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn", |t| t.len() == 1 && ended(&t[0])).await;
    let (_, called) = rpc(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "wisp_list", "arguments": {} } })).await;
    let text = called["result"]["content"][0]["text"].as_str().unwrap_or_default();
    assert!(text.contains(&id) && text.contains("Fix add"), "{called}");
    let (_, got) = rpc(json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": { "name": "wisp_get", "arguments": { "id": id } } })).await;
    assert!(got["result"]["content"][0]["text"].as_str().unwrap_or_default().contains("Fake claude finished"), "{got}");
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crew_check_in_runs_as_a_task_with_the_crew_note() {
    let dir = temp("serve-crew");
    let rec = dir.join("rec");
    std::fs::create_dir_all(&rec).unwrap();
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let made = api.cmd("crew.create", json!({ "name": "Scout", "role": "CI watcher", "brief": "Watch CI on main.", "agent": "claude", "cwd": dir.join("proj"), "cron": "*/30 * * * *", "checkin": true })).await;
    let member = made["id"].as_str().unwrap().to_owned();
    let task = made["session"]["id"].as_str().unwrap_or_else(|| panic!("a first check-in started: {made}")).to_owned();
    let t = api.until(&task, "the check-in", |t| t.len() == 1 && ended(&t[0])).await;
    assert_eq!(t[0]["status"], "done");
    assert_eq!(t[0]["prompt"], "Check-in #1: do your standing job and report what changed.");
    let s = api.cmd("runtime.get", json!({ "id": task })).await;
    assert_eq!(s["ext"]["wisp.crew"]["id"], member.as_str());
    assert_eq!(s["ext"]["wisp.crew"]["job"], "checkin");
    // the job's system prompt carried who the member is (runtime.prompt@1)
    let log = std::fs::read_to_string(rec.join("claude.jsonl")).unwrap();
    assert!(log.contains("You are Scout, on the user") && log.contains("Watch CI on main."), "{log}");
    // the member counted its check-in, and the job is on its list
    let got = api.cmd("crew.get", json!({ "id": member })).await;
    assert_eq!(got["checkins"], 1);
    assert_eq!(got["jobList"].as_array().map(Vec::len), Some(1), "{got}");
    assert!(got["nextAt"].is_number(), "its cron says when it checks in next: {got}");
    let list = api.cmd("crew.list", json!({})).await;
    assert_eq!(list.as_array().map(Vec::len), Some(1));
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn v1_files_are_imported_once_and_rows_live_in_the_store() {
    let dir = temp("serve-store");
    let home = dir.join("home");
    std::fs::create_dir_all(&home).unwrap();
    // v1's config.json crew and Settings → Auto, and its router.json
    std::fs::write(home.join("config.json"), json!({
        "crew": [{ "id": "v1scout0001", "name": "Scout", "agent": "claude", "mode": "auto", "parallel": 2, "createdAt": 1, "updatedAt": 1, "wakeAt": null, "lastCheckinAt": null, "lastMinute": null }],
        "crewLayout": { "v1scout0001": { "x": 40, "y": 10 } },
        "defaults": { "router": { "goal": "cheap", "explore": false } }
    }).to_string()).unwrap();
    std::fs::write(home.join("router.json"), json!({ "version": 2, "arms": { "claude:opus": { "firstSeen": 5, "state": "ready" } }, "stats": {}, "routes": {}, "taste": {}, "pairs": [] }).to_string()).unwrap();
    let (serve, port) = start(&dir);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let crew = api.cmd("crew.list", json!({})).await;
    assert_eq!(crew[0]["name"], "Scout", "v1's crew was imported: {crew}");
    assert_eq!(api.cmd("crew.layout", json!({})).await["v1scout0001"], json!({ "x": 40, "y": 10 }));
    let r = api.cmd("router.view", json!({})).await;
    assert_eq!(r["goal"], "cheap", "v1's defaults.router: {}", r["settings"]);
    let db = wisp_store::rusqlite::Connection::open(home.join("wisp.db")).unwrap();
    let arm: String = db.query_row("SELECT body FROM router_arm WHERE id = 'claude:opus'", [], |r| r.get(0)).unwrap();
    assert!(arm.contains("firstSeen"), "v1's arms are rows: {arm}");
    drop(db);
    // changes made here
    api.cmd("crew.create", json!({ "name": "Quill", "agent": "claude" })).await;
    api.cmd("router.set", json!({ "goal": "best" })).await;
    let saved = api.cmd("stuff.save", json!({ "text": "keep me", "name": "k.md" })).await;
    serve.stop();
    assert!(home.join("wisp.db").is_file());
    assert!(!home.join("crew.json").exists() && !home.join("stuff/rows").exists(), "no files of their own beside the store");

    // a restart reads it all back from the store; v1's files aren't imported over it again
    let (serve, port) = start(&dir);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let crew = api.cmd("crew.list", json!({})).await;
    let names: Vec<&str> = crew.as_array().unwrap().iter().filter_map(|m| m["name"].as_str()).collect();
    assert_eq!(names.len(), 2, "{names:?}");
    assert!(names.contains(&"Quill") && names.contains(&"Scout"));
    assert_eq!(api.cmd("router.view", json!({})).await["goal"], "best", "the change, not v1's again");
    let got = api.cmd("stuff.get", json!({ "id": saved["id"] })).await;
    assert_eq!(got["id"], saved["id"]);
    drop(serve);
}

#[tokio::test(flavor = "multi_thread")]
async fn the_agent_reaches_wisp_over_mcp_with_its_own_token() {
    let dir = temp("serve-agent");
    let rec = dir.join("rec");
    std::fs::create_dir_all(&rec).unwrap();
    let (serve, port) = start_with(&dir, &[("FAKE_DELAY", "3000"), ("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let made = api.cmd("runtime.create", json!({ "prompt": "hi", "cwd": dir.join("proj"), "agent": "claude" })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the turn running", |t| t.len() == 1 && t[0]["status"] == "running").await;
    // what the run was launched with: wisp's MCP server, at this wisp, with a token for this task
    let mut line = String::new();
    for _ in 0..40 {
        line = std::fs::read_to_string(rec.join("claude.jsonl")).unwrap_or_default();
        if !line.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    let argv: Vec<String> = serde_json::from_str::<Value>(line.lines().next().unwrap()).unwrap()["argv"].as_array().unwrap().iter().filter_map(|a| a.as_str().map(str::to_owned)).collect();
    let cfg_at = argv.iter().position(|a| a == "--mcp-config").expect("--mcp-config");
    let cfg: Value = serde_json::from_str(&argv[cfg_at + 1]).unwrap();
    let wisp = &cfg["mcpServers"]["wisp"];
    assert_eq!(wisp["url"], format!("http://127.0.0.1:{port}/api/mcp"));
    let token = wisp["headers"]["x-wisp-token"].as_str().unwrap().to_owned();
    assert_eq!(wisp["headers"]["x-wisp-session"], id.as_str());
    assert!(argv.iter().any(|a| a == "mcp__wisp"), "its tools are allowed: {argv:?}");

    let sid = id.clone();
    let mcp = |body: Value, token: String| {
        let (http, sid) = (api.http.clone(), sid.clone());
        async move {
            let r = http.post(format!("http://127.0.0.1:{port}/api/mcp")).header("content-type", "application/json").header("x-wisp-token", token).header("x-wisp-session", sid.clone()).body(body.to_string()).send().await.unwrap();
            let status = r.status().as_u16();
            (status, serde_json::from_slice::<Value>(&r.bytes().await.unwrap()).unwrap_or(Value::Null))
        }
    };
    let (st, list) = mcp(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }), token.clone()).await;
    assert_eq!(st, 200, "{list}");
    let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str()).collect();
    assert!(names.contains(&"ask_user") && names.contains(&"wisp_save") && !names.contains(&"wisp_list"), "the agent's tools, not the editor's: {names:?}");
    // a token for another task is refused
    let (status, _) = mcp(json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" }), "not-a-token".into()).await;
    assert_eq!(status, 403);
    // ask_user blocks in the agent's tool call until the user answers
    let asked = tokio::spawn(mcp(json!({ "jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": { "name": "ask_user", "arguments": { "question": "Which branch?" } } }), token.clone()));
    let mut waiting = false;
    for _ in 0..50 {
        if api.cmd("runtime.get", json!({ "id": id })).await["state"] == "waiting" {
            waiting = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    assert!(waiting, "the task waits on the user");
    api.cmd("runtime.followUp", json!({ "id": id, "text": "dev" })).await;
    let (_, answered) = asked.await.unwrap();
    assert!(answered["result"]["content"][0]["text"].as_str().unwrap_or_default().contains("dev"), "{answered}");
    drop(serve);
}
