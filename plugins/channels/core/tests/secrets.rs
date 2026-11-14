//! The secret patterns, one by one against what v1's regexes match and don't, plus a model test:
//! a random text never panics, redacting is idempotent, and a planted token always goes.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use wisp_channels_core::secrets::{KINDS, any, redact, scan};

fn kind(text: &str) -> Option<&'static str> {
    scan(text).first().map(|h| h.what)
}

// Assembled at run time so this file holds no token-shaped string.
fn j(parts: &[&str]) -> String {
    parts.concat()
}

#[test]
fn each_kind_matches_what_v1_matched() {
    let a40 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    let cases = [
        (j(&["-----BEGIN OPENSSH ", "PRIVATE KEY-----"]), "a private key"),
        (j(&["-----BEGIN PGP PRIVATE KEY", " BLOCK-----"]), "a private key"),
        (j(&["ghp_", &a40[..36]]), "a GitHub token"),
        (j(&["github_pat_", a40, "_x"]), "a GitHub token"),
        (j(&["sk-ant-", "api03-abcdefghijklmnopqrstu"]), "an Anthropic API key"),
        (j(&["sk-proj-", &a40[..34]]), "an OpenAI API key"),
        (j(&["AKIA", "IOSFODNN7EXAMPLE"]), "an AWS access key"),
        (j(&["AIza", "SyA-1234567890abcdefghijklmnopqrstu"]), "a Google API key"),
        (j(&["xoxb-", "1234567890-abc"]), "a Slack token"),
        (j(&["MTA", "xMjM0NTY3ODkwMTIzNDU2Nzg5.Gh1jKl.", "abcdefghijklmnopqrstuvwxyz0123"]), "a Discord bot token"),
        (j(&["sk_live_", "abcdefghijklmnopqrstuvwx"]), "a Stripe key"),
        (j(&["npm_", &a40[..36]]), "an npm token"),
        (j(&["eyJ", "hbGciOiJIUzI1.eyJ", "zdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4"]), "a JSON Web Token"),
        (j(&["https://ada:", "hunter22@example.com/x"]), "a password in a URL"),
        (j(&["API_KEY=", "abcdefghijklmnop1234"]), "a secret value"),
        (j(&["\"client_secret\": \"", "Zm9vYmFyYmF6cXV4MTIzNA==\""]), "a secret value"),
    ];
    for (text, want) in &cases {
        assert_eq!(kind(text), Some(*want), "{text}");
        assert!(any(text));
        let (out, hits) = redact(text);
        assert!(hits >= 1, "{text}");
        assert!(out.contains(&format!("[redacted: {want}]")), "{text} → {out}");
    }
}

#[test]
fn near_misses_are_not_secrets() {
    let a40 = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0";
    let misses = [
        j(&["ghp_", &a40[..29]]),          // too short
        j(&["xghp_", &a40[..36]]),         // no word boundary before
        j(&["ghp_", &a40[..36], "_more"]), // no boundary after the run
        j(&["AKIA", "IOSFODNN7EXAMPLE1"]), // 17, not 16
        j(&["npm_", &a40[..37]]),          // 37, not 36
        "token = <your token here>".into(),
        "password: ${PASSWORD_FROM_ENV_VAR}".into(),
        "api_key = $API_KEY_FROM_SOMEWHERE".into(),
        "secret: xxxxxxxxxxxxxxxxxxxxxxxx".into(),
        "token: your-token-goes-right-here".into(),
        "password=changeme-changeme-changeme".into(),
        "my-token-name = short".into(),
        "https://example.com:8080/path@x".into(),
        "mail ada@example.com about it".into(),
        "Mr.Smith.went.to.the.market.today".into(),
    ];
    for text in &misses {
        assert_eq!(kind(text), None, "{text}");
        assert_eq!(redact(text), (text.clone(), 0));
    }
}

#[test]
fn one_hit_per_line_the_first_kind_in_order() {
    let t = j(&["ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"]);
    let text = format!("ok\ntoken={t}\r\nfine\n{}", j(&["sk-ant-", "api03-abcdefghijklmnopqrstu"]));
    let hits = scan(&text);
    assert_eq!(hits.len(), 2);
    assert_eq!((hits[0].line, hits[0].what), (2, "a GitHub token"));
    assert_eq!((hits[1].line, hits[1].what), (4, "an Anthropic API key"));
}

#[test]
fn unicode_around_a_secret_keeps_char_boundaries() {
    let t = j(&["ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"]);
    let (out, hits) = redact(&format!("é→{t}←ü"));
    assert_eq!(hits, 1);
    assert_eq!(out, "é→[redacted: a GitHub token]←ü");
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a>(&mut self, v: &[&'a str]) -> &'a str {
        v[usize::try_from(self.next() % v.len() as u64).unwrap()]
    }
}

#[test]
fn model_random_text_never_panics_redaction_is_idempotent_and_a_planted_token_goes() {
    let bits = [
        "a",
        " ",
        "\n",
        "-",
        "_",
        ":",
        "=",
        "\"",
        "@",
        "/",
        "sk-",
        "ghp_",
        "AKIA",
        "eyJ",
        "é",
        "→",
        "BEGIN ",
        "-----",
        "PRIVATE KEY",
        "://",
        "x:y@",
        "token",
        "0123456789",
    ];
    let planted = j(&["ghp_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"]);
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    for _ in 0..3000 {
        let n = rng.next() % 40;
        let mut s: String = (0..n).map(|_| rng.pick(&bits)).collect();
        let _ = scan(&s);
        let (once, _) = redact(&s);
        assert_eq!(redact(&once).0, once, "idempotent: {s:?}");
        s.push(' ');
        s.push_str(&planted);
        s.push(' ');
        assert!(!redact(&s).0.contains(&planted), "{s:?}");
    }
    assert_eq!(KINDS.len(), 13);
}
