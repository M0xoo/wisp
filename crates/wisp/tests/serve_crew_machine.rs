//! A crew member on another machine (F-crew-9, v1 crew.js `{ machine: m.machine }`): two `wisp serve` on this
//! computer, the second added to the first as a `loopback` machine (as `serve_machines.rs` does). A member whose
//! `machine` is that peer runs each job there, in a folder there, kept here as `<machine>|<id>`; its memory, schedule
//! and answers stay here. Asked in a task here, its job's turn ends on the other wisp, where no member is, and this
//! wisp reports it from the peer's mirrored row: the answer lands under the question.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::time::{Duration, Instant};

use common::{Api, start, temp};
use serde_json::{Value, json};

async fn until(what: &str, secs: u64, mut f: impl AsyncFnMut() -> Option<Value>) -> Value {
    let at = Instant::now();
    loop {
        if let Some(v) = f().await {
            return v;
        }
        assert!(at.elapsed() < Duration::from_secs(secs), "{what}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn answers(api: &Api, task: &str) -> Vec<Value> {
    let turns = api.cmd("runtime.turns", json!({ "id": task })).await;
    let list = turns.as_array().cloned().or_else(|| turns["turns"].as_array().cloned()).unwrap_or_default();
    list.iter().flat_map(|t| t["ext"]["wisp.crew"]["answers"].as_array().cloned().unwrap_or_default()).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_members_job_on_another_machine_runs_there_and_its_answer_lands_here() {
    let (da, db) = (temp("crew-machine-a"), temp("crew-machine-b"));
    let (_sa, pa) = start(&da);
    let (_sb, pb) = start(&db);
    let a = Api { http: reqwest::Client::new(), port: pa, n: 0.into() };
    let b = Api { http: reqwest::Client::new(), port: pb, n: 0.into() };

    // a machine this wisp doesn't know is refused, as v1's machineOk
    let refused = a.try_cmd("crew.create", json!({ "name": "Scout", "agent": "claude", "machine": "nope" })).await;
    assert_eq!(refused["ok"], false, "{refused}");
    assert!(refused["error"]["message"].as_str().unwrap_or_default().contains("isn’t one of yours"), "{refused}");

    let added = a.cmd("machines.add", json!({ "transport": "loopback", "address": "127.0.0.1", "port": pb, "name": "studio" })).await;
    let machine = added["id"].as_str().unwrap().to_owned();
    until("the peer comes online", 60, async || {
        let v = a.cmd("machines.get", json!({ "id": machine })).await;
        (v["state"] == "online").then_some(v)
    })
    .await;

    // the task the question is asked in: here, done
    let task = a.cmd("runtime.create", json!({ "prompt": "fix the add bug", "cwd": da.join("proj"), "agent": "claude" })).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    until("the task here ends", 30, async || {
        let s = a.cmd("runtime.get", json!({ "id": task })).await;
        (s["state"] != "running").then_some(s)
    })
    .await;

    // its folder is one on the other machine (not checked here, as v1)
    let there_dir = db.join("proj").display().to_string();
    let made = a
        .cmd(
            "crew.create",
            json!({ "name": "Scout", "agent": "claude", "machine": machine, "cwd": there_dir, "brief": "Watch the add bug." }),
        )
        .await;
    let member = made["member"]["id"].as_str().or_else(|| made["id"].as_str()).unwrap_or_else(|| panic!("{made}")).to_owned();

    let asked = a.cmd("crew.ask", json!({ "sessionId": task, "id": member, "text": "is the add bug fixed?" })).await;
    let job = asked["job"].as_str().unwrap_or_else(|| panic!("the entry names its job: {asked}")).to_owned();
    let (on, id) = job.split_once('|').unwrap_or_else(|| panic!("a job on a machine is `<machine>|<id>`: {job}"));
    assert_eq!(on, machine, "{job}");

    // it runs on the other wisp, in the folder there, and points back at the question here
    let there = b.cmd("runtime.get", json!({ "id": id })).await;
    assert_eq!(there["cwd"].as_str(), Some(there_dir.as_str()), "{there}");
    assert_eq!(there["ext"]["wisp.crew"]["id"], member.as_str(), "{there}");
    assert_eq!(there["ext"]["wisp.crew"]["reply"]["sessionId"], task.as_str(), "{there}");
    // no Scout over there: the job carries the note written here (who it is, its brief), v1 `crewJob.note`
    let note = there["ext"]["wisp.crew"]["note"].as_str().unwrap_or_default();
    assert!(note.contains("Scout") && note.contains("Watch the add bug."), "{there}");
    assert!(a.try_cmd("runtime.get", json!({ "id": id })).await["ok"] == false, "nothing of it runs here");

    // its turn ends there; the answer lands here, under the question
    let entry = asked["id"].as_str().unwrap().to_owned();
    let answer = until("the answer lands here", 90, async || {
        answers(&a, &task).await.into_iter().find(|x| x["id"] == entry.as_str() && x["status"] != "running")
    })
    .await;
    assert_eq!((answer["status"].as_str(), answer["answer"].as_str()), (Some("done"), Some("All done.")), "{answer}");

    // the member's page here lists the job, read from the machine
    let detail = a.cmd("crew.get", json!({ "id": member })).await;
    let jobs = detail["jobList"].as_array().cloned().unwrap_or_default();
    assert!(jobs.iter().any(|j| j["sessionId"] == job.as_str() && j["state"] != "running"), "{detail}");
}
