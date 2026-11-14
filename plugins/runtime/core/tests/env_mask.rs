//! A task's turns and events as they leave the server (ADR-0050): v1's maskSession / maskStep / unmasked cases on
//! v2's shapes, the patch ops the stream may carry, the answer's raw text, and the turn machine's `env` flag.
#![allow(clippy::unwrap_used)]

use serde_json::{Value, json};
use wisp_envmask::DOTS;
use wisp_runtime_api::harness::HarnessEvent;
use wisp_runtime_api::model::{Activity, ToolKind};
use wisp_runtime_core::activity::{Effect, EnvValues, Head, apply};
use wisp_runtime_core::env_mask::{
    Item, mask_answer_text, mask_event_rows, mask_patch, mask_row, mask_step, mask_steps, mask_turn, unmasked_of_turn, unmasked_step,
};

fn turn() -> Value {
    json!({
        "id": "t1",
        "text": "Done.\n```wisp\n{\"blocks\":[{\"type\":\"code\",\"file\":\".env\",\"code\":\"K=v-secret\"}]}\n```",
        "presentation": { "v": 1, "blocks": [
            { "type": "hero", "title": "x" },
            { "type": "diff", "file": "cfg/.env.local", "before": "K=a-secret", "after": "K=b-secret" },
            { "type": "code", "file": ".env", "code": "K=v-secret" },
            { "type": "diff", "file": ".env" },
            { "type": "code", "file": ".env.example", "code": "S=changeme" }
        ] },
        "ext": { "wisp.runtime": { "changes": [
            { "file": "/w/.env", "op": "edit", "edits": [{ "before": "S=0-secret", "after": "S=1-secret" }] },
            { "file": ".env.example", "op": "edit", "edits": [{ "before": "S=", "after": "S=changeme" }] }
        ] } }
    })
}

#[test]
fn a_turn_masks_its_blocks_changes_and_answer_text_and_keeps_templates_v1_mask_session() {
    let raw = turn();
    let mut t = raw.clone();
    assert!(mask_turn(&mut t));
    let j = t.to_string();
    assert!(!j.contains("-secret"), "{j}");
    let b = &t["presentation"]["blocks"];
    assert_eq!(b[1]["after"], format!("K={DOTS} (changed)"));
    assert_eq!(b[1]["masked"], true, "the page knows Reveal has something to ask for");
    assert_eq!(b[2]["code"], format!("K={DOTS}"));
    assert_eq!(b[3], raw["presentation"]["blocks"][3], "a diff block with nothing of its own");
    assert_eq!(b[4], raw["presentation"]["blocks"][4], ".env.example as it is");
    let c = &t["ext"]["wisp.runtime"]["changes"];
    assert_eq!(c[0]["edits"][0], json!({ "before": format!("S={DOTS}"), "after": format!("S={DOTS} (changed)") }));
    assert_eq!(c[0]["masked"], true);
    assert_eq!(c[1], raw["ext"]["wisp.runtime"]["changes"][1]);
    assert!(t["text"].as_str().unwrap().starts_with("Done.\n```wisp\n"), "the prose and the fence stay");
    let mut again = t.clone();
    assert!(!mask_turn(&mut again) || again == t, "masking twice changes nothing more");
}

#[test]
fn a_turn_row_masks_its_body_and_answer_column_and_any_other_row_goes_as_it_is() {
    let mut row = json!({ "id": "t1", "answer": turn()["text"], "body": turn() });
    assert!(mask_row("turn", &mut row));
    assert!(!row.to_string().contains("-secret"));
    let mut other = json!({ "id": "s", "body": turn() });
    assert!(!mask_row("session", &mut other), "not a kind this view owns");
}

