//! `gh pr view --json …` → the card's PR summary (v1 prSummary), and the check rollup classes.

use serde_json::Value;
use wisp_ship_api::{Checks, PrSummary};

/// The fields `gh pr view --json` is asked for, for the card.
pub const PR_FIELDS: &str = "number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,headRefOid,headRefName,baseRefName,mergedAt";
/// And for the PR panel.
pub const DETAIL_FIELDS: &str = "number,url,title,state,isDraft,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,headRefOid,headRefName,baseRefName,mergedAt,body,author,additions,deletions,changedFiles,files,reviews,comments,updatedAt";

const PASS: [&str; 3] = ["SUCCESS", "NEUTRAL", "SKIPPED"];
const FAIL: [&str; 7] = ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Pass,
    Fail,
    Pending,
}

/// A check's conclusion/state, upper-cased: pass, fail, or (anything else, "" included) pending.
pub fn classify(v: &str) -> Class {
    let v = v.to_ascii_uppercase();
    if PASS.contains(&v.as_str()) {
        Class::Pass
    } else if FAIL.contains(&v.as_str()) {
        Class::Fail
    } else {
        Class::Pending
    }
}

/// JS truthiness for the `a || b` chains v1 reads gh's JSON with: a non-empty string, else None.
pub(crate) fn text<'a>(j: &'a Value, key: &str) -> Option<&'a str> {
    j.get(key).and_then(Value::as_str).filter(|s| !s.is_empty())
}

pub(crate) fn text_or(j: &Value, key: &str) -> String {
    text(j, key).unwrap_or_default().to_owned()
}

/// A value as v1's `String(x || '')`: strings as they are, numbers printed, the rest "".
pub(crate) fn stringish(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Bool(true)) => "true".into(),
        _ => String::new(),
    }
}

pub(crate) fn uint(j: &Value, key: &str) -> u32 {
    j.get(key).and_then(Value::as_u64).map_or(0, |n| u32::try_from(n).unwrap_or(u32::MAX))
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(_) => true,
    }
}

/// The rollup counted: `conclusion || state` of each entry.
pub fn checks_of(rollup: Option<&Value>) -> Checks {
    let mut c = Checks::default();
    for e in rollup.and_then(Value::as_array).into_iter().flatten() {
        let v = text(e, "conclusion").or_else(|| text(e, "state")).unwrap_or_default();
        match classify(v) {
            Class::Pass => c.pass += 1,
            Class::Fail => c.fail += 1,
            Class::Pending => c.pending += 1,
        }
    }
    c
}

/// `gh pr view --json PR_FIELDS` → the summary, stamped `checked_at`.
pub fn pr_summary(j: &Value, checked_at: i64) -> PrSummary {
    let mergeable = text(j, "mergeable").unwrap_or_default();
    let merge_state = text_or(j, "mergeStateStatus");
    PrSummary {
        number: j.get("number").and_then(Value::as_u64).unwrap_or(0),
        url: text_or(j, "url"),
        title: stringish(j.get("title")),
        state: text_or(j, "state"),
        draft: truthy(j.get("isDraft")),
        review: text_or(j, "reviewDecision"),
        // both sides changed the same lines; UNKNOWN while GitHub computes is not a conflict
        conflict: mergeable == "CONFLICTING" || merge_state == "DIRTY",
        merge_state,
        head: text_or(j, "headRefOid"),
        branch: text_or(j, "headRefName"),
        base: text_or(j, "baseRefName"),
        merged_at: text(j, "mergedAt").map(str::to_owned),
        checks: checks_of(j.get("statusCheckRollup")),
        checked_at,
    }
}

/// Bots that comment on every PR (deploy previews, coverage, CI summaries): folded away, not dropped.
pub fn is_bot(login: &str, kind: Option<&str>) -> bool {
    const BOTS: [&str; 13] = [
        "github-actions",
        "vercel",
        "netlify",
        "codecov",
        "coveralls",
        "sonarcloud",
        "dependabot",
        "renovate",
        "changeset-bot",
        "linear",
        "railway-app",
        "cloudflare-pages",
        "socket-security",
    ];
    if kind == Some("Bot") || login.ends_with("[bot]") {
        return true;
    }
    let l = login.to_ascii_lowercase();
    BOTS.contains(&l.as_str())
}

