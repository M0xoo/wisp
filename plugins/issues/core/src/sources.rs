//! Each source as requests to make and answers to read: gh's argv and its failures in words, Linear's
//! GraphQL, Jira's REST search, and which connector holds which credentials (v1 server/issues.js).

use base64::Engine as _;
use serde_json::{Value, json};
use std::fmt::Write as _;
use wisp_issues_api::{Connector, HttpRequest, Issue, Problem};

use crate::rows::{clip, gh_issue, jira_issue, linear_issue};

pub const LIMIT: usize = 50;
pub const GH_FIELDS: &str = "number,title,labels,assignees,url,updatedAt,body";
pub const LINEAR_API: &str = "https://api.linear.app/graphql";

/// `gh issue list` for `repo`'s open issues, `q` as a search when there is one.
pub fn gh_args(repo: &str, q: &str) -> Vec<String> {
    let mut a: Vec<String> = [
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--limit",
        &LIMIT.to_string(),
        "--json",
        GH_FIELDS,
    ]
    .iter()
    .map(|s| (*s).to_owned())
    .collect();
    if !q.is_empty() {
        a.push("--search".into());
        a.push(q.into());
    }
    a
}

/// gh's stdout as issues, or the words for an answer that isn't a list.
pub fn gh_list(stdout: &str) -> Result<Vec<Issue>, String> {
    let raw = if stdout.trim().is_empty() {
        "[]"
    } else {
        stdout
    };
    let v: Value = serde_json::from_str(raw)
        .map_err(|_| "gh answered with something that isn’t a list of issues".to_owned())?;
    Ok(v.as_array()
        .map(|a| a.iter().map(gh_issue).collect())
        .unwrap_or_default())
}

fn problem(error: String, fix: Option<&str>) -> Problem {
    Problem {
        error,
        fix: fix.map(str::to_owned),
    }
}

fn has_any(hay: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| hay.contains(n))
}

/// gh's failure in words with what fixes it. `missing`: gh isn't installed (ENOENT).
pub fn gh_problem(missing: bool, why: &str, repo: &str) -> Problem {
    if missing {
        return problem(
            "The GitHub CLI (gh) isn’t installed, so wisp can’t list this project’s issues.".into(),
            Some("install"),
        );
    }
    let w = why.to_lowercase();
    if has_any(
        &w,
        &[
            "not logged in",
            "gh auth login",
            "authenticat",
            "bad credentials",
            "http 401",
        ],
    ) {
        return problem(
            "Sign in to GitHub to list this project’s issues.".into(),
            Some("signin"),
        );
    }
    if w.contains("disabled issues") {
        return problem(format!("{repo} has issues turned off on GitHub."), None);
    }
    if has_any(
        &w,
        &["could not resolve to a repository", "http 404", "not found"],
    ) {
        return problem(
            format!("GitHub doesn’t know {repo}, or your account can’t see it."),
            Some("signin"),
        );
    }
    problem(
        format!("gh couldn’t list the issues: {}", clip(why, 200)),
        None,
    )
}

fn haystack(c: &Connector) -> String {
    let mut parts = vec![c.name.as_str(), c.url.as_str(), c.command.as_str()];
    parts.extend(c.args.iter().map(String::as_str));
    parts.join(" ").to_lowercase()
}

fn is_keyish(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("key") || n.contains("token") || n.contains("authorization")
}

/// A Linear connector's API key: an env var or header of a connector named or pointing at Linear,
/// key-ish names first. Its OAuth sign-in is for Linear's MCP server, not this API, so it doesn't count.
pub fn linear_key(connectors: &[Connector]) -> Option<String> {
    for c in connectors
        .iter()
        .filter(|c| c.enabled && haystack(c).contains("linear"))
    {
        let mut keys: Vec<(&String, &String)> = c
            .env
            .iter()
            .chain(c.headers.iter())
            .map(|(k, v)| (k, v))
            .collect();
        keys.sort_by_key(|(k, _)| !is_keyish(k)); // stable: key-ish first, then as listed
        for (_, v) in keys {
            let v = strip_bearer(v.trim()).trim();
            if !v.is_empty() {
                return Some(v.to_owned());
            }
        }
    }
    None
}

/// `Bearer <token>` (any case, any spaces) → the token.
fn strip_bearer(v: &str) -> &str {
    match v.get(..6) {
        Some(b) if b.eq_ignore_ascii_case("bearer") && v[6..].starts_with(char::is_whitespace) => {
            v[6..].trim_start()
        }
        _ => v,
    }
}

/// Linear's assigned-issues query, open ones only, `q` matching the title.
pub fn linear_request(api: &str, key: &str, q: &str) -> HttpRequest {
    let mut filter = json!({"state": {"type": {"nin": ["completed", "canceled"]}}});
    if !q.is_empty() {
        filter["title"] = json!({"containsIgnoreCase": q});
    }
    let query = format!(
        "query Issues($filter: IssueFilter) {{\n  viewer {{ assignedIssues(first: {LIMIT}, orderBy: updatedAt, filter: $filter) {{\n    nodes {{ id identifier title url description updatedAt labels {{ nodes {{ name }} }} assignee {{ name displayName }} }}\n  }} }}\n}}"
    );
    // A personal API key goes as it is; an OAuth token as a Bearer.
    let auth = if key.starts_with("lin_api_") {
        key.to_owned()
    } else {
        format!("Bearer {key}")
    };
    HttpRequest {
        method: "POST".into(),
        url: api.to_owned(),
        headers: vec![
            ("content-type".into(), "application/json".into()),
            ("authorization".into(), auth),
        ],
        body: Some(
            json!({"query": query, "variables": {"filter": filter}})
                .to_string()
                .into_bytes(),
        ),
        timeout_ms: 20_000,
    }
}