#[test]
fn a_step_that_read_a_env_file_masks_its_output_others_as_they_are_v1_mask_step() {
    let mut s = json!({ "seq": 5, "kind": "tool", "tool": "run", "label": "Show the env", "detail": "cat .env", "output": "API_KEY=sk-123\nPORT=3000", "callId": "c1" });
    assert!(mask_step(&mut s));
    assert_eq!(s["output"], format!("API_KEY={DOTS}\nPORT={DOTS}"));
    let mut read = json!({ "kind": "tool", "tool": "read", "label": "Read", "file": "app/.env.local", "output": "S=1" });
    assert!(mask_step(&mut read));
    let mut ls = json!({ "kind": "tool", "tool": "run", "label": "ls", "detail": "ls", "output": "A=1" });
    assert!(!mask_step(&mut ls), "other commands as they are");
    let mut v1 = json!({ "t": 7, "kind": "run", "detail": "cat .env", "output": "A=1" });
    assert!(mask_step(&mut v1), "a v1 item the importer kept");
}

#[test]
fn a_tool_output_is_masked_when_the_turn_machine_flagged_it() {
    let mut flagged = json!({ "kind": "tool_output", "callId": "c1", "text": "SECRET=hunter2", "env": true });
    assert!(mask_step(&mut flagged));
    assert_eq!(flagged["text"], format!("SECRET={DOTS}"));
    let mut plain = json!({ "kind": "tool_output", "callId": "c2", "text": "SECRET=hunter2", "env": false });
    assert!(!mask_step(&mut plain));
}

#[test]
fn the_turn_machine_flags_the_output_of_a_call_that_read_a_env_file() {
    let mut h = Head::default();
    let no = |_: &str| false;
    let call = |id: &str, detail: &str| HarnessEvent::Tool {
        kind: ToolKind::Run,
        label: "Run".into(),
        file: None,
        detail: Some(detail.into()),
        id: Some(id.into()),
        output: None,
        title: None,
    };
    apply(&mut h, &call("c1", "cat .env.local"), false, &no);
    apply(&mut h, &call("c2", "ls"), false, &no);
    let out = |id: &str| HarnessEvent::ToolOutput { id: id.into(), text: "K=v".into() };
    assert!(matches!(apply(&mut h, &out("c1"), false, &no), Effect::Append(Activity::ToolOutput { env: true, .. })));
    assert!(matches!(apply(&mut h, &out("c2"), false, &no), Effect::Append(Activity::ToolOutput { env: false, .. })));
    let v = serde_json::to_value(Activity::ToolOutput { call_id: "c2".into(), text: "x".into(), env: false, hide: Vec::new() }).unwrap();
    assert_eq!(v["env"], false, "always written: a row without it is one from before the flag");
}

#[test]
fn an_answer_texts_env_blocks_are_masked_and_a_broken_block_naming_one_is_hidden_whole() {
    assert!(mask_answer_text("no blocks here, .env mentioned").is_none());
    assert!(mask_answer_text("```wisp\n{\"blocks\":[{\"type\":\"code\",\"file\":\"a.ts\",\"code\":\"K=1\"}]}\n```").is_none());
    let broken = "Prose.\n```wisp\n{\"blocks\":[{\"type\":\"code\",\"file\":\".env\",\"code\":\"K=sk-broken\",}]\n```\nafter";
    let m = mask_answer_text(broken).unwrap();
    assert!(!m.contains("sk-broken") && m.starts_with("Prose.\n```wisp\n") && m.ends_with("\n```\nafter"), "{m}");
    let two = "```wisp\n{\"blocks\":[{\"type\":\"code\",\"file\":\".env\",\"code\":\"A=sk-1\"}]}\n```\nthen\n```wisp\n[{\"type\":\"code\",\"path\":\"x/.env.prod\",\"code\":\"B=sk-2\"}]\n```";
    let m = mask_answer_text(two).unwrap();
    assert!(!m.contains("sk-1") && !m.contains("sk-2") && m.contains("\nthen\n"), "{m}");
}

