//! wisp-share-core: what a share takes out before it leaves (ADR-0027), without IO.
//!
//! - **Secrets**: API keys and tokens by their shapes (OpenAI/Anthropic `sk-…`, GitHub `ghp_…` /
//!   `github_pat_…`, Slack `xox…`, AWS `AKIA…`, Google `AIza…`, bearer tokens, private key blocks, and
//!   `password=…`-style assignments) → `<secret>`.
//! - **Env**: the values of the sharer's secret-looking environment variables (`*KEY*`, `*TOKEN*`,
//!   `*SECRET*`, `*PASSWORD*`) → `<env:NAME>`.
//! - **Paths**: the project folder → `<project>`, the home folder → `~`.
//! - **Names**: other tasks' titles and crew names the sharer didn't choose → `<task>` / `<crew>`.
//!
//! The same scrub serves `wisp history export`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};
use wisp_share_api::{Bundle, Redaction};

/// What to take out besides the secret shapes.
#[derive(Debug, Clone, Default)]
pub struct Scrub {
    /// (name, value) of the sharer's secret-looking environment variables
    pub env: Vec<(String, String)>,
    pub project: String,
    pub home: String,
    /// (text, what it becomes): other tasks' titles, crew names not chosen
    pub names: Vec<(String, String)>,
}

/// Environment variables whose values a share masks.
pub fn secret_env(vars: impl IntoIterator<Item = (String, String)>) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = vars
        .into_iter()
        .filter(|(k, v)| {
            let k = k.to_ascii_uppercase();
            v.len() >= 8 && ["KEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "CREDENTIAL"].iter().any(|w| k.contains(w))
        })
        .collect();
    // longest first, so a value inside another is masked by the longer
    out.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
    out
}

fn patterns() -> &'static [Regex] {
    static P: OnceLock<Vec<Regex>> = OnceLock::new();
    P.get_or_init(|| {
        [
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
            r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}",
            r"\bgh[pousr]_[A-Za-z0-9]{30,}",
            r"\bgithub_pat_[A-Za-z0-9_]{30,}",
            r"\bxox[abprs]-[A-Za-z0-9-]{10,}",
            r"\bAKIA[0-9A-Z]{16}\b",
            r"\bAIza[0-9A-Za-z_-]{35}",
            r"(?i)\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*",
            r#"(?i)\b(?:api[_-]?key|(?:access[_-]?)?token|secret|password|passwd)\b\s*[:=]\s*["']?[^\s"',;]{8,}"#,
        ]
        .iter()
        .filter_map(|p| Regex::new(p).ok())
        .collect()
    })
}

/// A secret shortened for the preview: its start and end only.
fn hint(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    if c.len() <= 8 {
        return "…".into();
    }
    format!("{}…{}", c[..4].iter().collect::<String>(), c[c.len() - 4..].iter().collect::<String>())
}

/// `text` scrubbed, with what was taken out (`at` is where it is).
pub fn scrub_text(text: &str, s: &Scrub, at: &str, out: &mut Vec<Redaction>) -> String {
    let mut t = text.to_owned();
    for re in patterns() {
        if re.is_match(&t) {
            let mut found = Vec::new();
            t = re
                .replace_all(&t, |c: &regex::Captures<'_>| {
                    found.push(c[0].to_owned());
                    "<secret>".to_owned()
                })
                .into_owned();
            out.extend(found.into_iter().map(|f| Redaction {
                kind: "secret".into(),
                at: at.into(),
                was: hint(&f),
                now: "<secret>".into(),
            }));
        }
    }
    for (name, v) in &s.env {
        if t.contains(v.as_str()) {
            let now = format!("<env:{name}>");
            t = t.replace(v.as_str(), &now);
            out.push(Redaction { kind: "env".into(), at: at.into(), was: hint(v), now });
        }
    }
    for (from, to) in [(s.project.as_str(), "<project>"), (s.home.as_str(), "~")] {
        let from = from.trim_end_matches('/');
        if from.len() > 1 && t.contains(from) {
            t = t.replace(&format!("/private{from}"), to).replace(from, to);
            out.push(Redaction { kind: "path".into(), at: at.into(), was: from.into(), now: to.into() });
        }
    }
    for (name, to) in &s.names {
        if name.len() > 2 && t.contains(name.as_str()) {
            t = t.replace(name.as_str(), to);
            out.push(Redaction { kind: "name".into(), at: at.into(), was: name.clone(), now: to.clone() });
        }
    }
    t
}

