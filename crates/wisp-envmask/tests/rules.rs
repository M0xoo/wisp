//! The .env rules with v1's cases (test/env-mask.test.js) and the v2 page's (packages/ui/test/env-mask.test.tsx),
//! the CRLF fix over v1, and properties over random .env files: no value survives, masking is idempotent on what
//! it leaves, keys and comments stay.
#![allow(clippy::unwrap_used)]

use serde_json::json;
use wisp_envmask::{
    DOTS, env_file_named, env_values, is_env_file, mask_block, mask_diffs, mask_edit, mask_line, mask_on, mask_spans, mask_text,
    names_env_file, quote_spans, reads_env_file, text_spans, value_spans,
};

#[test]
fn is_env_file_takes_env_and_env_star_not_the_templates_v1_cases() {
    for f in [".env", ".env.local", "apps/web/.env.production", "C:\\app\\.env.test", "/abs/.env.development.local"] {
        assert!(is_env_file(f), "{f}");
    }
    for f in [
        ".env.example",
        ".env.sample",
        "web/.env.local.example",
        ".ENV.SAMPLE",
        "env",
        "my.env",
        ".envrc",
        ".environment",
        "src/env.js",
        "",
        ".env.",
    ] {
        assert!(!is_env_file(f), "{f}");
    }
}

#[test]
fn mask_text_takes_values_keeps_keys_comments_and_blanks_v1_cases() {
    let text = "# db\nDATABASE_URL=postgres://me:pw@db/app\nexport TOKEN=\"ghp_x\" # mine\nEMPTY=\nyaml_like: value\n\n  INDENTED = 3";
    assert_eq!(
        mask_text(text),
        format!("# db\nDATABASE_URL={DOTS}\nexport TOKEN={DOTS}\nEMPTY=\nyaml_like: {DOTS}\n\n  INDENTED = {DOTS}")
    );
    assert_eq!(mask_line("sk-live-bare-value"), DOTS, "a line with no key goes whole (an edit snippet)");
    assert_eq!(mask_line("  # a comment"), "  # a comment");
    assert_eq!(mask_line("export=1"), format!("export={DOTS}"), "export can be the key");
}

#[test]
fn a_crlf_env_file_loses_its_values_v1_kept_them() {
    // v1's /^(…)(\S.*)$/ never matched `K=v\r` (JavaScript's `.` stops at \r) and sent the line as it was
    assert_eq!(mask_text("API_KEY=sk-live-1\r\nPORT=3000\r\n"), format!("API_KEY={DOTS}\r\nPORT={DOTS}\r\n"));
    assert_eq!(mask_line("sk-bare\r"), format!("{DOTS}\r"));
    assert_eq!(mask_line("# c\r"), "# c\r");
}

#[test]
fn mask_edit_keeps_a_changed_value_a_line_without_either_value_v1_case() {
    let (b, a) = mask_edit("A=1\nB=old\n", "A=1\nB=new\nC=added\n");
    assert_eq!(b, format!("A={DOTS}\nB={DOTS}\n"));
    assert_eq!(a, format!("A={DOTS}\nB={DOTS} (changed)\nC={DOTS}\n"));
    for gone in ["old", "new", "added", "=1"] {
        assert!(!b.contains(gone) && !a.contains(gone), "{gone}");
    }
}

#[test]
fn mask_edit_a_bare_value_snippet_masks_and_still_shows_as_changed_v1_case() {
    assert_eq!(mask_edit("sk-live-one", "sk-live-two"), (DOTS.to_owned(), format!("{DOTS} (changed)")));
    assert_eq!(mask_edit("# keep", "# keep\nNEW=1"), ("# keep".to_owned(), format!("# keep\nNEW={DOTS}")));
}