#[test]
fn a_patch_op_is_masked_by_where_it_lands() {
    let mut block = json!({ "type": "code", "file": ".env", "code": "K=sk-p" });
    assert!(mask_patch("turn", "/body/presentation/blocks/2", &mut block));
    let mut ext = turn()["ext"].clone();
    assert!(mask_patch("turn", "/body/ext", &mut ext));
    assert!(!ext.to_string().contains("-secret"));
    let mut deep = json!("K=sk-deep");
    assert!(mask_patch("turn", "/body/presentation/blocks/2/code", &mut deep), "deeper than a block says no file: masked");
    let mut body = turn();
    assert!(mask_patch("turn", "/body", &mut body));
    let mut step = json!({ "kind": "tool", "tool": "run", "detail": "cat .env", "output": "K=sk-e" });
    assert!(mask_patch("event", "/body", &mut step));
    let mut title = json!("New title");
    assert!(!mask_patch("turn", "/body/title", &mut title), "elsewhere as it is");
    let mut esc = json!({ "changes": [{ "file": ".env", "edits": [{ "before": "A=sk-x", "after": "A=sk-y" }] }] });
    assert!(mask_patch("turn", "/body/ext/wisp.runtime", &mut esc));
}

#[test]
fn reveal_gives_the_stored_item_back_and_only_a_masked_one_v1_unmasked() {
    let t = turn();
    assert_eq!(unmasked_of_turn(&t, &Item::Block(1)).unwrap()["after"], "K=b-secret");
    assert_eq!(unmasked_of_turn(&t, &Item::Block(2)).unwrap()["code"], "K=v-secret");
    assert!(unmasked_of_turn(&t, &Item::Block(0)).is_none(), "the hero isn't masked: nothing to reveal");
    assert!(unmasked_of_turn(&t, &Item::Block(4)).is_none(), ".env.example isn't masked");
    assert!(unmasked_of_turn(&t, &Item::Block(99)).is_none());
    let mut with_before = t.clone();
    with_before["ext"]["wisp.runtime"]["changes"][0]["beforeFile"] = json!("S=0-secret\n");
    let c = unmasked_of_turn(&with_before, &Item::Change("/w/.env".into())).unwrap();
    assert_eq!(c["edits"][0]["after"], "S=1-secret");
    assert!(c.get("beforeFile").is_none(), "only rollback reads the file from before");
    assert!(unmasked_of_turn(&t, &Item::Change(".env.example".into())).is_none());
    let steps = vec![
        json!({ "seq": 1, "kind": "tool", "tool": "run", "detail": "cat .env", "output": "S=1", "callId": "c1" }),
        json!({ "seq": 2, "kind": "tool_output", "callId": "c1", "text": "S=2", "env": true }),
        json!({ "seq": 3, "kind": "tool", "tool": "run", "detail": "ls", "output": "a" }),
    ];
    assert_eq!(unmasked_step(&steps, 1).unwrap()["output"], "S=1");
    assert_eq!(unmasked_step(&steps, 2).unwrap()["text"], "S=2");
    assert!(unmasked_step(&steps, 3).is_none(), "not masked: nothing to reveal");
    assert!(unmasked_step(&steps, 9).is_none());
}

#[test]
fn empty_and_huge_turns() {
    let mut empty = json!({});
    assert!(!mask_turn(&mut empty));
    let blocks: Vec<Value> = (0..2000)
        .map(|i| json!({ "type": "code", "file": if i % 2 == 0 { ".env" } else { "a.rs" }, "code": format!("K{i}=sk-{i}") }))
        .collect();
    let mut big = json!({ "presentation": { "blocks": blocks } });
    assert!(mask_turn(&mut big));
    let j = big.to_string();
    assert!(!j.contains("K0=sk-0") && j.contains("K1=sk-1"), "the .env ones only");
}

