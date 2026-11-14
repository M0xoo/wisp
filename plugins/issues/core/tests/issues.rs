//! v1's test/issues.test.js, case by case, on the pure half (the host tests run the same cases through
//! a fake gh, a fake origin and a fake HTTP client).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::assert_is_empty,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::many_single_char_names,
    clippy::range_plus_one,
    clippy::format_push_string,
    clippy::needless_pass_by_value,
    clippy::needless_lifetimes,
    clippy::elidable_lifetime_names,
    clippy::option_option,
    clippy::doc_markdown,
    clippy::map_unwrap_or,
    clippy::format_collect
)]

use serde_json::{Value, json};
use wisp_issues_api::{Connector, Issue, IssueList, IssueNumber, Source};
use wisp_issues_core::*;

fn gh_issues() -> Value {
    json!([
        { "number": 12, "title": "Users get logged out after a refresh", "url": "https://github.com/acme/repo/issues/12", "labels": ["bug", "auth"], "assignees": [{ "login": "lena" }], "updatedAt": "2026-11-01T09:00:00Z", "body": "It happens on every refresh.\r\n\r\nSee the logs." },
        { "number": 9, "title": "Docs for the API", "url": "https://github.com/acme/repo/issues/9", "labels": [], "assignees": [], "updatedAt": "2026-10-28T09:00:00Z", "body": "x".repeat(5000) },
    ])
}

#[test]
fn a_projects_open_github_issues_read_as_v1() {
    let list = gh_list(&gh_issues().to_string()).unwrap();
    let want = Issue {
        id: "12".into(),
        reference: "#12".into(),
        number: IssueNumber::Int(12),
        title: "Users get logged out after a refresh".into(),
        url: "https://github.com/acme/repo/issues/12".into(),
        labels: vec!["bug".into(), "auth".into()],
        assignee: "lena".into(),
        body: "It happens on every refresh.\n\nSee the logs.".into(),
        updated_at: Some("2026-11-01T09:00:00Z".into()),
    };
    assert_eq!(list[0], want);
    // the wire shape is v1's
    assert_eq!(
        serde_json::to_value(&list[0]).unwrap(),
        json!({ "id": "12", "ref": "#12", "number": 12, "title": "Users get logged out after a refresh", "url": "https://github.com/acme/repo/issues/12", "labels": ["bug", "auth"], "assignee": "lena", "body": "It happens on every refresh.\n\nSee the logs.", "updatedAt": "2026-11-01T09:00:00Z" })
    );
    assert_eq!(list[1].assignee, "");
    assert_eq!(list[1].body.chars().count(), 4000);
    assert!(list[1].body.ends_with('…'));
}

#[test]
fn the_gh_call_lists_open_issues_with_v1s_fields_and_limit() {
    let a = gh_args("acme/repo", "");
    assert_eq!(a[..6], ["issue", "list", "--repo", "acme/repo", "--state", "open"]);
    let at = |f: &str| a[a.iter().position(|x| x == f).unwrap() + 1].clone();
    assert_eq!(at("--json"), "number,title,labels,assignees,url,updatedAt,body");
    assert_eq!(at("--limit"), "50");
    assert_eq!(gh_args("acme/repo", "docs").last().unwrap(), "docs");
    assert!(!gh_args("acme/repo", "").contains(&"--search".to_owned()));
}

#[test]
fn gh_answering_junk_is_said_in_words_and_empty_is_none() {
    assert_eq!(gh_list("not json").unwrap_err(), "gh answered with something that isn’t a list of issues");
    assert_eq!(gh_list("").unwrap(), vec![]);
    assert_eq!(gh_list("{}").unwrap(), vec![]);
}

#[test]
fn each_gh_problem_says_what_fixes_it() {
    let p = gh_problem(true, "", "acme/repo");
    assert_eq!(p.fix.as_deref(), Some("install"));
    assert!(p.error.contains("isn’t installed"));
    let p = gh_problem(false, "To get started with GitHub CLI, please run:  gh auth login", "acme/repo");
    assert_eq!(p.fix.as_deref(), Some("signin"));
    assert!(p.error.contains("Sign in to GitHub"));
    assert_eq!(gh_problem(false, "HTTP 401: Bad credentials", "r").fix.as_deref(), Some("signin"));
    assert_eq!(gh_problem(false, "the repo has disabled issues", "acme/repo").error, "acme/repo has issues turned off on GitHub.");
    let p = gh_problem(false, "GraphQL: Could not resolve to a Repository with the name 'acme/nope'.", "acme/nope");
    assert_eq!((p.fix.as_deref(), p.error.as_str()), (Some("signin"), "GitHub doesn’t know acme/nope, or your account can’t see it."));
    let p = gh_problem(false, &"z".repeat(300), "r");
    assert_eq!(p.fix, None);
    assert!(p.error.starts_with("gh couldn’t list the issues: "));
    assert!(p.error.chars().count() < 240);
}

