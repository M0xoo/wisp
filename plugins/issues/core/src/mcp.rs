//! A signed-in connector's own tools (v1 #766, issues.js `signedInConnector`, `linearMcpIssues`,
//! `jiraMcpIssues`): a Linear or Atlassian server signed in with the browser holds a token for that server
//! only, so its issues come through its tools (Linear `list_issues`, Atlassian
//! `getAccessibleAtlassianResources` then `searchJiraIssuesUsingJql`). Sans-IO: the host calls the tools
//! (`connectors.call`); these build the arguments and read the answers.

use serde_json::{Value, json};
use wisp_issues_api::{Connector, Issue, IssueNumber, Problem, Source};

use crate::rows::{body, clip, names};
use crate::sources::{LIMIT, jira_jql};

fn is_for(source: Source, c: &Connector) -> bool {
    let hay = format!("{} {} {}", c.id, c.name, c.url).to_lowercase();
    match source {
        Source::Linear => hay.contains("linear"),
        Source::Jira => hay.contains("jira") || hay.contains("atlassian"),
        Source::Github => false,
    }
}

/// An enabled remote connector for that source, signed in with the browser.
pub fn signed_in_connector(source: Source, connectors: &[Connector]) -> Option<&Connector> {
    connectors.iter().find(|c| c.enabled && !c.url.is_empty() && c.signed_in && is_for(source, c))
}

/// A tool's answer: its structured content, else the JSON in its text, else the text itself.
pub fn tool_json(r: &Value) -> Value {
    if let Some(s) = r.get("structuredContent").filter(|s| !s.is_null()) {
        return s.clone();
    }
    let t: Vec<&str> = r.get("content").and_then(Value::as_array).into_iter().flatten().filter(|x| x.get("type").and_then(Value::as_str) == Some("text")).filter_map(|x| x.get("text").and_then(Value::as_str)).collect();
    let t = t.join("\n");
    serde_json::from_str(t.trim()).unwrap_or(Value::String(t.trim().to_owned()))
}

fn list_of<'a>(v: &'a Value, keys: &[&str]) -> Vec<&'a Value> {
    if let Some(a) = v.as_array() {
        return a.iter().collect();
    }
    keys.iter().find_map(|k| v.get(*k).and_then(Value::as_array)).map(|a| a.iter().collect()).unwrap_or_default()
}

fn name_of(v: &Value) -> String {
    v.as_str().map(str::to_owned).or_else(|| v.get("displayName").or_else(|| v.get("name")).and_then(Value::as_str).map(str::to_owned)).unwrap_or_default()
}

fn closed(state: &str) -> bool {
    matches!(state.to_lowercase().as_str(), "done" | "completed" | "canceled" | "cancelled" | "duplicate")
}

/// One of Linear's `list_issues` items; `None` for one that's closed.
pub fn linear_mcp_issue(n: &Value) -> Option<Issue> {
    let state = name_of(n.get("status").or_else(|| n.get("state")).unwrap_or(&Value::Null));
    let kind = n.get("statusType").and_then(Value::as_str).unwrap_or_default().to_lowercase();
    if kind == "completed" || kind == "canceled" || closed(&state) || n.get("completedAt").is_some_and(|v| !v.is_null()) || n.get("canceledAt").is_some_and(|v| !v.is_null()) {
        return None;
    }
    let s = |k: &str| n.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    let key = n.get("identifier").and_then(Value::as_str).map_or_else(|| s("id"), str::to_owned);
    let labels = n.get("labels").map(|l| if l.is_array() { names(l) } else { names(&l["nodes"]) }).unwrap_or_default();
    Some(Issue { id: n.get("id").and_then(Value::as_str).map_or_else(|| key.clone(), str::to_owned), reference: key.clone(), number: IssueNumber::Key(key), title: s("title"), url: s("url"), labels, assignee: name_of(n.get("assignee").unwrap_or(&Value::Null)), body: body(&s("description")), updated_at: n.get("updatedAt").and_then(Value::as_str).map(str::to_owned) })
}

const LINEAR_FIELDS: [&str; 9] = ["id", "title", "url", "labels", "assignee", "status", "statusType", "updatedAt", "description"];

/// `list_issues`' arguments: yours (`assignee: "me"`) or, with `None`, the workspace's. Twice the limit,
/// since closed ones come back too and are dropped.
pub fn linear_args(assignee: Option<&str>, q: &str) -> Value {
    let mut a = json!({ "limit": LIMIT * 2, "orderBy": "updatedAt", "fields": LINEAR_FIELDS });
    if let Some(who) = assignee {
        a["assignee"] = json!(who);
    }
    if !q.is_empty() {
        a["query"] = json!(q);
    }
    a
}

/// The open issues in a `list_issues` answer.
pub fn linear_list(result: &Value) -> Vec<Issue> {
    let v = tool_json(result);
    list_of(&v, &["issues", "nodes"]).into_iter().filter_map(linear_mcp_issue).take(LIMIT).collect()
}

/// The Jira site to search: the first of `getAccessibleAtlassianResources` with a Jira scope, else the first.
/// → (cloud id, its URL without a trailing slash).
pub fn jira_site(result: &Value) -> Option<(String, String)> {
    let v = tool_json(result);
    let sites = list_of(&v, &["resources"]);
    let jira = |s: &&&Value| s.get("scopes").and_then(Value::as_array).is_some_and(|a| a.iter().filter_map(Value::as_str).any(|x| x.contains("jira")));
    let site = sites.iter().find(jira).or_else(|| sites.first())?;
    let id = site.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    Some((id.to_owned(), site.get("url").and_then(Value::as_str).unwrap_or_default().trim_end_matches('/').to_owned()))
}

/// `searchJiraIssuesUsingJql`'s arguments: the issues assigned to you that aren't done.
pub fn jira_args(cloud_id: &str, q: &str) -> Value {
    json!({ "cloudId": cloud_id, "jql": jira_jql(q), "maxResults": LIMIT, "fields": ["summary", "labels", "assignee", "description", "updated"] })
}

/// The issues in a search answer, linked to the site.
pub fn jira_list(site: &str, result: &Value) -> Vec<Issue> {
    let v = tool_json(result);
    list_of(&v, &["issues"]).into_iter().map(|i| crate::rows::jira_issue(site, i)).collect()
}

/// A tool call that failed, in the picker's words: a sign-in gone stale says so, with Connectors as its fix.
pub fn mcp_problem(source: Source, error: &str) -> Problem {
    let label = if source == Source::Jira { "Jira" } else { "Linear" };
    let low = error.to_lowercase();
    if ["sign-in", "sign in", "http 401", "http 403", "unauthorized", "unauthorised"].iter().any(|w| low.contains(w)) {
        return Problem { error: format!("{label} wants you to sign in again: Settings → Connectors."), fix: Some(source.as_str().into()) };
    }
    Problem { error: format!("{label} couldn’t list your issues: {}", clip(error, 200)), fix: None }
}

pub const NO_JIRA_SITE: &str = "Your Atlassian account has no Jira site to list issues from.";