#[test]
fn an_output_stored_before_the_flag_is_decided_by_its_call_in_the_batch_or_else_by_its_text() {
    let mut page = [
        json!({ "seq": 1, "kind": "tool", "tool": "run", "detail": "cat .env", "callId": "c1", "label": "Run" }),
        json!({ "seq": 2, "kind": "tool_output", "callId": "c1", "text": "TOKEN=sk-old" }),
        json!({ "seq": 3, "kind": "tool", "tool": "run", "detail": "printenv", "callId": "c2", "label": "Run" }),
        json!({ "seq": 4, "kind": "tool_output", "callId": "c2", "text": "HOME=/Users/me" }),
    ];
    assert!(mask_steps(page.iter_mut()));
    assert_eq!(page[1]["text"], format!("TOKEN={DOTS}"), "its call read .env");
    assert_eq!(page[3]["text"], "HOME=/Users/me", "its call didn't: as it is");
    // its call out of sight (a window split the pair): a text that reads like a .env file goes
    let mut alone = json!({ "kind": "tool_output", "callId": "c9", "text": "# keys\nAPI_KEY=sk-alone\nexport PORT=3000" });
    assert!(mask_step(&mut alone));
    let mut prose = json!({ "kind": "tool_output", "callId": "c9", "text": "Compiled 3 files\nok" });
    assert!(!mask_step(&mut prose), "anything else as it is");
    let mut flagged_off = json!({ "kind": "tool_output", "callId": "c9", "text": "API_KEY=x", "env": false });
    assert!(!mask_step(&mut flagged_off), "a flag written after ADR-0050 decides");
    let mut rows = [
        json!({ "seq": 1, "kind": "tool", "body": { "kind": "tool", "tool": "read", "file": "/w/.env.local", "callId": "r1", "label": "Read" } }),
        json!({ "seq": 2, "kind": "tool_output", "body": { "kind": "tool_output", "callId": "r1", "text": "DB=postgres://me:pw@db" } }),
    ];
    assert!(mask_event_rows(rows.iter_mut()));
    assert!(!rows[1].to_string().contains("pw@db"));
    assert_eq!(
        unmasked_step(
            &[
                json!({ "seq": 1, "kind": "tool", "detail": "cat .env", "callId": "c1", "label": "Run" }),
                json!({ "seq": 2, "kind": "tool_output", "callId": "c1", "text": "K=v" })
            ],
            2
        )
        .unwrap()["text"],
        "K=v"
    );
}

/// A turn that `cat`s .env, then thinks and errors with what it read: the turn machine's steps, as rows.
fn quoting_turn() -> Vec<Value> {
    let mut h = Head::default();
    let no = |_: &str| false;
    let run = |id: &str, detail: &str| HarnessEvent::Tool {
        kind: ToolKind::Run,
        label: "Run".into(),
        file: None,
        detail: Some(detail.into()),
        id: Some(id.into()),
        output: None,
        title: None,
    };
    let evs = [
        run("c1", "cat .env"),
        HarnessEvent::ToolOutput { id: "c1".into(), text: "API_KEY=sk-live-one\nPORT=3000".into() },
        HarnessEvent::Thinking { text: Some("The key sk-live-one is stale; port 3000 is fine.".into()) },
        run("c2", "curl -H \"Authorization: $API_KEY\" api"),
        HarnessEvent::ToolError { name: "Bash".into(), text: "401: bad key sk-live-one".into(), id: Some("c2".into()) },
        run("c3", "grep KEY .env"),
        HarnessEvent::ToolError { name: "Bash".into(), text: "API_KEY=sk-live-one\ngrep: exit 2".into(), id: Some("c3".into()) },
        HarnessEvent::Thinking { text: Some("Plan:\nNEW_TOKEN=tok-fresh-77\ndone".into()) },
    ];
    let mut rows = Vec::new();
    for (i, ev) in evs.iter().enumerate() {
        if let Effect::Append(a) = apply(&mut h, ev, false, &no) {
            let mut v = serde_json::to_value(&a).unwrap();
            v["seq"] = json!(i);
            rows.push(v);
        }
    }
    assert!(!format!("{h:?}").contains("sk-live"), "the head's Debug never says a value");
    rows
}

fn none_left(what: &str, v: &Value) {
    let j = v.to_string();
    assert!(!j.contains("sk-live") && !j.contains("tok-fresh"), "{what}: {j}");
}

