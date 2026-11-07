//! v1's test/issues.test.js through `GET /issues`: a fake gh (wisp_proc's SimProc), a fake origin, a
//! stand-in for Linear's GraphQL API. The list, search, the minute's cache, and each problem with its fix.

use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_issues::{Deps, FixedConnectors, Lister, Origin, get_issues, why_of};
use wisp_issues_api::{Connector, Http, HttpRequest, HttpResponse, ProjectRef, Projects};
use wisp_kernel::http::{Request, Response};
use wisp_kernel::{BoxFuture, Call, Caller, Result};
use wisp_proc::Exit;
use wisp_proc::sim::SimProc;

/// gh's answer, changed between calls like v1's FAKE_GH_STATE.
#[derive(Clone, Default)]
struct GhState(Arc<Mutex<Value>>);

fn fake_gh(state: GhState) -> SimProc {
    SimProc::new().program("gh", move |io| {
        let st = state.0.lock().unwrap().clone();
        async move {
            if st["signedOut"] == true {
                io.eprint(b"To get started with GitHub CLI, please run:  gh auth login\n")
                    .await;
                return Exit {
                    code: Some(4),
                    signal: None,
                };
            }
            let q = io
                .args
                .iter()
                .position(|a| a == "--search")
                .map(|i| io.args[i + 1].to_lowercase());
            let out = match &st["issues"] {
                Value::String(s) => s.clone(),
                Value::Array(list) => Value::Array(
                    list.iter()
                        .filter(|i| {
                            q.as_ref().is_none_or(|q| {
                                i["title"].as_str().unwrap().to_lowercase().contains(q)
                            })
                        })
                        .cloned()
                        .collect(),
                )
                .to_string(),
                _ => "[]".into(),
            };
            io.print(out.as_bytes()).await;
            Exit {
                code: Some(0),
                signal: None,
            }
        }
    })
}

struct FakeOrigin;
impl Origin for FakeOrigin {
    fn origin(&self, _call: &Call, dir: &str) -> BoxFuture<'static, Option<String>> {
        let url = (dir == "/repo").then(|| "git@github.com:acme/repo.git".to_owned());
        Box::pin(async move { url })
    }
}

struct FakeProjects;
impl Projects for FakeProjects {
    fn project(&self, _call: &Call, id: &str) -> BoxFuture<'static, Result<Option<ProjectRef>>> {
        let p = match id {
            "p1" => Some(ProjectRef {
                id: "p1".into(),
                name: "repo".into(),
                repo: String::new(),
                dir: Some("/repo".into()),
            }),
            "bare" => Some(ProjectRef {
                id: "bare".into(),
                name: String::new(),
                repo: String::new(),
                dir: Some("/bare".into()),
            }),
            _ => None,
        };
        Box::pin(async move { Ok(p) })
    }
}

/// Linear: the viewer's assigned issues, refusing any key but the right one.
#[derive(Default)]
struct FakeLinear(Mutex<Vec<(String, Value)>>);
impl Http for FakeLinear {
    fn send(
        &self,
        req: HttpRequest,
    ) -> BoxFuture<'static, std::result::Result<HttpResponse, String>> {
        let body: Value = serde_json::from_slice(req.body.as_deref().unwrap_or(b"{}")).unwrap();
        let auth = req
            .headers
            .iter()
            .find(|(k, _)| k == "authorization")
            .map(|(_, v)| v.clone())
            .unwrap_or_default();
        self.0.lock().unwrap().push((auth.clone(), body.clone()));
        let reply = if auth == "lin_api_good" {
            let nodes = json!([
                { "id": "u1", "identifier": "ENG-7", "title": "Login loops on Safari", "url": "https://linear.app/acme/issue/ENG-7", "description": "Steps:\n1. Open Safari", "updatedAt": "2026-11-01T10:00:00Z", "labels": { "nodes": [{ "name": "Bug" }] }, "assignee": { "name": "ada", "displayName": "Ada" } },
                { "id": "u2", "identifier": "ENG-9", "title": "Dark mode for settings", "url": "https://linear.app/acme/issue/ENG-9", "description": null, "updatedAt": "2026-10-30T10:00:00Z", "labels": { "nodes": [] }, "assignee": null },
            ]);
            let q = body["variables"]["filter"]["title"]["containsIgnoreCase"]
                .as_str()
                .map(str::to_lowercase);
            let nodes: Vec<Value> = nodes
                .as_array()
                .unwrap()
                .iter()
                .filter(|n| {
                    q.as_ref()
                        .is_none_or(|q| n["title"].as_str().unwrap().to_lowercase().contains(q))
                })
                .cloned()
                .collect();
            HttpResponse {
                status: 200,
                status_text: "OK".into(),
                body: json!({ "data": { "viewer": { "assignedIssues": { "nodes": nodes } } } })
                    .to_string()
                    .into_bytes(),
            }
        } else {
            HttpResponse { status: 401, status_text: "Unauthorized".into(), body: json!({ "errors": [{ "message": "Authentication required", "extensions": { "code": "AUTHENTICATION_ERROR" } }] }).to_string().into_bytes() }
        };
        Box::pin(async move { Ok(reply) })
    }
}

