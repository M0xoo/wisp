//! The PR panel: one PR in full without the noise (v1 checkOf, threadsOf, prDetailOf).

use std::collections::HashMap;

use serde_json::Value;
use wisp_ship_api::{CheckItem, Note, PrDetail, PrFile, PrMore, Reviewer, Thread, ThreadNote};

use crate::pr::{Class, classify, is_bot, login, pr_summary, stringish, text, text_or, uint};
use crate::time::parse_ms;

const MAX_FILES: usize = 300;

fn check_state(v: &str) -> &'static str {
    match classify(v) {
        Class::Pass if v.eq_ignore_ascii_case("SUCCESS") => "pass",
        Class::Pass => "skip",
        Class::Fail => "fail",
        Class::Pending => "pending",
    }
}

fn check_rank(state: &str) -> u8 {
    match state {
        "fail" => 0,
        "pending" => 1,
        "pass" => 2,
        _ => 3,
    }
}

/// A check run or a status context, as the panel lists it.
pub fn check_of(c: &Value) -> CheckItem {
    let run = text(c, "__typename") != Some("StatusContext") && c.get("name").is_some();
    let v = text(c, "conclusion").or_else(|| text(c, "state")).or_else(|| text(c, "status")).unwrap_or_default();
    let start = text(c, "startedAt").and_then(parse_ms).filter(|t| *t != 0);
    let end = text(c, "completedAt").and_then(parse_ms).filter(|t| *t != 0);
    let name = if run { stringish(c.get("name")) } else { text(c, "context").or_else(|| text(c, "name")).unwrap_or("check").to_owned() };
    CheckItem {
        name,
        workflow: if run { text_or(c, "workflowName") } else { String::new() },
        state: check_state(v).to_owned(),
        url: text(c, "detailsUrl").or_else(|| text(c, "targetUrl")).unwrap_or_default().to_owned(),
        ms: match (start, end) {
            (Some(s), Some(e)) if e >= s => Some(e - s),
            _ => None,
        },
        started_at: start,
    }
}

/// Failing first, then running, then passed, then skipped; by name within each.
pub fn check_list(rollup: Option<&Value>) -> Vec<CheckItem> {
    let mut list: Vec<CheckItem> = rollup.and_then(Value::as_array).into_iter().flatten().map(check_of).collect();
    list.sort_by(|a, b| check_rank(&a.state).cmp(&check_rank(&b.state)).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name)));
    list
}

fn stamp(j: &Value, key: &str) -> Option<i64> {
    text(j, key).and_then(parse_ms).filter(|t| *t != 0)
}

/// Inline review comments (gh api …/pulls/N/comments) grouped into threads, in the order they started.
pub fn threads_of(list: &[Value]) -> Vec<Thread> {
    let mut threads: Vec<Thread> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    for c in list {
        let user = c.get("user");
        let author = login(user);
        let bot = is_bot(&author, user.and_then(|u| text(u, "type")));
        let note = ThreadNote { author, bot, body: stringish(c.get("body")), at: stamp(c, "created_at"), url: text_or(c, "html_url") };
        let id = stringish(c.get("id"));
        let root = c.get("in_reply_to_id").map(|v| stringish(Some(v))).filter(|r| !r.is_empty() && r != "0").and_then(|r| by_id.get(&r).copied());
        if let Some(at) = root {
            threads[at].notes.push(note);
            by_id.insert(id, at);
            continue;
        }
        let line = c.get("line").and_then(Value::as_i64).or_else(|| c.get("original_line").and_then(Value::as_i64));
        // `position: null` (present and null) with no line: the line it was on changed since
        let outdated = c.get("position").is_some_and(Value::is_null) && c.get("line").is_none_or(Value::is_null);
        threads.push(Thread { path: text_or(c, "path"), line, outdated, notes: vec![note] });
        by_id.insert(id, threads.len() - 1);
    }
    threads
}