fn first_error(j: &Value) -> Option<&Value> {
    j["errors"].as_array().and_then(|e| e.first())
}

/// Linear's answer: the issues, or what went wrong with its fix.
pub fn linear_response(status: u16, status_text: &str, body: &[u8]) -> Result<Vec<Issue>, Problem> {
    let j: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let auth_err = j["errors"].as_array().is_some_and(|es| {
        es.iter().any(|e| {
            e["extensions"]["code"]
                .as_str()
                .or(e["message"].as_str())
                .is_some_and(|s| s.to_lowercase().contains("auth"))
        })
    });
    if status == 401 || status == 403 || auth_err {
        return Err(problem(
            "Linear refused the connector’s API key. Check it in Settings → Connectors.".into(),
            Some("linear"),
        ));
    }
    if !(200..300).contains(&status) || first_error(&j).is_some() {
        let why = first_error(&j)
            .and_then(|e| e["message"].as_str())
            .unwrap_or(status_text);
        return Err(problem(
            format!("Linear couldn’t list your issues: {}", clip(why, 200)),
            None,
        ));
    }
    Ok(j["data"]["viewer"]["assignedIssues"]["nodes"]
        .as_array()
        .map(|a| a.iter().map(linear_issue).collect())
        .unwrap_or_default())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JiraCreds {
    pub site: String,
    pub email: String,
    pub token: String,
}

fn env_of(c: &Connector, ok: impl Fn(&str) -> bool) -> &str {
    c.env
        .iter()
        .find(|(k, _)| ok(&k.to_uppercase()))
        .map_or("", |(_, v)| v.trim())
}

/// A Jira (Atlassian) connector's site, email and API token, by the env names the Atlassian MCP servers use.
pub fn jira_creds(connectors: &[Connector]) -> Option<JiraCreds> {
    for c in connectors.iter().filter(|c| {
        c.enabled && (haystack(c).contains("jira") || haystack(c).contains("atlassian"))
    }) {
        let site = env_of(c, |k| {
            matches!(
                k,
                "JIRA_URL" | "JIRA_BASE_URL" | "JIRA_SITE" | "ATLASSIAN_SITE" | "ATLASSIAN_URL"
            )
        });
        let email = env_of(c, |k| {
            matches!(
                k,
                "JIRA_EMAIL"
                    | "JIRA_USER"
                    | "JIRA_USERNAME"
                    | "ATLASSIAN_EMAIL"
                    | "ATLASSIAN_USER"
                    | "ATLASSIAN_USERNAME"
            )
        });
        let token = env_of(c, |k| matches!(k, "JIRA_API_TOKEN" | "ATLASSIAN_API_TOKEN"));
        if !site.is_empty() && !email.is_empty() && !token.is_empty() {
            let site = if site.starts_with("http:") || site.starts_with("https:") {
                site.to_owned()
            } else {
                format!("https://{site}")
            };
            return Some(JiraCreds {
                site: site.trim_end_matches('/').to_owned(),
                email: email.into(),
                token: token.into(),
            });
        }
    }
    None
}

/// `application/x-www-form-urlencoded`, as `URLSearchParams` writes it.
pub fn form_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => {
                out.push(char::from(b));
            }
            b' ' => out.push('+'),
            _ => {
                let _ = write!(out, "%{b:02X}");
            }
        }
    }
    out
}

/// The JQL for your open issues, newest first; quotes and backslashes in `q` become spaces.
pub fn jira_jql(q: &str) -> String {
    let text = if q.is_empty() {
        String::new()
    } else {
        format!(" AND text ~ \"{}\"", q.replace(['"', '\\'], " "))
    };
    format!("assignee = currentUser() AND statusCategory != Done{text} ORDER BY updated DESC")
}

pub fn jira_request(c: &JiraCreds, q: &str) -> HttpRequest {
    let params = [
        ("jql", jira_jql(q)),
        ("maxResults", LIMIT.to_string()),
        (
            "fields",
            "summary,labels,assignee,description,updated".into(),
        ),
    ];
    let qs: Vec<String> = params
        .iter()
        .map(|(k, v)| format!("{k}={}", form_encode(v)))
        .collect();
    let basic =
        base64::engine::general_purpose::STANDARD.encode(format!("{}:{}", c.email, c.token));
    HttpRequest {
        method: "GET".into(),
        url: format!("{}/rest/api/3/search/jql?{}", c.site, qs.join("&")),
        headers: vec![
            ("authorization".into(), format!("Basic {basic}")),
            ("accept".into(), "application/json".into()),
        ],
        body: None,
        timeout_ms: 20_000,
    }
}

pub fn jira_response(
    site: &str,
    status: u16,
    status_text: &str,
    body: &[u8],
) -> Result<Vec<Issue>, Problem> {
    let j: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    if status == 401 || status == 403 {
        return Err(problem("Jira refused the connector’s email and API token. Check them in Settings → Connectors.".into(), Some("jira")));
    }
    if !(200..300).contains(&status) {
        let why = j["errorMessages"][0].as_str().unwrap_or(status_text);
        return Err(problem(
            format!("Jira couldn’t list your issues: {}", clip(why, 200)),
            None,
        ));
    }
    Ok(j["issues"]
        .as_array()
        .map(|a| a.iter().map(|i| jira_issue(site, i)).collect())
        .unwrap_or_default())
}