#[test]
fn the_repo_comes_from_the_project_else_its_origin() {
    assert_eq!(repo_of_project("", Some("git@github.com:acme/repo.git")).as_deref(), Some("acme/repo"));
    assert_eq!(repo_of_project("https://github.com/own/one", Some("git@github.com:acme/repo.git")).as_deref(), Some("own/one"));
    assert_eq!(repo_of_project("", None), None);
    assert_eq!(repo_of_project("", Some("/tmp/a/bare.git")), None);
    for (u, want) in [
        ("https://github.com/o/r", Some("o/r")),
        ("https://github.com/o/r.git", Some("o/r")),
        ("https://www.GitHub.com/o/r/tree/main/src", Some("o/r")),
        ("github.com/o/r", Some("o/r")),
        ("ssh://git@github.com/o/r.git", Some("o/r")),
        ("git://github.com/o/r", Some("o/r")),
        ("git@github.com:o/r.git", Some("o/r")),
        ("https://gitlab.com/o/r", None),
        ("git@gitlab.com:o/r.git", None),
        ("https://github.com/o", None),
        ("o/r", None),
        ("", None),
    ] {
        assert_eq!(github_repo(u).as_deref(), want, "{u}");
    }
}

#[test]
fn a_missing_connector_or_project_is_refused_before_any_call() {
    let l = precheck(Source::Linear, false, false, false).unwrap();
    assert_eq!((l.fix.as_deref(), l.linear), (Some("linear"), false));
    assert!(l.error.unwrap().contains("Connect Linear"));
    assert_eq!(precheck(Source::Jira, false, true, false).unwrap().fix.as_deref(), Some("jira"));
    assert_eq!(precheck(Source::Github, false, false, false).unwrap().fix.as_deref(), Some("project"));
    assert!(precheck(Source::Github, true, false, false).is_none());
    assert!(precheck(Source::Linear, false, true, false).is_none());
    let r = no_remote("", false, false);
    assert_eq!(r.fix.as_deref(), Some("remote"));
    assert_eq!(r.error.as_deref(), Some("This project has no GitHub remote, so it has no issues to list."));
}

fn linear_connector(key: &str) -> Connector {
    Connector {
        id: "c1".into(),
        name: "linear".into(),
        enabled: true,
        env: vec![("LINEAR_API_KEY".into(), key.into())],
        ..Connector::default()
    }
}

#[test]
fn linear_the_connectors_key_open_issues_and_a_title_search() {
    assert_eq!(linear_key(&[]), None);
    assert_eq!(linear_key(&[linear_connector("lin_api_good")]).as_deref(), Some("lin_api_good"));
    let off = Connector { enabled: false, ..linear_connector("k") };
    assert_eq!(linear_key(&[off]), None);
    // key-ish names first; a Bearer prefix goes
    let c = Connector {
        name: "tracker".into(),
        url: "https://mcp.linear.app/sse".into(),
        enabled: true,
        env: vec![("OTHER".into(), "x".into())],
        headers: vec![("Authorization".into(), "Bearer  tok".into())],
        ..Connector::default()
    };
    assert_eq!(linear_key(&[c]).as_deref(), Some("tok"));

    let r = linear_request("http://l/graphql", "lin_api_good", "");
    assert_eq!(r.headers[1], ("authorization".into(), "lin_api_good".into()));
    let body: Value = serde_json::from_slice(r.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["variables"]["filter"], json!({ "state": { "type": { "nin": ["completed", "canceled"] } } }));
    let r = linear_request("http://l/graphql", "oauth", "dark");
    assert_eq!(r.headers[1].1, "Bearer oauth");
    let body: Value = serde_json::from_slice(r.body.as_deref().unwrap()).unwrap();
    assert_eq!(body["variables"]["filter"]["title"], json!({ "containsIgnoreCase": "dark" }));

    let answer = json!({ "data": { "viewer": { "assignedIssues": { "nodes": [
        { "id": "u1", "identifier": "ENG-7", "title": "Login loops on Safari", "url": "https://linear.app/acme/issue/ENG-7", "description": "Steps:\n1. Open Safari", "updatedAt": "2026-11-01T10:00:00Z", "labels": { "nodes": [{ "name": "Bug" }] }, "assignee": { "name": "ada", "displayName": "Ada" } },
        { "id": "u2", "identifier": "ENG-9", "title": "Dark mode for settings", "url": "https://linear.app/acme/issue/ENG-9", "description": null, "updatedAt": "2026-10-30T10:00:00Z", "labels": { "nodes": [] }, "assignee": null },
    ] } } } });
    let issues = linear_response(200, "OK", answer.to_string().as_bytes()).unwrap();
    assert_eq!(
        serde_json::to_value(&issues[0]).unwrap(),
        json!({ "id": "ENG-7", "ref": "ENG-7", "number": "ENG-7", "title": "Login loops on Safari", "url": "https://linear.app/acme/issue/ENG-7", "labels": ["Bug"], "assignee": "Ada", "body": "Steps:\n1. Open Safari", "updatedAt": "2026-11-01T10:00:00Z" })
    );
    assert_eq!(issues[1].body, "");
}

