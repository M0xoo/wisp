use serde_json::json;

use super::*;

const TAG: Tag<'static> = Tag {
    id: "m1",
    name: "devbox",
    target: "me@devbox",
    sandbox: false,
};

fn no_project(_: &str) -> Option<(String, String, Option<String>)> {
    None
}

#[test]
fn only_own_ids_pass_so_two_wisps_never_loop() {
    assert_eq!(
        relay("m1", "summary", json!({"id": "s1@m2", "title": "theirs"})),
        Relayed::Drop
    );
    assert_eq!(
        relay("m1", "summary", json!({"id": "s1", "agent": "wisp"})),
        Relayed::Drop
    );
    assert_eq!(
        relay("m1", "summary", json!({"id": "s1", "delegated": true})),
        Relayed::Drop
    );
    assert_eq!(
        relay("m1", "summary", json!({"id": "s1"})),
        Relayed::Upsert(json!({"id": "s1"}))
    );
    assert_eq!(
        relay("m1", "removed", json!({"id": "s1"})),
        Relayed::Removed("s1".into())
    );
    assert_eq!(
        relay("m1", "activity", json!({"sessionId": "s1", "x": 1})),
        Relayed::Pass {
            event: "activity".into(),
            data: json!({"sessionId": "s1@m1", "x": 1})
        }
    );
    assert_eq!(
        relay("m1", "turn", json!({"sessionId": "s1@m9"})),
        Relayed::Drop
    );
    assert_eq!(
        relay(
            "m1",
            "finished",
            json!({"session": {"id": "s1", "agent": "wisp"}})
        ),
        Relayed::Drop
    );
    assert!(matches!(
        relay("m1", "finished", json!({"session": {"id": "s1"}})),
        Relayed::Finished { .. }
    ));
    assert_eq!(relay("m1", "config", json!({})), Relayed::Drop);
    assert_eq!(
        own_rows(
            &json!([{"id": "a"}, {"id": "b@m2"}, {"id": "c", "agent": "wisp"}, {"id": "d", "delegated": true}, {"x": 1}])
        ),
        [json!({"id": "a"})]
    );
}

#[test]
fn a_summary_is_qualified_and_tagged() {
    let s = json!({"id": "s1", "parentId": "p1", "forkedFrom": {"id": "f1", "turn": 2}, "forks": ["k1"], "group": [{"id": "g1"}], "cwd": "/w/app", "project": "app"});
    let pf = |cwd: &str| {
        (cwd == "/w/app").then(|| {
            (
                "proj1".to_owned(),
                "App".to_owned(),
                Some("#f00".to_owned()),
            )
        })
    };
    let v = summary(&TAG, &pf, &s);
    assert_eq!(v["id"], "s1@m1");
    assert_eq!(v["parentId"], "p1@m1");
    assert_eq!(v["forkedFrom"], json!({"id": "f1@m1", "turn": 2}));
    assert_eq!(v["forks"], json!(["k1@m1"]));
    assert_eq!(v["group"][0]["id"], "g1@m1");
    assert_eq!(v["groupId"], Value::Null);
    assert_eq!(
        (
            v["projectId"].clone(),
            v["project"].clone(),
            v["color"].clone()
        ),
        (json!("proj1"), json!("App"), json!("#f00"))
    );
    assert_eq!(
        v["machine"],
        json!({"id": "m1", "name": "devbox", "target": "me@devbox"})
    );
    let scratch = summary(
        &TAG,
        &pf,
        &json!({"id": "s2", "scratch": true, "cwd": "/w/app", "project": "x"}),
    );
    assert_eq!(
        (scratch["projectId"].clone(), scratch["project"].clone()),
        (Value::Null, json!("x"))
    );
    let sb = Tag {
        sandbox: true,
        ..TAG
    };
    assert_eq!(
        summary(&sb, &no_project, &json!({"id": "s"}))["machine"],
        json!({"id": "m1", "name": "Sandbox", "target": "me@devbox", "sandbox": true})
    );
}

#[test]
fn a_session_qualifies_children_delegations_and_attachments() {
    let s = json!({"id": "s1", "groupId": "g", "children": {"mate": "c1"}, "childSessions": {"c1": {"id": "c1"}}, "turns": [{"delegations": [{"sessionId": "c1", "name": "mate"}], "attachments": [{"id": "u1"}]}]});
    let v = session(&TAG, &s);
    assert_eq!(v["groupId"], "g");
    assert_eq!(v["children"], json!({"mate": "c1@m1"}));
    assert_eq!(v["childSessions"]["c1@m1"]["id"], "c1@m1");
    assert_eq!(v["turns"][0]["delegations"][0]["sessionId"], "c1@m1");
    assert_eq!(v["turns"][0]["attachments"][0]["id"], "u1@m1");
    assert_eq!(session(&TAG, &json!({"id": "x"}))["turns"], json!([]));
}
