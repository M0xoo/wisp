//! A task in a repo's `.wisp/` (ADR-0033), sans-IO: what `wisp track` writes for a full share — the task
//! file (`tasks/YYYY/MM/<id12>-<slug>.task.yml`: the spec, the setup, its commits, PR and files), its
//! report (`.report.md`) and its transcript (`history/<id>.jsonl.zst`, one turn per line, zstd) — and
//! what reads them back (trailers, the task file's fields).

use std::fmt::Write as _;

use serde_json::{Map, Value, json};
use wisp_share_api::Bundle;

/// A title as a file name part: lower-case words joined by `-`.
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
    s.trim_end_matches('-').to_owned()
}

/// The trailer a commit names its task with.
pub const TRAILER: &str = "Wisp-Task:";

/// `YYYY/MM` of a time in ms (UTC).
pub fn year_month(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // Howard Hinnant's civil_from_days
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}/{m:02}")
}

/// The short id a file name and a trailer carry.
pub fn short(id: &str) -> &str {
    &id[..id.len().min(12)]
}

/// `tasks/2026/11/01a1bc12ab34-fix-flaky-login` (no extension).
pub fn base_name(id: &str, title: &str, created_at: i64) -> String {
    let slug: String = slug(title).chars().take(48).collect();
    format!("tasks/{}/{}-{}", year_month(created_at), short(id), if slug.is_empty() { "task".into() } else { slug })
}

/// The task ids a commit message names (`Wisp-Task: <id>` lines).
pub fn trailers(message: &str) -> Vec<String> {
    message.lines().filter_map(|l| l.trim().strip_prefix(TRAILER)).map(|r| r.trim().to_owned()).filter(|r| !r.is_empty()).collect()
}

/// The report as markdown: each answer's prompt, its hero and markdown blocks, then the files.
pub fn report_md(title: &str, report: &Value) -> String {
    let mut out = format!("# {title}\n");
    for a in report.get("answers").and_then(Value::as_array).into_iter().flatten() {
        _ = write!(out, "\n## {}\n\n", a.get("prompt").and_then(Value::as_str).unwrap_or_default().lines().next().unwrap_or_default());
        for b in a.get("blocks").and_then(Value::as_array).into_iter().flatten() {
            let s = |k: &str| b.get(k).and_then(Value::as_str).unwrap_or_default();
            match s("type") {
                "hero" => _ = write!(out, "**{}**: {}\n\n", s("title"), s("summary")),
                "markdown" => _ = write!(out, "{}\n\n", s("text")),
                "callout" => _ = write!(out, "> **{}**: {}\n\n", s("title"), s("text")),
                _ => {}
            }
        }
        if a.get("blocks").and_then(Value::as_array).is_none_or(Vec::is_empty) {
            let text = a.get("text").and_then(Value::as_str).unwrap_or_default();
            _ = write!(out, "{}\n\n", text.split("```wisp").next().unwrap_or_default().trim());
        }
    }
    let files: Vec<&str> = report.get("files").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).collect();
    if !files.is_empty() {
        out.push_str("## Files\n\n");
        for f in files {
            _ = writeln!(out, "- `{f}`");
        }
    }
    out
}

/// What the task file holds.
pub fn task_doc(b: &Bundle, commits: &[String], pr: Option<&str>, tracked_by: &str) -> Value {
    task_doc_with(b, commits, pr, tracked_by, None)
}

/// The task file, with the harness session it ran as (what `wisp open` resumes: `{harness, id}`).
pub fn task_doc_with(b: &Bundle, commits: &[String], pr: Option<&str>, tracked_by: &str, session: Option<(&str, &str)>) -> Value {
    let files = b.report.as_ref().and_then(|r| r.get("files")).cloned().unwrap_or(json!([]));
    let mut m = Map::new();
    m.insert("wispTask".into(), json!(1));
    m.insert("id".into(), json!(b.id));
    m.insert("title".into(), json!(b.title));
    m.insert("createdAt".into(), json!(b.created_at));
    m.insert("level".into(), json!(b.level));
    if !tracked_by.is_empty() {
        m.insert("trackedBy".into(), json!(tracked_by));
    }
    m.insert("spec".into(), b.spec.clone());
    if !b.formula.is_null() {
        m.insert("formula".into(), b.formula.clone());
    }
    m.insert("commits".into(), json!(commits));
    if let Some(p) = pr {
        m.insert("pr".into(), json!(p));
    }
    m.insert("files".into(), files);
    if let Some((h, id)) = session {
        m.insert("session".into(), json!({ "harness": h, "id": id }));
    }
    Value::Object(m)
}

