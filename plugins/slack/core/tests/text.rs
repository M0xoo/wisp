#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // tests may fail loudly
//! What leaves: escaped, within Slack's limits, never half an entity; buttons, reports and the
//! manifest (v1 test/channel-slack.test.js: "what leaves", "Slack's limits", "the manifest", "a
//! manifest with a URL", "text fallback").
mod common;

use serde_json::{Value, json};
use wisp_slack_core::mrkdwn::{MAX_LABEL, MAX_SECTION, MAX_TEXT, escape, fit, label, sections};
use wisp_slack_core::post::{self, Choice, MAX_BUTTONS};

/// Every `&` starts one of the three entities.
fn whole_entities(s: &str) -> bool {
    s.match_indices('&').all(|(i, _)| {
        ["&amp;", "&lt;", "&gt;"]
            .iter()
            .any(|e| s[i..].starts_with(e))
    })
}

#[test]
fn escaping_is_what_stops_slacks_markup() {
    assert_eq!(fit("a & b < c > d"), "a &amp; b &lt; c &gt; d");
    let out = fit("<!channel> <@U999> <#C1|general> <https://evil.example|click>");
    assert!(!out.contains('<') && !out.contains('>'));
    assert!(out.contains("&lt;!channel&gt;"));
}

#[test]
fn long_text_fits_and_never_ends_in_half_an_entity() {
    assert_eq!(fit(&"x".repeat(20_000)).chars().count(), MAX_TEXT);
    let amp = fit(&"&".repeat(5_000));
    assert!(amp.chars().count() <= MAX_TEXT && amp.ends_with('…'));
    assert!(
        whole_entities(amp.trim_end_matches('…')),
        "{}",
        &amp[amp.len() - 20..]
    );
}

#[test]
fn sections_split_at_a_line_or_before_an_entity() {
    let text = fit(&format!("{}end", "& ".repeat(1700)));
    let parts = sections(&text);
    assert_eq!(parts.len(), 2, "the text is split, not cut");
    let texts: Vec<&str> = parts
        .iter()
        .map(|p| p["text"]["text"].as_str().unwrap())
        .collect();
    assert!(
        texts
            .iter()
            .all(|t| whole_entities(t) && t.chars().count() <= MAX_SECTION)
    );
    assert_eq!(texts.concat(), text);
    let lines = format!("{}\n{}", "a".repeat(2000), "b".repeat(2000));
    let parts = sections(&lines);
    assert_eq!(
        parts[0]["text"]["text"].as_str().unwrap().len(),
        2000,
        "at the line"
    );
    assert!(sections("  \n ").is_empty());
}

#[test]
fn labels_fit_75_after_escaping() {
    let clean = |s: &str| s.to_owned();
    assert_eq!(label(&"x".repeat(200), &clean).chars().count(), MAX_LABEL);
    let l = label(&format!("&&&&&&&& {}", "&".repeat(80)), &clean);
    assert!(
        l.chars().count() <= MAX_LABEL && whole_entities(l.trim_end_matches('…')),
        "{l}"
    );
    assert_eq!(label("Yes", &clean), "Yes");
}

