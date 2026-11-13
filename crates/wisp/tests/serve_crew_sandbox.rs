//! A crew member whose jobs run in a sandbox (ADR-0047), on a local grid (`wisp-grid dev`: each box a wisp process):
//! the job is kept here as `<machine>|<id>`. Asked in a task here, its answer lands under the question (the job's turn
//! ends on the sandbox, where no member is: this wisp reports it from the sandbox's mirrored row); a reply to that
//! answer reaches the same job there (`machines.route`), and its next answer lands under the reply.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines)]

mod common;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use base64::Engine as _;
use common::{Api, Serve, start_with, temp};
use serde_json::{Value, json};

fn git(at: &Path, args: &[&str]) {
    let o = Command::new("git").current_dir(at).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

async fn approve(port: u16, url: &str, handle: &str, code: &str) {
    let b = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .no_proxy()
        .resolve("wisp.localhost", SocketAddr::from(([127, 0, 0, 1], port)))
        .build()
        .unwrap();
    let r = b.get(format!("{url}/auth/dev?handle={handle}")).send().await.unwrap();
    let cookie = r.headers().get("set-cookie").unwrap().to_str().unwrap().split(';').next().unwrap().to_owned();
    let page = b.get(format!("{url}/activate?code={code}")).header("cookie", &cookie).send().await.unwrap().text().await.unwrap();
    let csrf = page.split("name=\"csrf\" value=\"").nth(1).unwrap().split('"').next().unwrap().to_owned();
    let r = b
        .post(format!("{url}/activate"))
        .header("cookie", &cookie)
        .json(&json!({ "csrf": csrf, "code": code, "answer": "allow" }))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status(), 200);
}