struct World {
    lister: Lister,
    gh: GhState,
    sim: SimProc,
    linear: Arc<FakeLinear>,
    clock: Arc<AtomicI64>,
}

fn world(connectors: Vec<Connector>, gh_bin: &str) -> World {
    let gh = GhState::default();
    let sim = fake_gh(gh.clone());
    let linear = Arc::new(FakeLinear::default());
    let clock = Arc::new(AtomicI64::new(1_000_000));
    let c = clock.clone();
    let lister = Lister::new(Deps {
        proc: Arc::new(sim.clone()),
        gh: gh_bin.into(),
        origin: Arc::new(FakeOrigin),
        http: Some(linear.clone()),
        projects: Some(Arc::new(FakeProjects)),
        connectors: Some(Arc::new(FixedConnectors(connectors))),
        linear_api: "http://linear.test/graphql".into(),
        now: Arc::new(move || c.load(Ordering::SeqCst)),
    });
    World {
        lister,
        gh,
        sim,
        linear,
        clock,
    }
}

impl World {
    fn set_gh(&self, v: Value) {
        *self.gh.0.lock().unwrap() = v;
    }
    fn gh_calls(&self) -> Vec<Vec<String>> {
        self.sim
            .spawned()
            .into_iter()
            .filter(|s| s.args.first().is_some_and(|a| a == "issue"))
            .map(|s| s.args)
            .collect()
    }
    async fn get(&self, query: &[(&str, &str)]) -> (u16, Value) {
        let req = Request {
            method: "GET".into(),
            path: "/api/issues".into(),
            query: query
                .iter()
                .map(|(k, v)| ((*k).into(), (*v).into()))
                .collect(),
            ..Request::default()
        };
        match get_issues(&self.lister, &Call::new_root(Caller::user()), &req)
            .await
            .unwrap()
        {
            Response::Json { status, body } => (status, body),
            other => panic!("not json: {other:?}"),
        }
    }
}

fn issues() -> Value {
    json!([
        { "number": 12, "title": "Users get logged out after a refresh", "url": "https://github.com/acme/repo/issues/12", "labels": ["bug", "auth"], "assignees": [{ "login": "lena" }], "updatedAt": "2026-11-01T09:00:00Z", "body": "It happens on every refresh.\r\n\r\nSee the logs." },
        { "number": 9, "title": "Docs for the API", "url": "https://github.com/acme/repo/issues/9", "labels": [], "assignees": [], "updatedAt": "2026-10-28T09:00:00Z", "body": "x".repeat(5000) },
    ])
}

fn refs(v: &Value) -> Vec<String> {
    v["issues"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["ref"].as_str().unwrap().to_owned())
        .collect()
}

#[tokio::test]
async fn a_projects_open_github_issues_from_its_origin_remote() {
    let w = world(vec![], "gh");
    w.set_gh(json!({ "issues": issues() }));
    let (status, body) = w.get(&[("project", "p1")]).await;
    assert_eq!(status, 200);
    assert_eq!(
        (
            body["source"].as_str(),
            body["repo"].as_str(),
            body.get("error")
        ),
        (Some("github"), Some("acme/repo"), None)
    );
    assert_eq!(
        body["issues"][0],
        json!({ "id": "12", "ref": "#12", "number": 12, "title": "Users get logged out after a refresh", "url": "https://github.com/acme/repo/issues/12", "labels": ["bug", "auth"], "assignee": "lena", "body": "It happens on every refresh.\n\nSee the logs.", "updatedAt": "2026-11-01T09:00:00Z" })
    );
    assert_eq!(body["issues"][1]["assignee"], "");
    assert_eq!(
        body["issues"][1]["body"].as_str().unwrap().chars().count(),
        4000
    );
    let call = w.gh_calls().pop().unwrap();
    assert_eq!(
        call[..6],
        ["issue", "list", "--repo", "acme/repo", "--state", "open"]
    );
    // gh never prompts and never nags about updates
    let env = &w.sim.spawned().last().unwrap().env;
    for k in [
        "GH_PROMPT_DISABLED",
        "GH_NO_UPDATE_NOTIFIER",
        "GIT_TERMINAL_PROMPT",
    ] {
        assert!(env.iter().any(|(e, _)| e == k), "{k}");
    }
}

#[tokio::test]
async fn a_search_goes_to_gh_and_a_list_is_kept_for_a_minute() {
    let w = world(vec![], "gh");
    w.set_gh(json!({ "issues": issues() }));
    let (_, body) = w.get(&[("project", "p1"), ("q", "docs")]).await;
    assert_eq!(refs(&body), ["#9"]);
    assert_eq!(w.gh_calls().last().unwrap().last().unwrap(), "docs");
    let n = w.gh_calls().len();
    w.set_gh(json!({ "issues": [] }));
    assert_eq!(
        refs(&w.get(&[("project", "p1"), ("q", "docs")]).await.1),
        ["#9"]
    );
    assert_eq!(w.gh_calls().len(), n);
    // a minute later it asks again
    w.clock.fetch_add(60_000, Ordering::SeqCst);
    assert!(refs(&w.get(&[("project", "p1"), ("q", "docs")]).await.1).is_empty());
    assert_eq!(w.gh_calls().len(), n + 1);
}