#[test]
fn a_turn_whose_thinking_quotes_a_env_value_never_shows_it_row_by_row_or_as_a_batch() {
    let rows = quoting_turn();
    let think: Vec<&Value> = rows.iter().filter(|r| r["kind"] == "thinking").collect();
    assert_eq!(think.len(), 2);
    assert!(think[0]["hide"].is_array(), "the turn machine flags where: {}", think[0]);
    assert!(think[0]["text"].as_str().unwrap().contains("sk-live-one"), "the stored row keeps the real text");
    // one row alone (the sync stream's row and patch ops): its own `hide`
    for t in &think {
        let mut one = (*t).clone();
        assert!(mask_step(&mut one), "{one}");
        none_left("a thinking row", &one);
        assert!(one.get("hide").is_none(), "the ranges stay on the server");
        let mut op = (*t).clone();
        assert!(mask_patch("event", "/body", &mut op));
        none_left("a patch op", &op);
        let mut row = json!({ "id": "e", "body": t });
        assert!(mask_row("event", &mut row));
        none_left("an event row", &row);
    }
    let mut one = think[0].clone();
    mask_step(&mut one);
    assert_eq!(one["text"], format!("The key {DOTS} is stale; port 3000 is fine."), "only the value goes");
    // a row from before `hide`: the batch's .env read decides
    let mut old: Vec<Value> = rows.clone();
    for r in &mut old {
        r.as_object_mut().unwrap().remove("hide");
    }
    assert!(mask_steps(old.iter_mut()));
    none_left("a batch of rows without hide", &json!(old));
    let mut evs: Vec<Value> = rows.iter().map(|b| json!({ "body": b })).collect();
    assert!(mask_event_rows(evs.iter_mut()));
    none_left("event rows", &json!(evs));
}

#[test]
fn a_tool_error_printing_a_env_value_leaves_masked() {
    let rows = quoting_turn();
    let errs: Vec<Value> = rows.iter().filter(|r| r["kind"] == "tool_error").cloned().collect();
    assert_eq!(errs.len(), 2);
    let mut a = errs[0].clone();
    assert!(mask_step(&mut a));
    assert_eq!(a["text"], format!("401: bad key {DOTS}"), "a value the turn read, in another call's error");
    let mut b = errs[1].clone();
    assert!(mask_step(&mut b));
    assert_eq!(b["text"], format!("API_KEY={DOTS}\ngrep: {DOTS}"), "an error from a call that read .env: masked as its output");
    // a v1 row (`error`, its `label`) and one with nothing to hide
    let mut v1 = json!({ "kind": "error", "label": "Bash failed: bad config:\nDB_PASSWORD=hunter2-x" });
    assert!(mask_step(&mut v1));
    assert_eq!(v1["label"], format!("Bash failed: bad config:\nDB_PASSWORD={DOTS}"));
    let mut plain = json!({ "kind": "tool_error", "name": "Bash", "text": "exit 1" });
    assert!(!mask_step(&mut plain));
    // ranges that no longer fit the text (or can't be read): all of it, never the value
    let mut bad = json!({ "kind": "thinking", "text": "sk-live-one", "hide": [[3, 400]] });
    assert!(mask_step(&mut bad));
    assert_eq!(bad["text"], DOTS);
    let mut junk = json!({ "kind": "thinking", "text": "sk-live-one", "hide": "x" });
    assert!(mask_step(&mut junk));
    assert_eq!(junk["text"], DOTS);
}

fn run_ev(id: &str, label: &str, detail: &str) -> HarnessEvent {
    HarnessEvent::Tool {
        kind: ToolKind::Run,
        label: label.into(),
        file: None,
        detail: Some(detail.into()),
        id: Some(id.into()),
        output: None,
        title: Some(format!("{label} {detail}")),
    }
}

/// Each event through the turn machine, as stored rows (`seq` = its index).
fn rows_of(h: &mut Head, evs: &[HarnessEvent]) -> Vec<Value> {
    let no = |_: &str| false;
    let mut rows = Vec::new();
    for (i, ev) in evs.iter().enumerate() {
        if let Effect::Append(a) = apply(h, ev, false, &no) {
            let mut v = serde_json::to_value(&a).unwrap();
            v["seq"] = json!(i);
            rows.push(v);
        }
    }
    rows
}

