//! v1 #766, test/issue-signin.test.js: a connector signed in with the browser lists its issues through its own
//! server's tools (Linear `list_issues`, Atlassian's site then `searchJiraIssuesUsingJql`), the tools played
//! here by a stand-in for `connectors.call`.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::needless_pass_by_value)]

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_issues::{Deps, FixedConnectors, Lister, Origin, Tools};
use wisp_issues_api::{Connector, ListArgs, Source};
use wisp_kernel::{BoxFuture, Call, Caller};
use wisp_proc::sim::SimProc;

struct NoOrigin;
impl Origin for NoOrigin {
    fn origin(&self, _call: &Call, _dir: &str) -> BoxFuture<'static, Option<String>> {
        Box::pin(async { None })
    }
}

type Answer = Arc<dyn Fn(&str, &Value) -> Result<Value, String> + Send + Sync>;
type Calls = Arc<Mutex<Vec<(String, String, Value)>>>;

/// The server's tools: every call kept, answered by `answer`.
struct FakeTools {
    calls: Calls,
    answer: Answer,
}

impl Tools for FakeTools {
    fn call(&self, _call: &Call, connector: &str, tool: &str, args: Value) -> BoxFuture<'static, Result<Value, String>> {
        self.calls.lock().unwrap().push((connector.to_owned(), tool.to_owned(), args.clone()));
        let out = (self.answer)(tool, &args);
        Box::pin(async move { out })
    }
}

fn text(v: Value) -> Value {
    json!({ "content": [{ "type": "text", "text": v.to_string() }] })
}

fn signed_in(name: &str, url: &str, signed: bool) -> Connector {
    Connector { id: format!("c-{name}"), name: name.into(), url: url.into(), enabled: true, signed_in: signed, ..Connector::default() }
}

fn lister(connectors: Vec<Connector>, answer: Answer) -> (Lister, Calls) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let tools = FakeTools { calls: calls.clone(), answer };
    let deps = Deps {
        proc: Arc::new(SimProc::new()),
        gh: "gh".into(),
        origin: Arc::new(NoOrigin),
        http: None,
        projects: None,
        connectors: Some(Arc::new(FixedConnectors(connectors))),
        tools: Some(Arc::new(tools)),
        linear_api: "http://linear.test/graphql".into(),
        now: Arc::new(|| 0),
    };
    (Lister::new(deps), calls)
}

fn call() -> Call {
    Call::new_root(Caller::user())
}

fn args(source: Source, q: &str) -> ListArgs {
    ListArgs { source, project: None, q: q.into() }
}

#[tokio::test]
async fn linear_a_signed_in_connector_lists_your_open_issues_through_its_list_issues_tool() {
    let answer: Answer = Arc::new(|_, _| {
        Ok(text(json!({ "issues": [
            { "id": "u1", "identifier": "ENG-7", "title": "Dark mode flickers", "url": "https://linear.app/acme/issue/ENG-7", "labels": ["bug"], "assignee": "Me", "status": "In Progress", "updatedAt": "2026-11-02", "description": "On reload." },
            { "id": "u2", "identifier": "ENG-3", "title": "Old one", "url": "https://linear.app/acme/issue/ENG-3", "status": "Done", "updatedAt": "2026-10-01" }
        ] })))
    });
    let (l, calls) = lister(vec![signed_in("linear", "https://mcp.linear.app/mcp", true)], answer);
    let r = l.list(&call(), args(Source::Linear, "dark")).await.unwrap();
    assert_eq!(r.error, None);
    assert!(r.linear);
    let c = calls.lock().unwrap().clone();
    assert_eq!(c.len(), 1);
    assert_eq!((c[0].0.as_str(), c[0].1.as_str(), &c[0].2["assignee"], &c[0].2["query"]), ("c-linear", "list_issues", &json!("me"), &json!("dark")));
    assert_eq!(r.scope.as_deref(), Some("mine"));
    let v = serde_json::to_value(&r.issues).unwrap();
    assert_eq!(v, json!([{ "id": "u1", "ref": "ENG-7", "number": "ENG-7", "title": "Dark mode flickers", "url": "https://linear.app/acme/issue/ENG-7", "labels": ["bug"], "assignee": "Me", "body": "On reload.", "updatedAt": "2026-11-02" }]));
    assert!(l.list(&call(), args(Source::Jira, "")).await.unwrap().linear, "the other sources know Linear is there");
}

