//! One issue from each source's answer (v1 ghIssue, linearIssue, jiraIssue).

use serde_json::Value;
use wisp_issues_api::{Issue, IssueNumber};

pub const BODY_MAX: usize = 4000;

/// The first `n` characters, the last one an ellipsis when it was longer.
pub fn clip(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// CRLF (and stray CRs before a newline) as LF, trimmed and clipped.
pub fn body(s: &str) -> String {
    let lf: Vec<&str> = s.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    clip(lf.join("\n").trim(), BODY_MAX)
}

fn text(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_owned()
}

fn opt_text(v: &Value) -> Option<String> {
    v.as_str().filter(|s| !s.is_empty()).map(str::to_owned)
}

/// Labels as strings or `{name}` objects; anything else is left out.
pub fn names(list: &Value) -> Vec<String> {
    list.as_array()
        .map(|a| a.iter().filter_map(|l| l.as_str().or_else(|| l["name"].as_str())).filter(|s| !s.is_empty()).map(str::to_owned).collect())
        .unwrap_or_default()
}

fn number(v: &Value) -> IssueNumber {
    match v {
        Value::Number(n) => n.as_u64().map_or_else(|| IssueNumber::Key(n.to_string()), IssueNumber::Int),
        Value::String(s) => IssueNumber::Key(s.clone()),
        _ => IssueNumber::Key(String::new()),
    }
}

fn number_text(v: &Value) -> String {
    match v {
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        _ => String::new(),
    }
}

/// `gh issue list --json number,title,labels,assignees,url,updatedAt,body` → one issue.
pub fn gh_issue(j: &Value) -> Issue {
    let a = &j["assignees"][0];
    let assignee = a["login"].as_str().filter(|s| !s.is_empty()).or_else(|| a["name"].as_str()).unwrap_or_default().to_owned();
    let n = number_text(&j["number"]);
    Issue {
        id: n.clone(),
        reference: format!("#{n}"),
        number: number(&j["number"]),
        title: text(&j["title"]),
        url: text(&j["url"]),
        labels: names(&j["labels"]),
        assignee,
        body: body(j["body"].as_str().unwrap_or_default()),
        updated_at: opt_text(&j["updatedAt"]),
    }
}

/// A Linear issue node → one issue.
pub fn linear_issue(n: &Value) -> Issue {
    let key = opt_text(&n["identifier"]);
    let assignee = n["assignee"]["displayName"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| n["assignee"]["name"].as_str())
        .unwrap_or_default()
        .to_owned();
    Issue {
        id: key.clone().or_else(|| opt_text(&n["id"])).unwrap_or_default(),
        reference: key.clone().unwrap_or_default(),
        number: IssueNumber::Key(key.unwrap_or_default()),
        title: text(&n["title"]),
        url: text(&n["url"]),
        labels: names(&n["labels"]["nodes"]),
        assignee,
        body: body(n["description"].as_str().unwrap_or_default()),
        updated_at: opt_text(&n["updatedAt"]),
    }
}

const BLOCKS: &[&str] = &["doc", "bulletList", "orderedList", "listItem", "blockquote", "table", "tableRow"];

/// Atlassian's document format, flattened: blocks one per line, text inside a block runs on.
pub fn adf_text(n: &Value) -> String {
    match n {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        _ => {
            if let Some(t) = n["text"].as_str().filter(|t| !t.is_empty()) {
                return t.to_owned();
            }
            let sep = if n["type"].as_str().is_some_and(|t| BLOCKS.contains(&t)) { "\n" } else { "" };
            n["content"].as_array().map(|c| c.iter().map(adf_text).collect::<Vec<_>>().join(sep)).unwrap_or_default()
        }
    }
}

/// A Jira issue (REST search) on `site` → one issue. Its body isn't `\r\n`-normalised (v1).
pub fn jira_issue(site: &str, i: &Value) -> Issue {
    let key = text(&i["key"]);
    let f = &i["fields"];
    Issue {
        id: format!("jira:{key}"),
        reference: key.clone(),
        number: IssueNumber::Key(key.clone()),
        title: text(&f["summary"]),
        url: format!("{site}/browse/{key}"),
        labels: names(&f["labels"]),
        assignee: text(&f["assignee"]["displayName"]),
        body: clip(&adf_text(&f["description"]), BODY_MAX),
        updated_at: Some(text(&f["updated"])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn clip_counts_characters_and_ends_with_an_ellipsis() {
        assert_eq!(clip("abc", 3), "abc");
        assert_eq!(clip("abcd", 3), "ab…");
        assert_eq!(clip("ééééé", 4).chars().count(), 4);
    }

    #[test]
    fn a_gh_issue_with_no_assignee_and_a_long_body() {
        let i = gh_issue(
            &json!({"number": 9, "title": "Docs", "url": "u", "labels": [], "assignees": [], "updatedAt": "2026-10-28T09:00:00Z", "body": "x".repeat(5000)}),
        );
        assert_eq!(i.assignee, "");
        assert_eq!(i.body.chars().count(), 4000);
        assert!(i.body.ends_with('…'));
        assert_eq!(i.number, IssueNumber::Int(9));
    }

    #[test]
    fn labels_as_names_or_objects() {
        assert_eq!(names(&json!(["a", {"name": "b"}, 3, {"x": 1}])), vec!["a", "b"]);
    }

    #[test]
    fn adf_runs_text_on_inside_a_block() {
        let d = json!({"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "a "}, {"type": "text", "text": "b"}]}, {"type": "paragraph", "content": [{"type": "text", "text": "c"}]}]});
        assert_eq!(adf_text(&d), "a b\nc");
    }
}