#[test]
fn a_tool_calls_command_line_label_and_title_quoting_a_env_value_leave_masked() {
    let mut h = Head::default();
    let rows = rows_of(
        &mut h,
        &[
            run_ev("c1", "Run", "cat .env"),
            HarnessEvent::ToolOutput { id: "c1".into(), text: "API_KEY=sk-live-one".into() },
            run_ev("c2", "curl with sk-live-one", "curl -H 'Authorization: Bearer sk-live-one' https://api"),
            HarnessEvent::ToolOutput { id: "c2".into(), text: "echoed: sk-live-one\nok".into() },
            run_ev("c3", "Run", "NODE_ENV=test npm test"),
        ],
    );
    let call = &rows[2];
    assert!(call["hide"]["detail"].is_array() && call["hide"]["label"].is_array() && call["hide"]["title"].is_array(), "{call}");
    assert!(call["detail"].as_str().unwrap().contains("sk-live-one"), "the stored row keeps the real text");
    // alone (one live row on the stream, a patch op), and the read's batch
    let mut one = call.clone();
    assert!(mask_step(&mut one));
    none_left("a tool call row", &one);
    assert_eq!(one["detail"], format!("curl -H 'Authorization: Bearer {DOTS}' https://api"));
    assert!(one.get("hide").is_none(), "the ranges stay on the server");
    let mut op = call.clone();
    assert!(mask_patch("event", "/body", &mut op));
    none_left("a patch op", &op);
    // another command's output quoting it
    let mut out = rows[3].clone();
    assert!(mask_step(&mut out));
    assert_eq!(out["text"], format!("echoed: {DOTS}\nok"));
    // a command with no value in it is shown as it is (an inline `NODE_ENV=test` is no secret)
    let mut plain = rows[4].clone();
    assert!(!mask_step(&mut plain), "{plain}");
    assert_eq!(plain["detail"], "NODE_ENV=test npm test");
    // a row without `hide` (from before it): the batch's .env read decides
    let mut old = rows.clone();
    for r in &mut old {
        r.as_object_mut().unwrap().remove("hide");
    }
    assert!(mask_steps(old.iter_mut()));
    none_left("a batch of rows without hide", &json!(old));
    // an unreadable `hide`: every field it could name goes (fail closed)
    let mut junk = json!({ "kind": "tool", "tool": "run", "label": "Run", "detail": "curl sk-live-one", "hide": 7 });
    assert!(mask_step(&mut junk));
    assert_eq!((junk["label"].as_str(), junk["detail"].as_str()), (Some(DOTS), Some(DOTS)));
}

#[test]
fn a_value_read_in_an_earlier_turn_and_quoted_in_a_later_one_is_masked() {
    // turn 1 reads .env
    let mut first = Head::default();
    let t1 = rows_of(
        &mut first,
        &[run_ev("c1", "Run", "cat .env"), HarnessEvent::ToolOutput { id: "c1".into(), text: "API_KEY=sk-live-one".into() }],
    );
    let quoting = [
        HarnessEvent::Thinking { text: Some("reuse sk-live-one from before".into()) },
        run_ev("c2", "Run", "curl -u sk-live-one api"),
        HarnessEvent::ToolError { name: "Bash".into(), text: "401 for sk-live-one".into(), id: Some("c2".into()) },
    ];
    // turn 2's own rows, each alone: an unseeded head can't flag them, a seeded one does
    let unseeded = rows_of(&mut Head::default(), &quoting);
    assert!(unseeded.iter().all(|r| r.get("hide").is_none()), "nothing known: nothing flagged");
    // seeded from memory (the head turn 1 ended with) and from the stored steps (after a restart)
    let stored: Vec<Activity> = t1.iter().map(|r| serde_json::from_value(r.clone()).unwrap()).collect();
    for seed in [first.env_values.clone(), EnvValues::of_steps(&stored)] {
        assert_eq!(seed.0.len(), 1, "one value known");
        let rows = rows_of(&mut Head::seeded(seed), &quoting);
        for r in &rows {
            let mut one = r.clone();
            assert!(mask_step(&mut one), "{r}");
            none_left("a later turn's row", &one);
        }
    }
    // a stored output from before the `env` flag still counts, by its call
    let old = [
        serde_json::from_value::<Activity>(json!({ "kind": "tool", "tool": "read", "label": "Read", "file": ".env", "callId": "r1" }))
            .unwrap(),
        serde_json::from_value::<Activity>(json!({ "kind": "tool_output", "callId": "r1", "text": "K=tok-fresh-1" })).unwrap(),
    ];
    assert_eq!(EnvValues::of_steps(&old).0, ["tok-fresh-1"]);
    assert_eq!(format!("{:?}", EnvValues::of_steps(&old)), "EnvValues(1 hidden)", "its Debug never says a value");
}