/// A setting under `history:` in `.wisp/wisp.yml` (`track: auto|ask|manual`, `adopt: ask|auto|off`).
pub fn history_setting(wisp_yml: &str, key: &str, default: &str) -> String {
    let doc: Value = serde_saphyr::from_str(wisp_yml).unwrap_or_default();
    match doc.pointer(&format!("/history/{key}")) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        _ => default.to_owned(),
    }
}

/// Bytes compressed as a transcript is (zstd).
pub fn compress(raw: &[u8]) -> Vec<u8> {
    zstd::encode_all(raw, 9).unwrap_or_default()
}

/// Compressed bytes back.
pub fn decompress(z: &[u8]) -> Vec<u8> {
    zstd::decode_all(z).unwrap_or_default()
}

/// The transcript, one turn (and its steps) per line, zstd-compressed.
pub fn transcript(history: &Value) -> Vec<u8> {
    let lines: Vec<String> = history.as_array().into_iter().flatten().map(Value::to_string).collect();
    zstd::encode_all(lines.join("\n").as_bytes(), 9).unwrap_or_default()
}

/// A transcript read back.
pub fn read_transcript(bytes: &[u8]) -> Vec<Value> {
    let raw = zstd::decode_all(bytes).unwrap_or_default();
    String::from_utf8_lossy(&raw).lines().filter_map(|l| serde_json::from_str(l).ok()).collect()
}

/// Every file `wisp track` writes, relative to `.wisp/`, for a bundle (a full one has all three).
pub fn files_for(b: &Bundle, commits: &[String], pr: Option<&str>, tracked_by: &str) -> Vec<(String, Vec<u8>)> {
    files_with(b, commits, pr, tracked_by, None)
}

/// [`files_for`], the task file naming the harness session it ran as.
pub fn files_with(b: &Bundle, commits: &[String], pr: Option<&str>, tracked_by: &str, session: Option<(&str, &str)>) -> Vec<(String, Vec<u8>)> {
    let base = base_name(&b.id, &b.title, b.created_at);
    let mut out = vec![(format!("{base}.task.yml"), serde_saphyr::to_string(&task_doc_with(b, commits, pr, tracked_by, session)).unwrap_or_default().into_bytes())];
    if let Some(r) = &b.report {
        out.push((format!("{base}.report.md"), report_md(&b.title, r).into_bytes()));
    }
    if let Some(h) = &b.history {
        out.push((format!("history/{}.jsonl.zst", b.id), transcript(h)));
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn layout_trailers_and_the_transcript() {
        assert_eq!(year_month(1_794_181_336_230), "2026/11");
        assert_eq!(year_month(0), "1970/01");
        assert_eq!((history_setting("history: { inject: true }", "inject", "false"), history_setting("x: 1", "track", "ask")), ("true".to_owned(), "ask".to_owned()));
        assert_eq!(base_name("01a1bc12ab34cdef", "Fix the flaky login!", 1_794_181_336_230), "tasks/2026/11/01a1bc12ab34-fix-the-flaky-login");
        assert_eq!(trailers("fix: x\n\nWhy.\n\nWisp-Task: 01a1bc\nCo-Authored-By: y\nWisp-Task: 02b2"), ["01a1bc", "02b2"]);
        let h = json!([{ "turn": { "prompt": "a" } }, { "turn": { "prompt": "b" } }]);
        let z = transcript(&h);
        assert_eq!(read_transcript(&z), h.as_array().unwrap().clone());
        let md = report_md("T", &json!({ "answers": [{ "prompt": "do it", "blocks": [{ "type": "hero", "title": "Done", "summary": "it works" }] }], "files": ["src/a.rs"] }));
        assert!(md.contains("## do it") && md.contains("**Done**: it works") && md.contains("- `src/a.rs`"), "{md}");
    }
}