async fn until(what: &str, secs: u64, mut f: impl AsyncFnMut() -> Option<Value>) -> Value {
    let at = Instant::now();
    loop {
        if let Some(v) = f().await {
            return v;
        }
        assert!(at.elapsed() < Duration::from_secs(secs), "{what}");
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// This wisp signed in to a local grid, Claude signed in for sandboxes; a task here (done) in a git project; a member
/// whose jobs run in a sandbox of their own.
struct Setup {
    api: Api,
    task: String,
    member: String,
    stop: Box<dyn FnOnce() + Send>,
    _serve: Serve,
    _grid: Box<dyn std::any::Any>,
}

async fn setup(name: &str) -> Setup {
    let dir = temp(name);
    let proj = dir.join("proj");
    git(&proj, &["init", "-q", "-b", "main"]);
    git(&proj, &["add", "."]);
    git(&proj, &["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-qm", "first"]);
    let (serve, port) = start_with(&dir, &[("WISP_SANDBOX_TICK_MS", "500")]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let data = dir.join("grid");
    std::fs::create_dir_all(data.join("secrets")).unwrap();
    let key = base64::engine::general_purpose::STANDARD.encode([7u8; 32]);
    std::fs::write(data.join("secrets/master.json"), json!({ "current": "k1", "keys": { "k1": key } }).to_string()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(data.join("secrets/master.json"), std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let bin = dir.join("bin");
    let env = vec![
        ("WISP_WEB_DIR".into(), dir.join("no-web").display().to_string()),
        ("WISP_CLAUDE_BIN".into(), bin.join("claude").display().to_string()),
    ];
    let (grid, gport, stop) = wisp_grid::edge::dev(&data, 0, PathBuf::from(env!("CARGO_BIN_EXE_wisp")), env, 600_000).await.unwrap();
    let url = format!("http://wisp.localhost:{gport}");
    let f = api.cmd("grid-client.signin", json!({ "grid": url })).await;
    approve(gport, &url, "ada", f["userCode"].as_str().unwrap()).await;
    until("signed in", 30, async || {
        let s = api.cmd("grid-client.signinStatus", json!({ "id": f["id"] })).await;
        (s["state"] != "waiting").then_some(s)
    })
    .await;
    api.cmd("grid-client.sandboxLogin", json!({ "agent": "claude", "token": "sk-ant-oat01-test-token-for-every-sandbox-000" })).await;
    // the task the question is asked in: here, done
    let task = api.cmd("runtime.create", json!({ "prompt": "fix the add bug", "cwd": proj, "agent": "claude" })).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    until("the task here ends", 30, async || {
        let s = api.cmd("runtime.get", json!({ "id": task })).await;
        (s["state"] != "running").then_some(s)
    })
    .await;
    let made = api.cmd("crew.create", json!({ "name": "Scout", "agent": "claude", "cwd": proj, "sandbox": "own" })).await;
    let member = made["member"]["id"].as_str().or_else(|| made["id"].as_str()).unwrap_or_else(|| panic!("{made}")).to_owned();
    Setup { api, task, member, stop: Box::new(move || stop.cancel()), _serve: serve, _grid: Box::new(grid) }
}

/// The crew's answers on the task's turns, in order.
async fn answers(api: &Api, task: &str) -> Vec<Value> {
    let turns = api.cmd("runtime.turns", json!({ "id": task })).await;
    let list = turns.as_array().cloned().or_else(|| turns["turns"].as_array().cloned()).unwrap_or_default();
    list.iter().flat_map(|t| t["ext"]["wisp.crew"]["answers"].as_array().cloned().unwrap_or_default()).collect()
}

async fn answered(api: &Api, task: &str, entry: &str) -> Value {
    until(&format!("entry {entry} is answered"), 90, async || {
        answers(api, task).await.into_iter().find(|a| a["id"] == entry && a["status"] != "running")
    })
    .await
}

/// The sandbox's job, through `machines.route`.
async fn on_sandbox(api: &Api, job: &str, cmd: &str) -> Value {
    let (machine, id) = job.split_once('|').unwrap_or_else(|| panic!("a sandbox's job is `<machine>|<id>`: {job}"));
    api.cmd("machines.route", json!({ "id": machine, "cmd": cmd, "args": { "id": id }, "mid": format!("t-{cmd}-{}", rand_id()) })).await
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sandboxed_jobs_report_lands_under_the_question() {
    let s = setup("serve-crew-sandbox-report").await;
    let asked = s.api.cmd("crew.ask", json!({ "sessionId": s.task, "id": s.member, "text": "is the add bug fixed?" })).await;
    let job = asked["job"].as_str().unwrap_or_else(|| panic!("the entry names its job: {asked}")).to_owned();
    assert!(job.contains('|'), "it runs in the sandbox: {job}");
    let a = answered(&s.api, &s.task, asked["id"].as_str().unwrap()).await;
    assert_eq!(
        (a["status"].as_str(), a["answer"].as_str()),
        (Some("done"), Some("All done.")),
        "the sandbox's answer, under the question here: {a}"
    );
    let there = on_sandbox(&s.api, &job, "runtime.get").await;
    assert_eq!(there["ext"]["wisp.crew"]["reply"]["sessionId"], s.task.as_str(), "the job there points at the question here: {there}");
    (s.stop)();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_sandboxed_jobs_reply_reaches_it_and_its_answer_lands_under_the_reply() {
    let s = setup("serve-crew-sandbox-reply").await;
    let asked = s.api.cmd("crew.ask", json!({ "sessionId": s.task, "id": s.member, "text": "is the add bug fixed?" })).await;
    let job = asked["job"].as_str().unwrap().to_owned();
    answered(&s.api, &s.task, asked["id"].as_str().unwrap()).await;
    // the reply: no longer "That job is gone."; it threads after the answer and goes to the same job, in its sandbox
    let reply = s.api.cmd("crew.reply", json!({ "sessionId": s.task, "entry": asked["id"], "text": "and the tests too?" })).await;
    let entry = reply["id"].as_str().unwrap_or_else(|| panic!("{reply}")).to_owned();
    assert_eq!((reply["job"].as_str(), reply["thread"].as_str()), (Some(job.as_str()), asked["id"].as_str()), "{reply}");
    let a = answered(&s.api, &s.task, &entry).await;
    assert_eq!((a["status"].as_str(), a["answer"].as_str()), (Some("done"), Some("All done.")), "its next answer, under the reply: {a}");
    let turns = on_sandbox(&s.api, &job, "runtime.turns").await;
    let turns = turns.as_array().cloned().unwrap_or_default();
    assert_eq!(turns.len(), 2, "the reply ran as the job's next turn there: {turns:?}");
    assert!(turns[1]["prompt"].as_str().unwrap_or_default().contains("and the tests too?"), "{turns:?}");
    // the first answer is kept as it was
    let first = answers(&s.api, &s.task).await.into_iter().find(|x| x["id"] == asked["id"]).unwrap();
    assert_eq!(first["status"], "done", "{first}");
    (s.stop)();
}

fn rand_id() -> String {
    format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())
}