#[test]
fn every_line_of_a_multi_line_value_the_turn_read_is_masked_where_it_is_quoted() {
    let mut h = Head::default();
    let pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nsecondLineOfTheKeyQWERTY12\n-----END PRIVATE KEY-----";
    let rows = rows_of(
        &mut h,
        &[
            run_ev("c1", "Run", "cat .env"),
            HarnessEvent::ToolOutput { id: "c1".into(), text: format!("PORT=3000\nKEY=\"{pem}\"\nOTHER=x") },
            HarnessEvent::Thinking { text: Some("its second line secondLineOfTheKeyQWERTY12 looks off".into()) },
            HarnessEvent::ToolError { name: "Bash".into(), text: format!("bad key:\n{pem}"), id: None },
            run_ev("c2", "Run", "echo MIIEvQIBADANBgkqhkiG9w0BAQEFAASC | base64 -d"),
        ],
    );
    for r in &rows[2..] {
        let mut one = r.clone();
        assert!(mask_step(&mut one), "{r}");
        let j = one.to_string();
        assert!(!j.contains("MIIEvQ") && !j.contains("secondLine"), "{j}");
    }
}

/// A turn row whose `wisp.runtime` slot holds `blocked` as the turn machine keeps it.
fn turn_with_blocked(head: &Head) -> Value {
    json!({ "id": "t1", "ext": { "wisp.runtime": { "blocked": serde_json::to_value(&head.blocked).unwrap() } } })
}

#[test]
fn a_blocked_commands_detail_quoting_a_value_the_task_read_is_flagged_and_leaves_masked() {
    // the task read the key in an earlier turn (seeded), then this turn's refused command quotes it
    let mut h = Head::seeded(EnvValues(vec!["sk-live-one".into()]));
    let detail = "curl -H \"Authorization: Bearer sk-live-one\" https://api.test";
    let rule = format!("Bash({detail})");
    let ev = HarnessEvent::Blocked { tool: "Bash".into(), detail: detail.into(), rule: Some(rule.clone()) };
    assert!(matches!(apply(&mut h, &ev, false, &|_| false), Effect::None));
    let b = &h.blocked[0];
    assert_eq!((b.detail.as_str(), b.rule.as_deref()), (detail, Some(rule.as_str())), "the store keeps it as it was (the retry's grant)");
    assert!(b.hide.contains_key("detail") && b.hide.contains_key("rule"), "flagged: {:?}", b.hide);
    // the same refusal again is one item still
    apply(&mut h, &ev, false, &|_| false);
    assert_eq!(h.blocked.len(), 1);
    // a refusal that quotes nothing carries no ranges
    apply(&mut h, &HarnessEvent::Blocked { tool: "Bash".into(), detail: "npm publish".into(), rule: None }, false, &|_| false);
    assert!(h.blocked[1].hide.is_empty());

    // on the way out: the turn row, the slot as a patch, the list, one item
    let mut t = turn_with_blocked(&h);
    assert!(mask_turn(&mut t));
    none_left("a turn's blocked list", &t);
    let item = &t["ext"]["wisp.runtime"]["blocked"][0];
    assert_eq!(item["detail"], format!("curl -H \"Authorization: Bearer {DOTS}\" https://api.test"), "masked, not dropped");
    assert!(item.get("hide").is_none(), "where it was masked stays on the server");
    assert_eq!(t["ext"]["wisp.runtime"]["blocked"][1]["detail"], "npm publish");
    let raw = turn_with_blocked(&h);
    for (path, v) in [
        ("/body/ext", raw["ext"].clone()),
        ("/body/ext/wisp.runtime", raw["ext"]["wisp.runtime"].clone()),
        ("/body/ext/wisp.runtime/blocked", raw["ext"]["wisp.runtime"]["blocked"].clone()),
        ("/body/ext/wisp.runtime/blocked/0", raw["ext"]["wisp.runtime"]["blocked"][0].clone()),
        // too deep to see its ranges: hidden whole (fail closed)
        ("/body/ext/wisp.runtime/blocked/0/detail", json!(detail)),
        ("/body/ext/wisp.runtime/blocked/0/rule", json!(rule)),
    ] {
        let mut v = v;
        assert!(mask_patch("turn", path, &mut v), "{path}");
        none_left(path, &v);
    }
    let mut row = json!({ "id": "t1", "body": raw });
    assert!(mask_row("turn", &mut row));
    none_left("a turn row", &row);
    // an unreadable `hide` hides its detail and rule whole
    let mut bad = json!({ "tool": "Bash", "detail": detail, "rule": rule, "hide": "?" });
    assert!(wisp_runtime_core::env_mask::mask_blocked_one(&mut bad));
    assert_eq!((bad["detail"].as_str(), bad["rule"].as_str()), (Some(DOTS), Some(DOTS)));
}

