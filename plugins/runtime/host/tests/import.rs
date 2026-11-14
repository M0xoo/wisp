//! v1's sessions folder into the store (plan §4.8): one transaction per file, resumable by (file, mtime,
//! size), v1 activity kept as it was (`v = 0`, read through the upcaster), and the dual write giving v1
//! its file back at a turn's end.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use serde_json::json;
use wisp_runtime_api::commands::ListArgs;
use wisp_runtime_api::model::{Activity, TurnStatus};

fn v1(id: &str, title: &str) -> serde_json::Value {
    json!({
        "id": id, "title": title, "titleAuto": false, "agent": "fake", "model": "m1", "effort": "", "mode": "auto", "cwd": "/repo",
        "state": "review", "unread": true, "createdAt": 1, "updatedAt": 2, "agentSessionId": "conv-9", "goal": {"text": "green"}, "queue": [],
        "turns": [{"id": format!("{id}-t1"), "prompt": "fix", "agent": "fake", "model": "m1", "effort": "", "mode": "auto", "attachments": [],
            "startedAt": 1, "endedAt": 2, "status": "done", "raw": "done",
            "presentation": {"blocks": [{"type": "hero", "title": "Fixed", "summary": "it works", "status": "done"}]},
            "activity": [{"t": 1, "kind": "run", "label": "npm test", "call": "c1"}, {"t": 2, "kind": "text", "label": "done"}], "changes": []}]
    })
}

#[tokio::test(flavor = "multi_thread")]
async fn a_v1_folder_imports_once_and_again_when_v1_rewrites_a_file() {
    let r = common::rig().await;
    let dir = std::env::temp_dir().join(format!("wisp-v1-{}", wisp_kernel::ids::uuid7()));
    std::fs::create_dir_all(dir.join(".light")).unwrap();
    std::fs::write(dir.join("aaa111.json"), v1("aaa111", "First").to_string()).unwrap();
    std::fs::write(dir.join("bbb222.json"), v1("bbb222", "Second").to_string()).unwrap();
    std::fs::write(dir.join("broken.json"), "{ not json").unwrap();
    let rep = r.rt.import_v1(Some(dir.clone())).await.unwrap();
    assert_eq!((rep.imported, rep.failed.len()), (2, 1));
    let rows = r.rt.list(&ListArgs::default());
    assert_eq!(rows.len(), 2);
    let row = rows.iter().find(|x| x.id.as_str() == "aaa111").unwrap();
    assert_eq!((row.title.as_str(), row.preview.as_str(), row.status.as_str()), ("First", "it works", "done"));
    let s = r.rt.get("aaa111").await.unwrap();
    assert_eq!(s.ext["v1"]["goal"]["text"], "green");
    let t = r.rt.turns("aaa111", None, None).await.unwrap().pop().unwrap();
    assert_eq!(t.status, TurnStatus::Done);
    let steps = r.rt.activity(t.id.as_str(), None).await.unwrap().items;
    assert!(matches!(&steps[0].activity, Activity::Tool { label, call_id: Some(c), .. } if label == "npm test" && c == "c1"));
    // the stored presentation came from v1's parser: it is rebuilt from the answer on first read
    assert!(r.rt.presentation("aaa111", None).await.unwrap().unwrap().v >= 1);
    // unchanged files are skipped; a file v1 rewrote imports again, over its old rows
    assert_eq!(r.rt.import_v1(Some(dir.clone())).await.unwrap().imported, 0);
    std::thread::sleep(std::time::Duration::from_millis(20));
    std::fs::write(dir.join("aaa111.json"), v1("aaa111", "First, renamed in v1").to_string()).unwrap();
    assert_eq!(r.rt.import_v1(Some(dir.clone())).await.unwrap().imported, 1);
    assert_eq!(r.rt.get("aaa111").await.unwrap().title, "First, renamed in v1");
    assert_eq!(r.rt.activity(t.id.as_str(), None).await.unwrap().items.len(), 2, "its log was replaced, not doubled");
    let _ = std::fs::remove_dir_all(&dir);
}
