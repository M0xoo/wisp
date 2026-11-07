//! v1 test/stuff.test.js: kinds, names, titles, excerpts, tags and links.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // tests: a failed unwrap is the failure message
use serde_json::json;
use wisp_stuff_api::StuffKind;
use wisp_stuff_core::kind::{
    clip, cut, excerpt_of, kind_of, mime_for, normalize_tags, safe_name, title_from, type_of,
};
use wisp_stuff_core::make::{check_text, parse_link, text_name};

#[test]
fn kind_of_pictures_videos_docs_code_and_the_rest_by_extension() {
    assert_eq!(kind_of("shot.PNG"), StuffKind::Image);
    assert_eq!(kind_of("demo.webm"), StuffKind::Video);
    assert_eq!(kind_of("plan.md"), StuffKind::Doc);
    assert_eq!(kind_of("report.pdf"), StuffKind::Doc);
    assert_eq!(kind_of("limiter.ts"), StuffKind::Code);
    assert_eq!(kind_of("Dockerfile"), StuffKind::Code);
    assert_eq!(kind_of("Makefile"), StuffKind::Code);
    assert_eq!(kind_of("build.zip"), StuffKind::File);
    assert_eq!(
        kind_of(".env"),
        StuffKind::File,
        "a dotfile has no extension"
    );
}

#[test]
fn types_svg_is_a_picture_text_is_text_the_rest_is_bytes() {
    assert_eq!(mime_for("logo.png", None), "image/png");
    assert_eq!(
        mime_for("logo.svg", Some("text/xml")),
        "image/svg+xml",
        "an svg is always a picture"
    );
    assert_eq!(mime_for("a.rs", None), "text/plain; charset=utf-8");
    assert_eq!(mime_for("a.bin", None), "application/octet-stream");
    assert_eq!(
        mime_for("a.bin", Some("image/png")),
        "image/png",
        "what it was sent as"
    );
    assert_eq!(type_of("app.mjs"), "text/javascript; charset=utf-8");
    assert_eq!(type_of("f.woff2"), "font/woff2");
}

#[test]
fn safe_names_titles_and_cuts() {
    assert_eq!(safe_name("../../etc/pa ss<wd>", "file"), "pa ss_wd_");
    assert_eq!(safe_name("...hidden", "file"), "hidden");
    assert_eq!(safe_name("", "file"), "file");
    assert_eq!(
        safe_name(&format!("{}.png", "a".repeat(200)), "file").len(),
        120
    );
    assert_eq!(title_from("launch-plan_v2.md"), "launch plan v2");
    assert_eq!(title_from(".env"), ".env");
    assert_eq!(cut("abcdef", 4), "abc…");
    assert_eq!(clip("a \n  b", 80), "a b");
}

#[test]
fn excerpts_drop_front_matter_and_keep_lines() {
    let e = excerpt_of(
        "---\ntitle: x\n---\n# Launch plan\n\nShip on Monday.\n",
        StuffKind::Doc,
    );
    assert_eq!(e, "# Launch plan\n\nShip on Monday.");
    assert_eq!(
        excerpt_of("---\nx: 1\n---\ncode", StuffKind::Code),
        "---\nx: 1\n---\ncode",
        "code keeps it"
    );
    assert_eq!(
        excerpt_of(&"x".repeat(2000), StuffKind::Code)
            .chars()
            .count(),
        1400
    );
    assert_eq!(excerpt_of("a\r\nb\r\n", StuffKind::Doc), "a\nb");
}

#[test]
fn tags_are_normalised_deduped_and_capped() {
    assert_eq!(
        normalize_tags(&json!(["Brand", "#logo"])),
        ["brand", "logo"]
    );
    assert_eq!(
        normalize_tags(&json!("Rate Limiting, #Redis, next.js")),
        ["rate-limiting", "redis", "next.js"]
    );
    assert_eq!(
        normalize_tags(&json!(["a", "A", "", "--x--", "a/b_c"])),
        ["a", "x", "a-b-c"]
    );
    let many: Vec<String> = (0..20).map(|i| format!("t{i}")).collect();
    assert_eq!(normalize_tags(&json!(many)).len(), 10);
    assert!(normalize_tags(&json!(42)).is_empty());
}

#[test]
fn text_names_from_the_name_the_title_or_the_language() {
    assert_eq!(text_name(None, None, Some("Launch plan")), "launch-plan.md");
    assert_eq!(text_name(None, Some("typescript"), None), "snippet.ts");
    assert_eq!(
        text_name(Some("notes"), None, None),
        "notes.md",
        "text gets a .md name"
    );
    assert_eq!(text_name(Some("x.py"), Some("rust"), None), "x.py");
    assert_eq!(text_name(None, Some("klingon"), None), "snippet.txt");
    assert_eq!(text_name(None, None, None), "note.md");
}

#[test]
fn text_must_have_something_and_fit() {
    assert_eq!(check_text("  ").map_err(|e| e.status), Err(400));
    assert!(check_text("  ").unwrap_err().message.contains("empty"));
    assert_eq!(
        check_text(&"x".repeat(2 * 1024 * 1024 + 1)).map_err(|e| e.status),
        Err(413)
    );
    assert!(check_text("# ok").is_ok());
}

#[test]
fn links_only_http_and_named_by_their_host() {
    let (href, host) = parse_link("https://www.example.com/a?b=1").unwrap();
    assert_eq!(
        (href.as_str(), host.as_str()),
        ("https://www.example.com/a?b=1", "example.com")
    );
    assert_eq!(
        parse_link("HTTP://Example.COM").unwrap().0,
        "http://example.com/"
    );
    let js = parse_link("javascript:alert(1)").unwrap_err();
    assert!(js.message.contains("http"));
    assert!(
        parse_link("not a url")
            .unwrap_err()
            .message
            .contains("http")
    );
    assert!(parse_link("https://").is_err());
    assert!(
        parse_link("ftp://x.dev")
            .unwrap_err()
            .message
            .starts_with("Only http(s)")
    );
}