#[test]
fn a_hand_off_note_and_a_btw_digest_never_quote_a_value_the_task_read() {
    use wisp_runtime_api::model::{Turn, TurnStatus};
    use wisp_runtime_core::prompt::btw::btw_prompt;
    use wisp_runtime_core::prompt::handoff::{Handoff, PastTurn, Render, handoff_note};
    let env = vec!["sk-live-one".to_owned(), "PEMLINExyz0123456789".to_owned()];
    let done = Turn {
        idx: 0,
        agent: "a".into(),
        prompt: "use sk-live-one for the API. Don't touch sk-live-one's config.".into(),
        text: Some(format!("Tried it: sk-live-one works, PEMLINExyz0123456789 too.\nAPI_KEY=sk-live-one\n{}", "x".repeat(1600))),
        status: TurnStatus::Done,
        ..Turn::default()
    };
    let live = Turn { idx: 1, agent: "a".into(), prompt: "again".into(), status: TurnStatus::Running, ..Turn::default() };
    // a running turn's actions: a label the turn machine flagged, one cut short (`…`), a notice and its latest message
    let acts = vec![
        Activity::Tool {
            tool: ToolKind::Run,
            label: "curl -H 'Bearer sk-live-one'".into(),
            file: None,
            detail: None,
            call_id: None,
            output: None,
            title: None,
            hide: [("label".to_owned(), vec![[16, 27]])].into_iter().collect(),
        },
        Activity::Tool {
            tool: ToolKind::Run,
            label: "echo PEMLINExyz01…".into(),
            file: None,
            detail: None,
            call_id: None,
            output: None,
            title: None,
            hide: std::collections::BTreeMap::new(),
        },
        Activity::Notice { text: "retrying with sk-live-one".into(), tone: None },
        Activity::Text { text: "the key sk-live-one is fine".into() },
    ];
    let next = Turn { idx: 2, agent: "b".into(), prompt: "go on".into(), ..Turn::default() };
    let past = [
        PastTurn { env: &env, ..PastTurn::new(&done, "A CLI") },
        PastTurn { env: &env, activity: &acts, ..PastTurn::new(&live, "A CLI") },
        PastTurn { env: &env, ..PastTurn::new(&next, "B CLI") },
    ];
    let h = Handoff { turns: &past, agent: "b", ..Handoff::default() };
    let note = handoff_note(&h, Render::default());
    assert!(note.contains("### Turn 1 · A CLI") && note.contains("What still holds"), "{note}");
    let btw = btw_prompt(&past[..2], "did it work?", false, 0, Render::default());
    assert!(btw.contains("What it has done so far"), "{btw}");
    for (what, text) in [("the hand-off note", &note), ("the /btw prompt", &btw)] {
        assert!(!text.contains("sk-live") && !text.contains("PEMLINE"), "{what} quoted a .env value: {text}");
        assert!(text.contains(DOTS), "{what}: masked, not dropped");
    }
}