#[test]
fn names_env_file_finds_a_command_that_read_one_not_a_template_v1_cases() {
    for c in ["cat .env", "head -5 apps/web/.env.local", "Get-Content '.env'", "grep KEY .env|sort", "cat <.env.production"] {
        assert!(names_env_file(c), "{c}");
    }
    for c in ["cat .env.example", "cp .env.sample .env.sample2.example", "echo env", "cat my.env", "ls .envrc", "cat .env.", "cat .env:x"] {
        assert!(!names_env_file(c), "{c}");
    }
    assert!(reads_env_file(None, Some("cat .env"), Some("Show the env")));
    assert!(reads_env_file(Some("app/.env.local"), None, Some("Read")));
    assert!(!reads_env_file(None, Some("ls"), Some("Run")));
    assert_eq!(env_file_named("cat config/prod.env.local .env"), Some(".env"));
    assert_eq!(env_file_named("head -5 apps/web/.env.local"), Some(".env.local"));
}

#[test]
fn mask_block_masks_a_code_or_diff_block_about_a_env_file_and_nothing_else() {
    let d = mask_block(&json!({ "type": "diff", "file": "cfg/.env.local", "before": "K=a", "after": "K=b" })).unwrap();
    assert_eq!(
        (d["before"].as_str(), d["after"].as_str()),
        (Some(format!("K={DOTS}").as_str()), Some(format!("K={DOTS} (changed)").as_str()))
    );
    assert_eq!(mask_block(&json!({ "type": "code", "file": ".env", "code": "K=v" })).unwrap()["code"], format!("K={DOTS}"));
    assert_eq!(mask_block(&json!({ "type": "code", "path": ".env", "code": "K=v" })).unwrap()["code"], format!("K={DOTS}"));
    assert!(mask_block(&json!({ "type": "diff", "file": ".env" })).is_none(), "nothing of its own to show");
    assert!(mask_block(&json!({ "type": "code", "file": ".env.example", "code": "K=v" })).is_none());
    assert!(mask_block(&json!({ "type": "hero", "file": ".env" })).is_none());
    let snip = mask_block(&json!({ "type": "diff", "file": ".env", "diff": "-K=old\n+K=new" })).unwrap();
    assert_eq!(snip["diff"], format!("-K={DOTS}\n+K={DOTS}"));
    let hunk = mask_block(&json!({ "type": "diff", "file": ".env", "diff": "@@ -1 +1 @@\n-K=old\n+K=new" })).unwrap();
    assert_eq!(hunk["diff"], format!("@@ -1 +1 @@\n-K={DOTS}\n+K={DOTS}"));
}

#[test]
fn mask_diffs_masks_the_env_files_hunks_only() {
    let unified = "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1,2 +1,2 @@\n # keys\n-API_KEY=sk-1\n+API_KEY=sk-2\ndiff --git a/a.ts b/a.ts\n+++ b/a.ts\n+const K=1";
    assert_eq!(
        mask_diffs(unified, false),
        format!(
            "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1,2 +1,2 @@\n # keys\n-API_KEY={DOTS}\n+API_KEY={DOTS}\ndiff --git a/a.ts b/a.ts\n+++ b/a.ts\n+const K=1"
        )
    );
    assert!(
        !mask_diffs("--- .env\n+++ .env\n@@ -1 +1 @@\n-API_KEY=sk-live-1\n+API_KEY=sk-live-2", false).contains("sk-live"),
        "--no-prefix"
    );
    let dash_u = "--- .env\t2026-01-01 10:00\n+++ .env\t2026-01-02 10:00\n@@ -1,2 +1,2 @@\n----BEGIN=x\n+---token=abc\n # c";
    assert_eq!(
        mask_diffs(dash_u, false),
        format!("--- .env\t2026-01-01 10:00\n+++ .env\t2026-01-02 10:00\n@@ -1,2 +1,2 @@\n-{DOTS}\n+{DOTS}\n # c"),
        "a changed line that reads like a header"
    );
    assert_eq!(
        mask_diffs("--- a/.env\n+++ /dev/null\n@@ -1 +0,0 @@\n-K=gone", false),
        format!("--- a/.env\n+++ /dev/null\n@@ -1 +0,0 @@\n-K={DOTS}")
    );
    assert!(mask_diffs("--- /dev/null\n+++ b/.env.local\n@@ -0,0 +1 @@\n+K=new", false).contains(&format!("+K={DOTS}")));
    let two = "diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-K=1\n+K=2\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const K=1\n+const K=2";
    assert!(mask_diffs(two, false).contains("+const K=2") && !mask_diffs(two, false).contains("+K=2"));
}

