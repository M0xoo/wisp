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
}

pub const SESSIONS: Point<dyn HarnessSessions> = Point::new("harness.sessions", 1);

/// An ISO-8601 UTC time (`2026-11-08T10:00:00.123Z`) in ms; 0 when it isn't one.
#[allow(clippy::many_single_char_names)] // y, m, d, h: the calendar
pub fn iso_ms(s: &str) -> i64 {
    let n = |a: usize, b: usize| s.get(a..b).and_then(|x| x.parse::<i64>().ok());
    let (Some(y), Some(m), Some(d), Some(h), Some(mi), Some(sec)) = (n(0, 4), n(5, 7), n(8, 10), n(11, 13), n(14, 16), n(17, 19)) else { return 0 };
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
    let parts: Vec<&str> = c.as_array()?.iter().filter(|p| matches!(p.get("type").and_then(serde_json::Value::as_str), Some("text" | "input_text" | "output_text"))).filter_map(|p| p.get("text").and_then(serde_json::Value::as_str)).collect();
    (!parts.is_empty()).then(|| parts.join("\n"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn iso_times() {
        assert_eq!(super::iso_ms("1970-01-01T00:00:01.500Z"), 1500);
        assert_eq!(super::iso_ms("2026-11-08T10:00:00Z"), 1_794_132_000_000);
        assert_eq!(super::iso_ms("nope"), 0);
    }
}