/// A login as v1 read it: `a.login || a.name || ''`.
pub(crate) fn login(a: Option<&Value>) -> String {
    a.map(|a| text(a, "login").or_else(|| text(a, "name")).unwrap_or_default().to_owned()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn summary_counts_checks_and_reads_conflicts() {
        let j = json!({"number": 1, "url": "https://github.com/acme/repo/pull/1", "title": "fix", "state": "OPEN", "isDraft": false,
            "reviewDecision": "", "mergeStateStatus": "CLEAN", "headRefOid": "abc", "headRefName": "wisp/x", "baseRefName": "main", "mergedAt": null,
            "statusCheckRollup": [{"__typename": "CheckRun", "status": "IN_PROGRESS", "conclusion": ""}]});
        let pr = pr_summary(&j, 42);
        assert_eq!(pr.checks, Checks { pass: 0, fail: 0, pending: 1 });
        assert!(!pr.conflict && !pr.draft);
        assert_eq!((pr.number, pr.head.as_str(), pr.branch.as_str(), pr.checked_at), (1, "abc", "wisp/x", 42));
        assert_eq!(pr.merged_at, None);

        let green = json!({"statusCheckRollup": [{"__typename": "CheckRun", "status": "COMPLETED", "conclusion": "SUCCESS"}, {"__typename": "StatusContext", "state": "SUCCESS"}], "reviewDecision": "APPROVED"});
        let pr = pr_summary(&green, 0);
        assert_eq!(pr.checks, Checks { pass: 2, fail: 0, pending: 0 });
        assert_eq!(pr.review, "APPROVED");

        assert!(pr_summary(&json!({"mergeable": "CONFLICTING"}), 0).conflict);
        assert!(pr_summary(&json!({"mergeStateStatus": "DIRTY"}), 0).conflict);
        assert!(!pr_summary(&json!({"mergeable": "UNKNOWN", "mergeStateStatus": "UNKNOWN"}), 0).conflict);
    }

    #[test]
    fn every_conclusion_has_a_class() {
        for v in PASS {
            assert_eq!(classify(v), Class::Pass);
            assert_eq!(classify(&v.to_ascii_lowercase()), Class::Pass);
        }
        for v in FAIL {
            assert_eq!(classify(v), Class::Fail);
        }
        for v in ["", "PENDING", "QUEUED", "IN_PROGRESS", "EXPECTED", "whatever"] {
            assert_eq!(classify(v), Class::Pending);
        }
    }

    #[test]
    fn bots_by_name_or_type() {
        assert!(is_bot("dependabot[bot]", None));
        assert!(is_bot("codecov", None));
        assert!(is_bot("Vercel", None));
        assert!(is_bot("someone", Some("Bot")));
        assert!(!is_bot("lena", None));
        assert!(!is_bot("", None));
        assert!(!is_bot("vercelfan", None));
    }

    /// Property: the counts always add up to the rollup's length, whatever the entries hold.
    #[test]
    fn counts_add_up() {
        let vals = ["SUCCESS", "FAILURE", "", "NEUTRAL", "IN_PROGRESS", "STALE", "skipped", "x"];
        let mut seed: u64 = 7;
        for _ in 0..500 {
            seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
            let n = usize::try_from(seed >> 59).unwrap_or(0);
            let list: Vec<Value> = (0..n)
                .map(|i| {
                    let v = vals[(usize::try_from(seed >> 32).unwrap_or(0) + i * 3) % vals.len()];
                    if i % 2 == 0 { json!({"conclusion": v}) } else { json!({"state": v}) }
                })
                .collect();
            let c = checks_of(Some(&Value::Array(list)));
            assert_eq!((c.pass + c.fail + c.pending) as usize, n);
        }
    }
}