#[test]
fn the_setting_is_on_unless_switched_off() {
    assert!(mask_on(None));
    assert!(mask_on(Some(&json!(true))));
    assert!(mask_on(Some(&json!("on"))));
    assert!(!mask_on(Some(&json!(false))));
    assert!(!mask_on(Some(&json!("off"))), "v1's value");
}

#[test]
fn huge_and_empty_inputs() {
    assert_eq!(mask_text(""), "");
    assert_eq!(mask_diffs("", false), "");
    let big = (0..20_000).map(|i| format!("K{i}=v{i}")).collect::<Vec<_>>().join("\n");
    let m = mask_text(&big);
    assert!(!m.contains("=v"), "every value of a 20k-line file");
    assert_eq!(m.lines().count(), 20_000);
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[usize::try_from(self.next() % xs.len() as u64).unwrap()]
    }
}

#[test]
fn property_no_value_of_a_random_env_file_survives_and_masking_is_idempotent() {
    let mut r = Rng(0x9E37_79B9_7F4A_7C15);
    let pre = ["", "  ", "export ", "\t"];
    let sep = ["=", " = ", ": ", "="];
    let quote = ["", "\"", "'"];
    let end = ["", "\r", " # note"];
    for _ in 0..500 {
        let mut lines = Vec::new();
        let mut secrets = Vec::new();
        for i in 0..(r.next() % 12) {
            let secret = format!("zq{}x{i}", r.next() % 1_000_000);
            let q = r.pick(&quote);
            let line = match r.next() % 5 {
                0 => format!("# comment {i}"),
                1 => String::new(),
                2 => format!("{}{secret}", r.pick(&pre)), // a bare value
                _ => format!("{}KEY_{i}{}{q}{secret}{q}{}", r.pick(&pre), r.pick(&sep), r.pick(&end)),
            };
            if !line.starts_with('#') && !line.is_empty() {
                secrets.push(secret);
            }
            lines.push(line);
        }
        let text = lines.join("\n");
        let once = mask_text(&text);
        for s in &secrets {
            assert!(!once.contains(s.as_str()), "{text:?} → {once:?}");
        }
        assert_eq!(mask_text(&once), once, "idempotent: {text:?}");
        assert_eq!(once.split('\n').count(), text.split('\n').count(), "line for line");
        let (b, a) = mask_edit(&text, &format!("{text}\nNEW=zqnew"));
        assert!(!a.contains("zq") && !b.contains("zq"), "{a:?}");
    }
}

#[test]
fn env_values_are_a_files_values_quoted_and_bare_and_never_the_short_or_plain_ones() {
    let v = env_values("# c\nAPI_KEY=\"sk-live-one\"\r\nexport DB=postgres://u:p@h/db\nPORT=80\nDEBUG=true\nEMPTY=\n");
    assert_eq!(v, ["\"sk-live-one\"", "sk-live-one", "postgres://u:p@h/db"]);
    assert_eq!(env_values(""), Vec::<String>::new());
    let v = env_values("A=abc1234 # prod\nB='sec ret' # c");
    assert_eq!(v, ["abc1234 # prod", "abc1234", "'sec ret' # c", "sec ret"], "a trailing comment isn't the value");
}

#[test]
fn a_thinking_that_quotes_a_value_the_turn_read_or_writes_a_env_line_hides_just_the_value() {
    let vals = env_values("API_KEY=sk-live-one");
    let t = "The key is sk-live-one, so I'll rotate it.\n- `STRIPE_SECRET=whsec_abc`\nSet DEBUG=1 to see logs.\nx = 5";
    let m = mask_spans(t, &quote_spans(t, &vals));
    assert_eq!(m, format!("The key is {DOTS}, so I'll rotate it.\n- `STRIPE_SECRET={DOTS}`\nSet DEBUG=1 to see logs.\nx = 5"));
    assert!(quote_spans("nothing here", &vals).is_empty(), "no read, no shape: as it is");
    // overlapping (a value on a .env-shaped line) merges into one range; non-ASCII stays on char boundaries
    let t = "TOKEN=sk-live-one é sk-live-one";
    assert_eq!(mask_spans(t, &quote_spans(t, &vals)), format!("TOKEN={DOTS}"));
}