#[tokio::test]
async fn linear_none_assigned_to_you_lists_the_workspaces_open_issues_instead() {
    let answer: Answer = Arc::new(|_, a| {
        if a["assignee"] == json!("me") {
            return Ok(text(json!({ "issues": [], "hasNextPage": false })));
        }
        Ok(text(json!({ "issues": [
            { "id": "TRY-16", "title": "Task usage of tokens", "url": "https://linear.app/t/issue/TRY-16", "labels": [], "assignee": null, "status": "Todo", "statusType": "unstarted", "updatedAt": "2026-11-10T00:53:36Z", "description": "* include subagents" },
            { "id": "TRY-2", "title": "Shipped", "url": "https://linear.app/t/issue/TRY-2", "labels": [], "assignee": null, "status": "Shipped", "statusType": "completed", "updatedAt": "2026-11-01" },
            { "id": "TRY-3", "title": "Dropped", "url": "https://linear.app/t/issue/TRY-3", "labels": [], "assignee": null, "status": "Nope", "statusType": "canceled", "updatedAt": "2026-11-01" }
        ], "hasNextPage": false })))
    });
    let (l, calls) = lister(vec![signed_in("linear", "https://mcp.linear.app/mcp", true)], answer);
    let r = l.list(&call(), args(Source::Linear, "")).await.unwrap();
    assert_eq!((r.error.as_deref(), r.scope.as_deref()), (None, Some("all")));
    let c = calls.lock().unwrap().clone();
    assert_eq!(c.iter().map(|x| x.2["assignee"].clone()).collect::<Vec<_>>(), [json!("me"), Value::Null]);
    assert!(c.iter().all(|x| { let f = x.2["fields"].to_string(); f.contains("statusType") && f.contains("description") }), "asks for the fields it reads");
    let v = serde_json::to_value(&r.issues).unwrap();
    assert_eq!(v, json!([{ "id": "TRY-16", "ref": "TRY-16", "number": "TRY-16", "title": "Task usage of tokens", "url": "https://linear.app/t/issue/TRY-16", "labels": [], "assignee": "", "body": "* include subagents", "updatedAt": "2026-11-10T00:53:36Z" }]));
}

#[tokio::test]
async fn linear_not_signed_in_says_to_sign_in_and_so_does_a_refusal_from_the_server() {
    let never: Answer = Arc::new(|_, _| panic!("not signed in: no tool is called"));
    let (l, _) = lister(vec![signed_in("linear", "https://mcp.linear.app/mcp", false)], never);
    let none = l.list(&call(), args(Source::Linear, "")).await.unwrap();
    assert_eq!(none.fix.as_deref(), Some("linear"));
    assert!(none.error.unwrap().contains("sign in"));
    let refuse: Answer = Arc::new(|_, _| Err("needs sign-in (HTTP 401)".into()));
    let (l, _) = lister(vec![signed_in("linear", "https://mcp.linear.app/mcp", true)], refuse);
    let refused = l.list(&call(), args(Source::Linear, "")).await.unwrap();
    assert_eq!(refused.fix.as_deref(), Some("linear"));
    assert!(refused.error.unwrap().contains("sign in again"));
}

#[tokio::test]
async fn jira_a_signed_in_atlassian_connector_finds_your_site_then_searches_your_issues() {
    let answer: Answer = Arc::new(|tool, _| {
        if tool == "getAccessibleAtlassianResources" {
            return Ok(text(json!([{ "id": "cloud-1", "url": "https://acme.atlassian.net", "name": "acme", "scopes": ["read:jira-work"] }])));
        }
        Ok(text(json!({ "issues": [{ "key": "ACME-4", "fields": { "summary": "Login loops", "labels": [], "assignee": { "displayName": "Me" }, "updated": "2026-11-03", "description": "Plain text here" } }] })))
    });
    let (l, calls) = lister(vec![signed_in("atlassian", "https://mcp.atlassian.com/v1/mcp", true)], answer);
    let r = l.list(&call(), args(Source::Jira, "login")).await.unwrap();
    assert_eq!(r.error, None);
    assert!(r.jira);
    let c = calls.lock().unwrap().clone();
    assert_eq!(c.iter().map(|x| x.1.as_str()).collect::<Vec<_>>(), ["getAccessibleAtlassianResources", "searchJiraIssuesUsingJql"]);
    assert_eq!(c[1].2["cloudId"], "cloud-1");
    assert!(c[1].2["jql"].as_str().unwrap().starts_with("assignee = currentUser() AND statusCategory != Done AND text ~ \"login\""));
    let v = serde_json::to_value(&r.issues).unwrap();
    assert_eq!(v, json!([{ "id": "jira:ACME-4", "ref": "ACME-4", "number": "ACME-4", "title": "Login loops", "url": "https://acme.atlassian.net/browse/ACME-4", "labels": [], "assignee": "Me", "body": "Plain text here", "updatedAt": "2026-11-03" }]));
}
