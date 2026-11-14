//! `harness.sessions@1` (ADR-0035): a harness module reads the sessions its CLI stored by itself (run
//! outside wisp), so `wisp adopt` can make them wisp tasks. Additive (2026-11-09).

use serde::{Deserialize, Serialize};
use wisp_kernel::{BoxFuture, Point};

/// A session a CLI ran outside wisp.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct OutsideSession {
    /// the harness id (`claude`, `codex`)
    pub harness: String,
    /// its id in that CLI (what resumes it there)
    pub id: String,
    pub cwd: String,
    /// its first prompt, cut
    pub title: String,
    pub started_at: i64,
    pub updated_at: i64,
    pub prompts: u32,
}

/// One of its turns: what was asked and what came back.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "runtime/")]
pub struct SessionTurn {
    pub prompt: String,
    pub text: String,
    pub started_at: i64,
    pub ended_at: i64,
    #[serde(default)]
    pub model: String,
}

pub trait HarnessSessions: Send + Sync + 'static {
    /// the harness these are (`claude`)
    fn harness(&self) -> &'static str;
    /// this folder's sessions, newest first
    fn list(&self, cwd: &str) -> BoxFuture<'static, Vec<OutsideSession>>;
    /// one session and its turns
    fn read(&self, id: &str) -> BoxFuture<'static, Option<(OutsideSession, Vec<SessionTurn>)>>;
    /// the CLI's own log of a session, as it keeps it (what `wisp open` restores elsewhere). Additive.
    fn raw(&self, _id: &str) -> BoxFuture<'static, Option<Vec<u8>>> {
        Box::pin(async { None })
    }
    /// that log put back into the CLI's store on this computer, for `cwd`, so the CLI resumes it. Additive.
    fn restore(&self, _id: &str, _cwd: &str, _raw: Vec<u8>) -> BoxFuture<'static, bool> {
        Box::pin(async { false })
    }
}

pub const SESSIONS: Point<dyn HarnessSessions> = Point::new("harness.sessions", 1);

/// A session id as a file name: letters, digits, `-` and `_` only, so it never names a path.
pub fn safe_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// An ISO-8601 UTC time (`2026-11-08T10:00:00.123Z`) in ms; 0 when it isn't one.
#[allow(clippy::many_single_char_names)] // y, m, d, h: the calendar
pub fn iso_ms(s: &str) -> i64 {
    let n = |a: usize, b: usize| s.get(a..b).and_then(|x| x.parse::<i64>().ok());
    let (Some(y), Some(m), Some(d), Some(h), Some(mi), Some(sec)) = (n(0, 4), n(5, 7), n(8, 10), n(11, 13), n(14, 16), n(17, 19)) else {
        return 0;
    };
    let ms = if s.get(19..20) == Some(".") { n(20, 23).unwrap_or(0) } else { 0 };
    // Howard Hinnant's days_from_civil
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    ((days * 24 + h) * 60 + mi) * 60_000 + sec * 1000 + ms
}

/// The text of a message's `content`: a string, or the `text` of its text parts (`text`, `input_text`,
/// `output_text`); None when it's only tool results.
pub fn content_text(c: &serde_json::Value) -> Option<String> {
    if let Some(s) = c.as_str() {
        return Some(s.to_owned());
    }
    let parts: Vec<&str> = c
        .as_array()?
        .iter()
        .filter(|p| matches!(p.get("type").and_then(serde_json::Value::as_str), Some("text" | "input_text" | "output_text")))
        .filter_map(|p| p.get("text").and_then(serde_json::Value::as_str))
        .collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

/// What a CLI wrapped in `<tag>…</tag>`, trimmed; None when it isn't there.
pub fn tagged(s: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let from = s.find(&open)? + open.len();
    let to = s[from..].find(&format!("</{tag}>"))? + from;
    Some(s[from..to].trim().to_owned())
}

/// A folder as the CLI may have stored it: as given and resolved (`/tmp` is `/private/tmp` on macOS); the
/// host resolves it (this crate does no I/O).
pub fn folder_forms(cwd: &str, resolved: Option<&std::path::Path>) -> Vec<String> {
    let mut out = vec![cwd.trim_end_matches('/').to_owned()];
    if let Some(r) = resolved.map(|r| r.display().to_string()).filter(|r| !out.contains(r)) {
        out.push(r);
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn tags_and_folders() {
        assert_eq!(super::tagged("<t>x</t>\n<q>\n hi \n</q>", "q").as_deref(), Some("hi"));
        assert_eq!(super::tagged("<q>open", "q"), None);
        assert_eq!(
            super::folder_forms("/tmp/a/", Some(std::path::Path::new("/private/tmp/a"))),
            vec!["/tmp/a".to_owned(), "/private/tmp/a".to_owned()]
        );
    }

    #[test]
    fn iso_times() {
        assert_eq!(super::iso_ms("1970-01-01T00:00:01.500Z"), 1500);
        assert_eq!(super::iso_ms("2026-11-08T10:00:00Z"), 1_794_132_000_000);
        assert_eq!(super::iso_ms("nope"), 0);
    }
}