#[test]
fn text_spans_hide_what_mask_text_hides() {
    for t in ["API_KEY=sk-1\r\n# note\nPORT=3000\n\nbare-secret", "cat: .env: Permission denied", ""] {
        assert_eq!(mask_spans(t, &text_spans(t)), mask_text(t), "{t:?}");
    }
}

#[test]
fn spans_that_dont_fit_the_text_hide_all_of_it_fail_closed() {
    assert_eq!(mask_spans("short", &[[2, 99]]), DOTS);
    assert_eq!(mask_spans("ab", &[[1, 2], [0, 1]]), DOTS, "out of order");
    assert_eq!(mask_spans("é", &[[1, 2]]), DOTS, "inside a character");
    assert_eq!(mask_spans("as is", &[]), "as is");
}

#[test]
fn every_line_of_a_multi_line_quoted_value_is_known_a_pem_key_in_quotes() {
    let pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAzq1line2\nQWERTYsecondline9876\n-----END RSA PRIVATE KEY-----";
    let file = format!("A=1\nPRIVATE_KEY=\"{pem}\"\nAFTER=after-value\n");
    let v = env_values(&file);
    for line in pem.lines() {
        assert!(v.iter().any(|x| x == line), "{line} in {v:?}");
    }
    assert!(v.iter().any(|x| x == pem), "the whole value too");
    assert!(v.iter().any(|x| x == "after-value"), "the value after it is read as a line again: {v:?}");
    // quoted later, one line at a time or whole, nothing of it shows
    for t in ["the key's body is MIIEowIBAAKCAQEAzq1line2 and QWERTYsecondline9876".to_owned(), format!("key:\n{pem}\n")] {
        let m = mask_spans(&t, &quote_spans(&t, &v));
        assert!(!m.contains("MIIEow") && !m.contains("QWERTY"), "{m}");
    }
    // a single-quoted one, and one never closed (all it ran on to is its value: fail closed)
    let v = env_values("K='line-one-x\nline-two-y'\n");
    assert!(v.iter().any(|x| x == "line-two-y") && v.iter().any(|x| x == "line-one-x\nline-two-y"), "{v:?}");
    let v = env_values("K=\"open-start\nrest-of-file\n");
    assert!(v.iter().any(|x| x == "rest-of-file"), "{v:?}");
}

#[test]
fn a_value_cut_short_in_a_label_or_an_output_is_hidden_as_far_as_it_shows() {
    let v = env_values("API_KEY=sk-live-abcdef0123456789");
    // a label clipped inside the value, with or without its ellipsis; an output's tail that starts inside one
    for (t, want) in [
        ("Running curl -H 'Bearer sk-live-abc…", format!("Running curl -H 'Bearer {DOTS}…")),
        ("Running curl -H 'Bearer sk-live-abc", format!("Running curl -H 'Bearer {DOTS}")),
        ("… 3 lines cut …\n0123456789' done", format!("… 3 lines cut …\n{DOTS}' done")),
        ("whole sk-live-abcdef0123456789 here", format!("whole {DOTS} here")),
    ] {
        assert_eq!(mask_spans(t, &value_spans(t, &v)), want, "{t}");
    }
    // a start shorter than a value's shortest part, or text that merely shares letters, stays
    for t in ["Run sk-li…", "Running npm test", "sk-live is a prefix people know"] {
        assert!(value_spans(t, &v).is_empty(), "{t}");
    }
    // a command line is matched on values only: `NODE_ENV=test` is no secret
    assert_eq!(value_spans("NODE_ENV=test npm test", &v), Vec::<[u32; 2]>::new());
    assert!(value_spans("é…é", &env_values("K=ééééééééé")).iter().all(|[a, b]| a < b), "char boundaries");
}

#[test]
fn a_quote_never_closed_still_lets_the_keys_after_it_be_known() {
    let v = env_values("MSG=\"hello there\nAPI_KEY=sk-live-123456\nexport DB='postgres://x'\n");
    for want in ["sk-live-123456", "postgres://x", "hello there"] {
        assert!(v.iter().any(|x| x == want), "{want} in {v:?}");
    }
}