#[test]
fn linear_refusing_the_key_says_check_it() {
    let refused = json!({ "errors": [{ "message": "Authentication required", "extensions": { "code": "AUTHENTICATION_ERROR" } }] });
    let p = linear_response(401, "Unauthorized", refused.to_string().as_bytes()).unwrap_err();
    assert_eq!(p.fix.as_deref(), Some("linear"));
    assert!(p.error.contains("refused the connector’s API key"));
    // an auth error on a 200 is still a refusal
    assert_eq!(linear_response(200, "OK", refused.to_string().as_bytes()).unwrap_err().fix.as_deref(), Some("linear"));
    let p = linear_response(500, "Server Error", b"nope").unwrap_err();
    assert_eq!((p.fix, p.error.as_str()), (None, "Linear couldn’t list your issues: Server Error"));
}

fn secrets_connector(name: &str, command: &str, args: &[&str], env: &[(&str, &str)]) -> Connector {
    Connector {
        id: "c".into(),
        name: name.into(),
        command: command.into(),
        args: args.iter().map(|s| (*s).into()).collect(),
        enabled: true,
        env: env.iter().map(|(k, v)| ((*k).into(), (*v).into())).collect(),
        ..Connector::default()
    }
}

#[test]
fn jira_the_connectors_site_email_and_token_and_your_issues_flattened() {
    assert_eq!(jira_creds(&[secrets_connector("GitHub", "", &[], &[("GITHUB_TOKEN", "t")])]), None);
    let creds = jira_creds(&[secrets_connector(
        "Jira",
        "npx",
        &["mcp-atlassian"],
        &[("JIRA_URL", "acme.atlassian.net/"), ("JIRA_EMAIL", "me@acme.dev"), ("JIRA_API_TOKEN", "tok")],
    )])
    .unwrap();
    assert_eq!(creds, JiraCreds { site: "https://acme.atlassian.net".into(), email: "me@acme.dev".into(), token: "tok".into() });
    let r = jira_request(&creds, "login \"x\"");
    assert!(r.url.starts_with("https://acme.atlassian.net/rest/api/3/search/jql?"));
    assert!(r.url.contains("jql=assignee+%3D+currentUser%28%29+AND+statusCategory+%21%3D+Done+AND+text+%7E"), "{}", r.url);
    assert_eq!(
        sources::jira_jql("login \"x\""),
        "assignee = currentUser() AND statusCategory != Done AND text ~ \"login  x \" ORDER BY updated DESC"
    );
    assert_eq!(r.headers[0].1, "Basic bWVAYWNtZS5kZXY6dG9r"); // base64("me@acme.dev:tok")
    let answer = json!({ "issues": [{ "key": "ACME-12", "fields": { "summary": "Login loops", "labels": ["bug"], "assignee": { "displayName": "Me" }, "updated": "2026-11-01", "description": { "type": "doc", "content": [{ "type": "paragraph", "content": [{ "type": "text", "text": "Users get " }, { "type": "text", "text": "logged out" }] }] } } }] });
    let issues = jira_response(&creds.site, 200, "OK", answer.to_string().as_bytes()).unwrap();
    assert_eq!(
        serde_json::to_value(&issues[0]).unwrap(),
        json!({ "id": "jira:ACME-12", "ref": "ACME-12", "number": "ACME-12", "title": "Login loops", "url": "https://acme.atlassian.net/browse/ACME-12", "labels": ["bug"], "assignee": "Me", "body": "Users get logged out", "updatedAt": "2026-11-01" })
    );
    assert_eq!(jira_response(&creds.site, 401, "", b"{}").unwrap_err().fix.as_deref(), Some("jira"));
}