#[test]
fn buttons_one_per_choice_at_most_25_each_pointing_at_its_own() {
    let choices: Vec<Choice> = (0..30)
        .map(|i| Choice {
            label: format!("choice {i}"),
            code: "a",
            session: "S1".into(),
            reference: "ask-1".into(),
            index: i,
            sig: format!("sig{i}"),
        })
        .collect();
    let b = post::buttons(&choices);
    assert_eq!(b.len(), MAX_BUTTONS);
    let v: Value = serde_json::from_str(b[24]["value"].as_str().unwrap()).unwrap();
    assert_eq!(
        v,
        json!({ "k": "a", "s": "S1", "r": "ask-1", "i": 24, "sig": "sig24" })
    );
    assert_eq!(b[3]["action_id"], "wisp:3");
    let body = post::with_buttons(post::body("C1", "1.1", "Q?"), b);
    let kinds: Vec<&str> = body["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["type"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["section", "actions"]);
}

#[test]
fn every_post_fetches_nothing_and_pings_nobody() {
    let b = post::body("D1", "1.1", "hi");
    assert_eq!(
        [
            &b["parse"],
            &b["link_names"],
            &b["unfurl_links"],
            &b["unfurl_media"]
        ],
        [&json!("none"), &json!(false), &json!(false), &json!(false)]
    );
    let e = post::ephemeral("C1", "U1", "1.1", "x");
    assert_eq!(
        (&e["parse"], &e["link_names"]),
        (&json!("none"), &json!(false))
    );
    let m = post::as_member(b, "Ada");
    assert_eq!(
        (&m["username"], &m["icon_emoji"]),
        (&json!("Ada"), &json!(":robot_face:"))
    );
}

#[test]
fn a_click_takes_the_buttons_away_and_says_what_and_who() {
    let blocks = [json!({ "type": "section" }), json!({ "type": "actions" })];
    let u = post::clicked("C1", "5.5", "Q?", &blocks, "✓ Answered · <@U0ME>");
    let kinds: Vec<&str> = u["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["type"].as_str().unwrap())
        .collect();
    assert_eq!(kinds, ["section", "context"]);
    assert_eq!(
        u["blocks"][1]["elements"][0]["text"],
        "✓ Answered · <@U0ME>"
    );
}

#[test]
fn a_report_says_how_to_answer_where_it_is() {
    let r = post::report(
        "Plain?",
        "body",
        &["A".into(), "B".into()],
        None,
        false,
        None,
    );
    assert_eq!(
        r,
        "Plain?\n\nbody\n\nChoices: A · B\n\nMention wisp in this thread to answer or follow up."
    );
    let r = post::report("Ada: done", "", &[], Some("Ada"), true, Some("wispbot"));
    assert_eq!(
        r, "Ada: done\n\nReply in this thread to answer or follow up.",
        "a name once"
    );
    assert_eq!(post::titled("done", Some("Ada")), "Ada: done");
}

#[test]
fn the_manifest_socket_mode_two_events_exact_scopes_and_a_box_url_instead() {
    let m = post::manifest(None);
    assert_eq!(m["settings"]["socket_mode_enabled"], true);
    assert_eq!(m["settings"]["interactivity"]["is_enabled"], true);
    assert_eq!(
        m["settings"]["event_subscriptions"]["bot_events"],
        json!(["app_mention", "message.im"])
    );
    assert!(
        m["settings"]["event_subscriptions"]
            .get("request_url")
            .is_none(),
        "a computer's never has one"
    );
    assert_eq!(
        m["oauth_config"]["scopes"]["bot"],
        json!([
            "app_mentions:read",
            "chat:write",
            "chat:write.customize",
            "im:history"
        ])
    );
    let b = post::manifest(Some("https://grid.example/in/abc"));
    assert_eq!(b["settings"]["socket_mode_enabled"], false);
    assert_eq!(
        b["settings"]["event_subscriptions"]["request_url"],
        "https://grid.example/in/abc"
    );
}

#[test]
fn property_fit_and_sections_keep_every_entity_whole_and_every_limit() {
    let mut r = common::Rng::new(0x5eed);
    let alphabet = ["&", "<", ">", "a", " ", "\n", "é", "😀", "&amp;"];
    for _ in 0..300 {
        let len = r.below(9_000);
        let s = r.string(&alphabet, len);
        let out = fit(&s);
        assert!(out.chars().count() <= MAX_TEXT);
        assert!(!out.contains('<') && !out.contains('>'));
        assert!(whole_entities(out.trim_end_matches('…')));
        if s.chars().count() <= MAX_TEXT / 5 {
            assert_eq!(out, escape(&s), "short text is only escaped");
        }
        let parts = sections(&out);
        let joined: String = parts
            .iter()
            .map(|p| p["text"]["text"].as_str().unwrap())
            .collect();
        assert_eq!(joined.trim(), out.trim(), "nothing lost but blank parts");
        for p in &parts {
            let t = p["text"]["text"].as_str().unwrap();
            assert!(t.chars().count() <= MAX_SECTION && whole_entities(t.trim_end_matches('…')));
        }
    }
}