fn notes_of(j: &Value, reviews: &[&Value]) -> Vec<Note> {
    let comments = j.get("comments").and_then(Value::as_array).into_iter().flatten().map(|c| {
        let author = login(c.get("author"));
        Note { kind: "comment".into(), state: None, bot: is_bot(&author, None), author, body: stringish(c.get("body")), at: stamp(c, "createdAt"), url: text_or(c, "url") }
    });
    let said = reviews.iter().filter(|r| !stringish(r.get("body")).trim().is_empty()).map(|r| {
        let author = login(r.get("author"));
        Note { kind: "review".into(), state: Some(text_or(r, "state")), bot: is_bot(&author, None), author, body: stringish(r.get("body")), at: stamp(r, "submittedAt"), url: String::new() }
    });
    let mut notes: Vec<Note> = comments.chain(said).collect();
    notes.sort_by_key(|n| n.at.unwrap_or(0)); // stable: same-time notes keep their order
    notes
}

/// Each reviewer's latest approval or change request, in the order they first reviewed. A dismissed
/// review takes its reviewer out.
fn reviewers_of(reviews: &[&Value]) -> Vec<Reviewer> {
    let mut order: Vec<(String, String)> = Vec::new();
    for r in reviews {
        let state = text_or(r, "state");
        if !matches!(state.as_str(), "APPROVED" | "CHANGES_REQUESTED" | "DISMISSED") {
            continue;
        }
        let author = login(r.get("author"));
        match order.iter_mut().find(|(a, _)| *a == author) {
            Some(slot) => slot.1 = state,
            None => order.push((author, state)),
        }
    }
    order.into_iter().filter(|(_, s)| s != "DISMISSED").map(|(author, state)| Reviewer { author, state }).collect()
}

/// `gh pr view --json DETAIL_FIELDS` plus its inline threads → the panel's PR.
pub fn pr_detail_of(j: &Value, threads: Vec<Thread>, checked_at: i64) -> PrDetail {
    let reviews: Vec<&Value> = j.get("reviews").and_then(Value::as_array).into_iter().flatten().filter(|r| text(r, "state") != Some("PENDING")).collect();
    let files: Vec<&Value> = j.get("files").and_then(Value::as_array).map(|f| f.iter().collect()).unwrap_or_default();
    let changed_files = match j.get("changedFiles").and_then(Value::as_u64) {
        Some(n) => u32::try_from(n).unwrap_or(u32::MAX),
        None => u32::try_from(files.len()).unwrap_or(u32::MAX),
    };
    let more = PrMore {
        author: login(j.get("author")),
        body: stringish(j.get("body")),
        additions: uint(j, "additions"),
        deletions: uint(j, "deletions"),
        changed_files,
        files: files.iter().take(MAX_FILES).map(|f| PrFile { path: text_or(f, "path"), additions: uint(f, "additions"), deletions: uint(f, "deletions") }).collect(),
        check_list: check_list(j.get("statusCheckRollup")),
        reviewers: reviewers_of(&reviews),
        notes: notes_of(j, &reviews),
        threads,
        updated_at: stamp(j, "updatedAt"),
    };
    PrDetail { pr: pr_summary(j, checked_at), more }
}

/// `owner/repo/number` of a PR URL, for the inline comments call.
pub fn pull_coords(url: &str) -> Option<(String, String, u64)> {
    let at = url.find("github.com/")?;
    let mut parts = url[at + "github.com/".len()..].split('/');
    let (owner, repo, pull, n) = (parts.next()?, parts.next()?, parts.next()?, parts.next()?);
    let digits: String = n.chars().take_while(char::is_ascii_digit).collect();
    (pull == "pull" && !owner.is_empty() && !repo.is_empty()).then_some(())?;
    Some((owner.to_owned(), repo.to_owned(), digits.parse().ok()?))
}

#[cfg(test)]
mod tests;
