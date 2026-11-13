//! A task's turns and events as they leave the server (ADR-0050): v1's maskSession / maskStep / unmasked cases on
//! v2's shapes, the patch ops the stream may carry, the answer's raw text, and the turn machine's `env` flag.
#![allow(clippy::unwrap_used)]

use serde_json::{Value, json};
use wisp_envmask::DOTS;
use wisp_runtime_api::harness::HarnessEvent;
use wisp_runtime_api::model::{Activity, ToolKind};
use wisp_runtime_core::activity::{Effect, Head, apply};
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
    let v = serde_json::to_value(Activity::ToolOutput { call_id: "c2".into(), text: "x".into(), env: false }).unwrap();
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
