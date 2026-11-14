//! A lead task hands a job to a crew member (F-crew-11, v1 crew.js `#delegate`), end to end on `wisp serve` with the
//! fake claude: `runtime.delegate` asks `crew.assign` with `from` = the lead, so the job is a task of its own run as
//! the member (their folder, harness), recorded `delegated` from the lead (what the lead's Team tab lists), and the
//! lead reads its report with `runtime.results` as it would a subagent's.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::{Api, start_with, temp};
use serde_json::json;

#[tokio::test(flavor = "multi_thread")]
async fn a_lead_delegates_to_a_crew_member_and_reads_the_jobs_report() {
    let dir = temp("crew-delegate");
    let (serve, port) = start_with(&dir, &[("FAKE_DELAY", "1500")]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let theirs = dir.join("ada-proj");
    std::fs::create_dir_all(&theirs).unwrap();
    let made = api.cmd("crew.create", json!({ "name": "Ada", "agent": "claude", "cwd": theirs, "parallel": 1 })).await;
    let member = made["member"]["id"].as_str().or_else(|| made["id"].as_str()).unwrap_or_else(|| panic!("{made}")).to_owned();

    let team = json!({ "wisp.runtime": { "subagents": [{ "name": "ada", "label": "Ada", "agent": "auto", "crew": member }] } });
    let lead = api.cmd("runtime.create", json!({ "prompt": "lead", "cwd": dir.join("proj"), "agent": "claude", "ext": team })).await;
    let lead_id = lead["id"].as_str().unwrap().to_owned();
    api.until(&lead_id, "the lead running", |t| t.len() == 1 && t[0]["status"] == "running").await;

    let out = api.cmd("runtime.delegate", json!({ "id": lead_id, "tasks": [{ "subagent": "ada", "prompt": "fix the flaky test" }] })).await;
    assert!(out[0]["error"].is_null(), "{out}");
    assert_eq!(out[0]["place"], "crew", "{out}");
    let job_id = out[0]["id"].as_str().unwrap().to_owned();

    // a task of its own, run as the member, delegated from the lead (not a hidden child)
    let job = api.cmd("runtime.get", json!({ "id": job_id })).await;
    assert_eq!(job["cwd"], theirs.display().to_string(), "the member's folder: {job}");
    assert_eq!(job["agent"], "claude");
    assert!(job["parentId"].is_null(), "{job}");
    let crew = &job["ext"]["wisp.crew"];
    assert_eq!(crew["id"], member.as_str(), "{job}");
    assert_eq!(crew["job"], "delegated", "{job}");
    assert_eq!(crew["from"]["id"], lead_id.as_str(), "the Team tab lists it under the lead: {job}");

    // at the member's limit: refused (never queued), so the lead can wait for one or do it itself
    let busy = api.cmd("runtime.delegate", json!({ "id": lead_id, "tasks": [{ "subagent": "ada", "prompt": "more" }] })).await;
    assert!(busy[0]["error"].as_str().unwrap_or_default().contains("their limit"), "{busy}");

    // wait:false first: running, not done; then wait for it
    let now = api.cmd("runtime.results", json!({ "id": lead_id, "ids": [], "wait": 0 })).await;
    assert_eq!(now["reports"][0]["done"], false, "{now}");
    let reports = api.cmd("runtime.results", json!({ "id": lead_id, "ids": [job_id], "wait": 30 })).await;
    let r = &reports["reports"][0];
    assert_eq!(r["done"], true, "{reports}");
    assert_eq!(r["subagent"], "ada");
    assert!(!r["text"].as_str().unwrap_or_default().is_empty(), "{reports}");
    drop(serve);
}