/// Every string in `v` scrubbed (keys too, for paths).
pub fn scrub(v: &Value, s: &Scrub, at: &str, out: &mut Vec<Redaction>) -> Value {
    match v {
        Value::String(t) => Value::String(scrub_text(t, s, at, out)),
        Value::Array(a) => Value::Array(a.iter().enumerate().map(|(i, x)| scrub(x, s, &format!("{at}/{i}"), out)).collect()),
        Value::Object(o) => Value::Object(
            o.iter().map(|(k, x)| (scrub_text(k, s, at, &mut Vec::new()), scrub(x, s, &format!("{at}/{k}"), out))).collect::<Map<_, _>>(),
        ),
        other => other.clone(),
    }
}

/// The bytes a bundle's signature is over: its JSON without `sig`, keys sorted.
pub fn canonical(b: &Bundle) -> Vec<u8> {
    let mut v = serde_json::to_value(b).unwrap_or(Value::Null);
    if let Some(o) = v.as_object_mut() {
        o.remove("sig");
    }
    // serde_json's map is ordered by key: the text is canonical
    v.to_string().into_bytes()
}

/// How many redactions of each kind.
pub fn counts(r: &[Redaction]) -> Value {
    let mut m = Map::new();
    for x in r {
        let n = m.get(&x.kind).and_then(Value::as_u64).unwrap_or(0) + 1;
        m.insert(x.kind.clone(), Value::from(n));
    }
    Value::Object(m)
}

/// A file name from a title: `fix-the-login.wisp-task`.
pub fn slug(title: &str) -> String {
    let mut s = String::new();
    for c in title.chars() {
        if c.is_alphanumeric() {
            s.extend(c.to_lowercase());
        } else if !s.ends_with('-') && !s.is_empty() {
            s.push('-');
        }
        if s.len() >= 48 {
            break;
        }
    }
    let s = s.trim_end_matches('-');
    if s.is_empty() { "task".into() } else { s.to_owned() }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn secrets_env_paths_and_names_go() {
        let s = Scrub {
            env: secret_env([("MY_API_KEY".into(), "hunter2hunter2".into()), ("PATH".into(), "/usr/bin:/bin".into())]),
            project: "/Users/me/api".into(),
            home: "/Users/me".into(),
            names: vec![("Payroll migration".into(), "<task>".into())],
        };
        let mut r = Vec::new();
        let v = json!({ "prompt": "use sk-ant-abcdefghijklmnopqrstuvwx and token=abcd1234efgh in /Users/me/api/src/a.ts, see ~/notes and /Users/me/x; key hunter2hunter2; like Payroll migration", "n": 3 });
        let got = scrub(&v, &s, "spec", &mut r);
        let p = got["prompt"].as_str().unwrap();
        assert_eq!(p, "use <secret> and <secret> in <project>/src/a.ts, see ~/notes and ~/x; key <env:MY_API_KEY>; like <task>");
        let kinds: Vec<&str> = r.iter().map(|x| x.kind.as_str()).collect();
        assert_eq!(kinds, ["secret", "secret", "env", "path", "path", "name"]);
        assert_eq!(r[0].was, "sk-a…uvwx", "the preview shows only its ends");
        assert_eq!(counts(&r), json!({ "secret": 2, "env": 1, "path": 2, "name": 1 }));
        let key = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";
        assert_eq!(scrub_text(key, &Scrub::default(), "x", &mut Vec::new()), "<secret>");
        assert_eq!(slug("Fix the login: 401s!"), "fix-the-login-401s");
    }

    #[test]
    fn the_signature_is_over_everything_but_itself() {
        let mut b = Bundle { id: "b1".into(), title: "t".into(), ..Bundle::default() };
        let one = canonical(&b);
        b.sig = "x".into();
        assert_eq!(canonical(&b), one);
        b.title = "u".into();
        assert_ne!(canonical(&b), one);
    }
}