fn list(n: usize) -> IssueList {
    IssueList {
        source: Source::Github,
        issues: gh_list(&gh_issues().to_string()).unwrap().into_iter().take(n).collect(),
        ..IssueList::default()
    }
}

#[test]
fn a_list_is_kept_for_a_minute_a_problem_never() {
    let mut c = IssueCache::default();
    let k = cache_key(Source::Github, "p1", "docs");
    c.put(k.clone(), 1_000, list(1));
    assert_eq!(c.get(&k, 1_000 + 59_999, false, false).unwrap().issues.len(), 1);
    assert!(c.get(&k, 1_000 + 60_000, false, false).is_none());
    // the connected sources are as they are now, not as they were
    assert!(c.get(&k, 2_000, true, false).unwrap().linear);
    let bad = IssueList { error: Some("Sign in".into()), ..IssueList::default() };
    c.put("x".into(), 0, bad);
    assert!(c.get("x", 0, false, false).is_none());
    assert_eq!(cache_key(Source::Linear, "p1", "q"), "linear::q");
}

#[test]
fn search_words_are_trimmed_and_capped() {
    assert_eq!(normalize_q("  docs  "), "docs");
    assert_eq!(normalize_q(&"é".repeat(300)).chars().count(), 200);
}

/// A tiny seeded PRNG: property tests without a dependency.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

#[test]
fn property_the_cache_never_holds_more_than_its_cap_and_keeps_the_newest() {
    let mut r = Rng(0x9e37_79b9_7f4a_7c15);
    for _ in 0..20 {
        let mut c = IssueCache::default();
        let n = 150 + r.below(300) as usize;
        for i in 0..n {
            c.put(format!("k{i}"), 0, list(0));
            assert!(c.len() <= CACHE_MAX);
        }
        assert_eq!(c.len(), n.min(CACHE_MAX));
        assert!(c.get(&format!("k{}", n - 1), 0, false, false).is_some());
        if n > CACHE_MAX {
            assert!(c.get("k0", 0, false, false).is_none());
        }
    }
}

#[test]
fn property_clip_never_exceeds_and_keeps_short_text() {
    let mut r = Rng(42);
    let alphabet: Vec<char> = "ab é😀\r\n".chars().collect();
    for _ in 0..500 {
        let len = r.below(60) as usize;
        let s: String = (0..len).map(|_| alphabet[r.below(alphabet.len() as u64) as usize]).collect();
        let n = 1 + r.below(40) as usize;
        let c = clip(&s, n);
        assert!(c.chars().count() <= n);
        if s.chars().count() <= n {
            assert_eq!(c, s);
        } else {
            assert!(c.ends_with('…'));
        }
        let b = body(&s);
        assert!(!b.contains("\r\n"));
    }
}

#[test]
fn property_github_repo_finds_owner_and_repo_in_every_spelling() {
    let mut r = Rng(7);
    let word = |r: &mut Rng| -> String { (0..1 + r.below(8)).map(|_| char::from(b'a' + r.below(26) as u8)).collect() };
    for _ in 0..300 {
        let (o, n) = (word(&mut r), word(&mut r));
        let suffix = if r.below(2) == 0 { ".git" } else { "" };
        let forms = [
            format!("https://github.com/{o}/{n}{suffix}"),
            format!("git@github.com:{o}/{n}{suffix}"),
            format!("ssh://git@github.com/{o}/{n}{suffix}"),
            format!("github.com/{o}/{n}"),
        ];
        for f in forms {
            assert_eq!(github_repo(&f), Some(format!("{o}/{n}")), "{f}");
        }
        assert_eq!(github_repo(&format!("https://example.com/{o}/{n}")), None);
    }
}
