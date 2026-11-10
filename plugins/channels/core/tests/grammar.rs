//! v1 test/channel-grammar.test.js, row for row: the message table (tests/fixtures/grammar-table.json is that
//! file's TABLE and ctx, extracted once), and its named cases. What a message says, and just as much what it
//! must not be read as.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use regex::Regex;
use serde_json::{Value, json};
use wisp_channels_api::{ChannelCtx, ThreadCtx};
use wisp_channels_core::grammar::{Markup, Route, find_project, parse_message, parse_route, strip_formatting};

fn fixture() -> (ChannelCtx, Vec<Value>) {
    let v: Value = serde_json::from_str(include_str!("fixtures/grammar-table.json")).unwrap();
    (serde_json::from_value(v["ctx"].clone()).unwrap(), v["rows"].as_array().unwrap().clone())
}

fn by(v: &Value) -> Value {
    v.get("name").cloned().unwrap_or_else(|| v.clone())
}

fn re(w: &Value) -> Regex {
    Regex::new(w["re"].as_str().unwrap()).unwrap()
}

const OPTIONS: [&str; 7] = ["crew", "project", "machine", "agent", "model", "effort", "mode"];

fn check(text: &str, want: &Value, c: &ChannelCtx) -> Result<(), String> {
    let p = serde_json::to_value(parse_message(text, c)).unwrap();
    let problems = p["problems"].as_array().unwrap();
    if let Some(no) = want.get("no") {
        let first = problems.first().ok_or_else(|| format!("should be refused, read as {}", p["prompt"]))?;
        if &first["kind"] != no {
            return Err(format!("refused as {} ({}), not {no}", first["kind"], first["text"]));
        }
        if let Some(t) = want.get("text").filter(|t| !re(t).is_match(first["text"].as_str().unwrap())) {
            return Err(format!("text {} doesn't match {t}", first["text"]));
        }
        if let Some(ch) = want.get("choices").filter(|ch| *ch != &first["choices"]) {
            return Err(format!("choices {} want {ch}", first["choices"]));
        }
        return Ok(());
    }
    if !problems.is_empty() {
        return Err(format!("refused: {problems:?}"));
    }
    if want.get("same") == Some(&json!(true)) {
        if p["prompt"] != json!(text) {
            return Err(format!("prompt {} should be the whole message", p["prompt"]));
        }
        if let Some(k) = OPTIONS.iter().find(|k| !p[**k].is_null()) {
            return Err(format!("{k} = {} should be null", p[*k]));
        }
    }
    let notes = p["notes"].as_array().unwrap().iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n");
    match want.get("note") {
        Some(n) if !re(n).is_match(&notes) => return Err(format!("notes {notes:?} want {n}")),
        None if !notes.is_empty() => return Err(format!("unexpected notes {notes:?}")),
        _ => {}
    }
    for (k, v) in want.as_object().unwrap() {
        if ["same", "note", "tagged"].contains(&k.as_str()) {
            continue;
        }
        if &by(&p[k]) != v {
            return Err(format!("{k} = {} want {v}", by(&p[k])));
        }
    }
    if let Some(t) = want.get("tagged") {
        let names: Vec<Value> = p["tagged"].as_array().unwrap().iter().map(by).collect();
        if &json!(names) != t {
            return Err(format!("tagged {names:?} want {t}"));
        }
    }
    Ok(())
}

#[test]
fn every_message_of_v1s_table_reads_the_same() {
    let (c, rows) = fixture();
    assert!(rows.len() >= 140, "{} messages", rows.len());
    assert!(rows.iter().filter(|r| r["want"]["same"] == json!(true)).count() >= 15, "sentences that must not parse as options");
    let failed: Vec<String> = rows.iter().filter_map(|r| check(r["text"].as_str().unwrap(), &r["want"], &c).err().map(|e| format!("{}: {e}", r["text"]))).collect();
    assert!(failed.is_empty(), "{} of {} rows:\n{}", failed.len(), rows.len(), failed.join("\n"));
}

#[test]
fn every_option_reads_the_same_in_any_order() {
    let (c, _) = fixture();
    for t in ["with opus in api plan: x", "in api plan with opus: x"] {
        let p = parse_message(t, &c);
        assert_eq!((p.project.unwrap().name.as_str(), p.model.as_deref(), p.mode.map(wisp_channels_api::Mode::as_str), p.prompt.as_str()), ("api", Some("opus"), Some("plan"), "x"));
    }
}

#[test]
fn the_machine_decides_the_model_wherever_on_stands() {
    let (c, _) = fixture();
    assert_eq!(parse_message("with gpt-5 on mac mini: x", &c).model.as_deref(), Some("gpt-5"));
    assert_eq!(parse_message("with gpt-5 on laptop: x", &c).problems[0].kind, "not-installed");
    let off = &parse_message("on desktop with opus: x", &c).problems[0];
    assert!(off.kind == "offline" && !off.text.contains("install"));
    assert_eq!(parse_message("on mid with opus: x", &c).problems[0].kind, "not-installed");
}

