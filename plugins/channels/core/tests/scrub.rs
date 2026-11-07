//! What leaves (v1 test/channel-scrub.test.js as pure calls, and the TS port's scrub cases): never a
//! secret, mentions defused, names hidden where others read, no media.
use wisp_channels_api::{Action, ActionKind, AskView, ChannelCtx, MachineView, MemberView, Msg, Permission, ProjectView};
use wisp_channels_core::scrub::{defuse, hide_names, no_media, safe_msg, scrub_out, split_note, truncate, waiting_line};

// Built here, not written out: a realistic token in a file stops the push.
fn token() -> String {
    ["ghp", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("_")
}
const NOTE: &str = "wisp took a secret out of this message";

fn action(label: &str) -> Action {
    Action { label: label.into(), kind: ActionKind::Answer, reference: "q".into(), index: 0 }
}

#[test]
fn scrub_and_defuse_leave_ordinary_text_alone() {
    let s = scrub_out("all fine", true);
    assert_eq!((s.text.as_str(), s.hits), ("all fine", 0));
    assert_eq!(scrub_out("", true).text, "");
    assert_eq!(defuse("a@b.co 3 < 4"), "a@b.co 3 < 4");
    assert_eq!(defuse(""), "");
}

#[test]
fn a_secret_in_a_report_goes_nowhere_and_the_message_says_so_once() {
    let t = token();
    let out = safe_msg(&Msg { title: format!("Done {t}"), text: format!("The deploy used {t} and worked."), actions: vec![action(&format!("Use {t}"))] }, false);
    assert!(!serde_json::to_string(&out).unwrap_or_default().contains(&t));
    assert!(out.text.contains(NOTE));
    assert!(!out.title.contains(NOTE));
    assert!(!out.actions[0].label.contains(NOTE));
    assert!(out.text.contains("[redacted: a GitHub token]"));
}

#[test]
fn a_secret_astride_the_length_limit_is_taken_out_before_the_cut() {
    let t = token();
    let out = safe_msg(&Msg { title: "Done".into(), text: format!("{}{t}", "x ".repeat(1496)), actions: vec![] }, false);
    assert!(!truncate(&out.text, 3000).contains(&t[..12]));
}

#[test]
fn a_report_with_no_secret_leaves_exactly_as_it_did() {
    let text = "Ran npm test as @mokh: 1490 pass, commit 612b165e.";
    let msg = Msg { title: "Done".into(), text: text.into(), actions: vec![action("Merge")] };
    assert_eq!(safe_msg(&msg, false), msg);
}

#[test]
fn with_the_channel_layer_a_report_is_scrubbed_and_defused() {
    let t = token();
    let out = safe_msg(&Msg { title: "Done".into(), text: format!("{t} for @mokh"), actions: vec![] }, true);
    assert!(!out.text.contains(&t));
    assert!(out.text.contains("@\u{200b}mokh"));
}

#[test]
fn a_private_key_is_cut_to_its_end_two_secrets_are_counted_and_the_note_splits_off() {
    let key = format!("{}\nMIIEv{}\n{}", ["-----BEGIN", "PRIVATE KEY-----"].join(" "), "Q".repeat(40), ["-----END", "PRIVATE KEY-----"].join(" "));
    let out = scrub_out(&format!("Found {}\n{key}\nall done", token()), true);
    assert!(!out.text.contains("MIIEv"));
    assert_eq!(out.hits, 2);
    assert!(out.text.contains("wisp took 2 secrets out of this message"));
    let (body, note) = split_note(&out.text);
    assert!(body.ends_with("all done"), "{body}");
    assert!(note.starts_with("(wisp took 2 secrets"));
    assert_eq!(split_note("plain"), ("plain", ""));
    let unended = scrub_out(&format!("{}\nMIIEv{}", ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" "), "Q".repeat(40)), false);
    assert!(!unended.text.contains("MIIEv"), "a key with no end is cut to the end of the text");
}

#[test]
fn defuse_stops_pings_and_keeps_them_readable() {
    let src = "Hey @everyone cc @here <!channel> <!here> <@U123> and @ada, mail ada@example.com";
    let m = defuse(src);
    for bad in ["@everyone", "@here", " @ada", "<!channel>", "<@U123>"] {
        assert!(!m.contains(bad), "{bad} in {m}");
    }
    assert!(m.contains("ada@example.com"));
    assert_eq!(m.replace('\u{200b}', ""), src);
    assert_eq!(defuse("@ünïcode"), "@\u{200b}ünïcode");
    assert_eq!(defuse("(@ada)"), "(@\u{200b}ada)");
    assert_eq!(defuse("a+@b"), "a+@b");
}