#[tokio::test]
async fn each_problem_says_what_fixes_it_and_isnt_kept() {
    let w = world(vec![], "gh");
    w.set_gh(json!({ "signedOut": true }));
    let (status, body) = w.get(&[("project", "p1"), ("q", "signed-out")]).await;
    assert_eq!(
        (status, body["issues"].clone(), body["fix"].as_str()),
        (200, json!([]), Some("signin"))
    );
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("Sign in to GitHub")
    );
    w.set_gh(json!({ "issues": issues() }));
    assert!(
        w.get(&[("project", "p1"), ("q", "signed-out")])
            .await
            .1
            .get("error")
            .is_none()
    );

    let (_, body) = w.get(&[("project", "bare")]).await;
    assert_eq!(body["fix"], "remote");
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("has no GitHub remote")
    );
    assert_eq!(w.get(&[]).await.1["fix"], "project");
    w.set_gh(json!({ "issues": "not json" }));
    assert!(
        w.get(&[("project", "p1"), ("q", "broken")]).await.1["error"]
            .as_str()
            .unwrap()
            .contains("isn’t a list of issues")
    );
    assert_eq!(w.get(&[("project", "nope")]).await.0, 404);
    assert_eq!(
        w.get(&[("project", "p1"), ("source", "gitlab")]).await.0,
        400
    );
    assert_eq!(
        w.get(&[("project", "none"), ("source", "github")]).await.1["fix"],
        "project"
    );
}

#[tokio::test]
async fn gh_missing_says_to_install_it() {
    let w = world(vec![], "/nowhere/gh-missing");
    let (_, body) = w.get(&[("project", "p1"), ("q", "missing")]).await;
    assert_eq!(body["fix"], "install");
    assert!(body["error"].as_str().unwrap().contains("isn’t installed"));
}

fn linear(key: &str) -> Connector {
    Connector {
        id: "c1".into(),
        name: "linear".into(),
        command: "node".into(),
        args: vec!["-e".into(), "0".into()],
        enabled: true,
        env: vec![("LINEAR_API_KEY".into(), key.into())],
        ..Connector::default()
    }
}

#[tokio::test]
async fn linear_without_a_connector_says_connect_with_its_key_your_open_issues() {
    let w = world(vec![], "gh");
    let (_, body) = w.get(&[("source", "linear")]).await;
    assert_eq!(
        (body["linear"].as_bool(), body["fix"].as_str()),
        (Some(false), Some("linear"))
    );
    assert!(body["error"].as_str().unwrap().contains("Connect Linear"));
    w.set_gh(json!({ "issues": [] }));
    assert_eq!(w.get(&[("project", "p1")]).await.1["linear"], false);

    let w = world(vec![linear("lin_api_bad")], "gh");
    let (_, body) = w.get(&[("source", "linear")]).await;
    assert_eq!(body["fix"], "linear");
    assert!(
        body["error"]
            .as_str()
            .unwrap()
            .contains("refused the connector’s API key")
    );

    let w = world(vec![linear("lin_api_good")], "gh");
    let (_, body) = w.get(&[("source", "linear")]).await;
    assert!(body.get("error").is_none());
    assert_eq!(body["linear"], true);
    assert_eq!(
        body["issues"][0],
        json!({ "id": "ENG-7", "ref": "ENG-7", "number": "ENG-7", "title": "Login loops on Safari", "url": "https://linear.app/acme/issue/ENG-7", "labels": ["Bug"], "assignee": "Ada", "body": "Steps:\n1. Open Safari", "updatedAt": "2026-11-01T10:00:00Z" })
    );
    assert_eq!(body["issues"][1]["body"], "");
    assert_eq!(
        w.linear.0.lock().unwrap().last().unwrap().1["variables"]["filter"],
        json!({ "state": { "type": { "nin": ["completed", "canceled"] } } })
    );
    assert_eq!(
        refs(&w.get(&[("source", "linear"), ("q", "dark")]).await.1),
        ["ENG-9"]
    );
    w.set_gh(json!({ "issues": [] }));
    assert_eq!(w.get(&[("project", "p1")]).await.1["linear"], true);
}

#[tokio::test]
async fn jira_without_its_connector_says_connect_it() {
    let w = world(vec![], "gh");
    let (_, body) = w.get(&[("source", "jira")]).await;
    assert_eq!(
        (body["fix"].as_str(), body["jira"].as_bool()),
        (Some("jira"), Some(false))
    );
}

#[test]
fn why_of_prefers_fatal_and_error_lines_else_the_tail() {
    assert_eq!(
        why_of("hint: x\nfatal: no such remote\nmore"),
        "fatal: no such remote"
    );
    assert_eq!(why_of("a\nb\nc\nd\n"), "b c d");
    assert_eq!(why_of(""), "");
    assert_eq!(why_of("errors happen\nlast"), "errors happen last");
}