#[test]
fn a_model_on_two_harnesses_with_no_default_among_them_is_ambiguous() {
    let (mut c, _) = fixture();
    c.default_agent = "auto".into();
    let x = &parse_message("with sonnet fix it", &c).problems[0];
    assert_eq!((x.kind.as_str(), x.choices.clone()), ("ambiguous", vec!["claude sonnet".to_owned(), "cursor-agent sonnet".to_owned()]));
    assert_eq!(parse_message("with claude sonnet fix it", &c).agent.as_deref(), Some("claude"));
    let m = parse_message("with cursor opus-m fix it", &c);
    assert_eq!((m.agent.as_deref(), m.model.as_deref()), (Some("cursor-agent"), Some("opus-max")));
}

#[test]
fn in_a_thread_only_with_a_mode_and_crew_are_options() {
    let (mut c, _) = fixture();
    c.thread = Some(ThreadCtx { agent: "claude".into(), machine: String::new() });
    let p = |t: &str| parse_message(t, &c);
    assert_eq!((p("with sonnet carry on").model.as_deref(), p("with sonnet carry on").prompt.as_str()), (Some("sonnet"), "carry on"));
    assert_eq!(p("with cursor sonnet carry on").agent.as_deref(), Some("cursor-agent"));
    for t in ["in api fix it", "on laptop fix it", "#api fix it", "plan the migration"] {
        let x = p(t);
        assert_eq!(x.prompt, t);
        assert!(x.project.is_none() && x.machine.is_none() && x.mode.is_none() && x.notes.is_empty(), "{t}");
    }
    assert_eq!(p("@ada look at this").crew.unwrap().name, "Ada");
    assert_eq!(p("@nobody look at this").prompt, "@nobody look at this", "not a member: words for the agent");
    assert_eq!(p("/btw what changed?").prompt, "what changed?");
    assert_eq!(p(": stop").command, None);
    assert_eq!(p("/goal tests pass").prompt, "/goal tests pass");
    assert_eq!(p("with auto carry on").problems[0].kind, "refused");
}

#[test]
fn find_project_takes_the_exact_name_then_a_prefix_then_anywhere() {
    let (c, _) = fixture();
    assert_eq!(find_project(&c.projects, "API").unwrap().name, "api");
    assert_eq!(find_project(&c.projects, "api-").unwrap().name, "api-gateway");
    assert_eq!(find_project(&c.projects, "applications").unwrap().name, "web", "the path");
    assert!(find_project(&c.projects, "").is_none());
}

#[test]
fn each_channels_markup_goes_before_the_grammar_reads_it() {
    assert_eq!(strip_formatting("/new@wispbot in api fix it", Markup::Telegram, "wispbot"), "/new in api fix it");
    assert_eq!(strip_formatting("@WispBot, fix it", Markup::Telegram, "wispbot"), "fix it");
    assert_eq!(strip_formatting("<@U123|wisp> look at <https://x.dev/a|https://x.dev/a> &amp; <#C1|ops>", Markup::Slack, "U123"), "look at https://x.dev/a & #ops");
    assert_eq!(strip_formatting("see <https://x.dev|the docs>", Markup::Slack, ""), "see the docs (https://x.dev)");
    assert_eq!(strip_formatting("<@!42> fix <https://x.dev/a>", Markup::Discord, "42"), "fix https://x.dev/a");
    assert_eq!(strip_formatting("\u{200b}fix\u{a0}it\r\n", Markup::Plain, ""), "fix it");
}

#[test]
fn a_router_reads_on_a_computer_and_nothing_else() {
    let (c, _) = fixture();
    let computers: Vec<_> = c.machines.iter().filter(|m| ["m-lap", "m-mini"].contains(&m.id.as_str())).cloned().collect();
    assert_eq!(parse_route("on laptop fix it", &computers), Some(Route::To { machine: "m-lap".into(), text: "fix it".into() }));
    assert_eq!(parse_route("/new on mac mini: fix it", &computers), Some(Route::To { machine: "m-mini".into(), text: "/new : fix it".into() }));
    assert_eq!(parse_route("on mac fix it", &computers), None, "whole names only");
    assert_eq!(parse_route("fix it on laptop", &computers), None);
    assert_eq!(parse_route("on cloud fix it", &computers), None, "cloud is the box's");
    assert_eq!(parse_route("on laptop", &computers), None, "nothing to do there");
    let twins = vec![computers[0].clone(), wisp_channels_api::MachineView { id: "m-2".into(), name: "laptop".into(), usable: true, ..Default::default() }];
    assert!(matches!(parse_route("on laptop fix it", &twins), Some(Route::Ambiguous(_))));
}