fn names_ctx() -> ChannelCtx {
    ChannelCtx {
        projects: vec![ProjectView { id: "p".into(), name: "api".into(), path: "/code/api".into(), ..ProjectView::default() }],
        machines: vec![MachineView { id: "m".into(), name: "laptop".into(), ..MachineView::default() }],
        crew: vec![MemberView { id: "c".into(), name: "Ada".into(), agent: "claude".into(), cwd: Some("/code/ada".into()), ..MemberView::default() }],
        ..ChannelCtx::default()
    }
}

#[test]
fn hide_names_hides_what_you_did_not_write_there() {
    let ctx = names_ctx();
    assert_eq!(hide_names("▶ api · Opus · Plan · on laptop", &ctx, ""), "▶ Opus · Plan");
    assert_eq!(hide_names("Ada looked at /code/api and api-gateway", &ctx, ""), "… looked at … and api-gateway");
    assert_eq!(hide_names("in api fix it", &ctx, "in api fix it"), "in api fix it");
    assert_eq!(hide_names("ADA and LAPTOP", &ctx, ""), "… and …", "any case");
}

#[test]
fn no_media_no_image_renders_no_tag_is_a_tag() {
    assert_eq!(no_media("![x](http://e/leak?d=1)"), "!\u{200b}[x](http://e/leak?d=1)");
    assert_eq!(no_media("<img src=x> <iframe> </style> 3 < 4"), "<\u{200b}img src=x> <\u{200b}iframe> <\u{200b}/style> 3 < 4");
}

fn perm(action: &str, detail: &str) -> AskView {
    AskView { id: "a".into(), permission: Some(Permission { tool: Some("Bash".into()), action: Some(action.into()), detail: Some(detail.into()), why: None }), ..AskView::default() }
}

#[test]
fn waiting_line_says_what_it_wants_on_one_line_in_a_bounded_length() {
    let edit = AskView { question: Some("Allow Claude Code to edit src/a.ts?".into()), ..perm("edit src/a.ts", "src/a.ts") };
    assert_eq!(waiting_line(&edit, false), "Waiting for your OK in wisp: edit src/a.ts");
    assert_eq!(waiting_line(&perm("use Grep", "needle"), false), "Waiting for your OK in wisp: use Grep: needle");
    assert_eq!(waiting_line(&perm("run `a\n  && b`", "a\n  && b"), false), "Waiting for your OK in wisp: run `a && b`");
    let connector = AskView { id: "a".into(), question: Some("Sign in to Linear".into()), connector: Some(serde_json::json!({"name": "Linear"})), ..AskView::default() };
    assert_eq!(waiting_line(&connector, false), "Waiting for your OK in wisp: Sign in to Linear");
    assert_eq!(waiting_line(&perm("", ""), false), "Waiting for your OK in wisp.");
    let clipped_action = format!("run `{}…`", "x".repeat(199));
    assert_eq!(waiting_line(&perm(&clipped_action, &"x".repeat(5000)), false), format!("Waiting for your OK in wisp: {clipped_action}"), "the command once");
    let long = waiting_line(&perm("use Grep", &"x".repeat(5000)), false);
    assert!(long.chars().count() < 340 && long.ends_with('…'), "{long}");
}

#[test]
fn waiting_line_bare_is_the_fixed_line() {
    let ask = AskView { question: Some("Allow?".into()), context: Some("why".into()), ..perm("run `rm -rf /x`", "rm -rf /x") };
    assert_eq!(waiting_line(&ask, true), "Waiting for your OK in wisp.");
}

#[test]
fn waiting_line_no_secret_leaves_not_even_half_of_one() {
    let t = token();
    let whole = waiting_line(&perm(&format!("run `curl -H {t}`"), &format!("curl -H {t}")), false);
    assert!(!whole.contains(&t) && whole.contains("[redacted"), "{whole}");
    let pad = "x".repeat(185);
    let cut: String = format!("run `{pad} {t}").chars().take(200).collect();
    let line = waiting_line(&perm(&format!("{cut}…"), &format!("{pad} {t} --go")), false);
    assert!(!line.contains(&t[..10]), "{line}");
    let key = waiting_line(&AskView { id: "a".into(), question: Some(format!("Set {t}")), connector: Some(serde_json::json!({})), ..AskView::default() }, false);
    assert!(!key.contains(&t) && !key.contains("took a secret"), "{key}");
}
