//! The kernel's agent-token scope across plugins (v1 edge case HTTP #3, verify round 4): one plugin owns
//! the task tree, another has a command that names a task (`sessionId`) and a route (`:sid`), and a
//! third (like wisp.mcp) calls that command for the agent. An agent's token reaches its own task and
//! the tasks under it, and nothing else, by every path.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::scope::{TASKS, TaskTree};
use wisp_kernel::{BoxFuture, Caller, Code, Command, Manifest, Plugin, Result, Setup};
use wisp_testkit::TestApp;

fn manifest(id: &str) -> Manifest {
    Manifest::from_value(json!({ "wispPlugin": 1, "id": id, "version": "1.0.0", "api": "^1" })).unwrap()
}

/// L has one child; A is someone else's.
struct Tree;
impl TaskTree for Tree {
    fn within(&self, task: &str, root: &str) -> BoxFuture<'static, bool> {
        let ok = root == "L" && task == "L-child";
        Box::pin(async move { ok })
    }
}
struct Tasks;
impl Plugin for Tasks {
    fn manifest(&self) -> Manifest {
        manifest("acme.tasks")
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.contribute(&TASKS, Arc::new(Tree) as Arc<dyn TaskTree>);
        Ok(())
    }
}

/// A plugin's command that names a task the kernel-wide way.
struct Note;
impl Command for Note {
    const ID: &'static str = "notes.add";
    const PERMISSION: Option<&'static str> = Some("stuff:save");
    type Args = Value;
    type Out = Value;
}
/// Every note of every task.
struct All;
impl Command for All {
    const ID: &'static str = "notes.all";
    const PERMISSION: Option<&'static str> = Some("stuff:read");
    const ALL_TASKS: bool = true;
    type Args = Value;
    type Out = Value;
}
struct Notes;
impl Plugin for Notes {
    fn manifest(&self) -> Manifest {
        manifest("acme.notes")
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<Note, _, _>(|_, _, a| async move { Ok(json!({ "noted": a["sessionId"] })) });
        s.command::<All, _, _>(|_, _, _| async move { Ok(json!([])) });
        s.route(Route {
            method: "GET",
            pattern: "/notes/:sid",
            permission: "stuff:read",
            doc: false,
            summary: "a task's notes",
            raw: false,
            max_body: None,
            handler: Arc::new(|_, _, req: Request| Box::pin(async move { Response::ok(json!({ "of": req.param("sid") })) })),
        });
        Ok(())
    }
}

/// Like wisp.mcp: the agent's tool call runs another plugin's command in the agent's call.
struct Tool;
impl Command for Tool {
    const ID: &'static str = "mcp.call";
    const PERMISSION: Option<&'static str> = Some("mcp:call");
    const TASK_ARGS: &'static [&'static str] = &[];
    type Args = Value;
    type Out = Value;
}
struct Mcp;
impl Plugin for Mcp {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "acme.mcp", "version": "1.0.0", "api": "^1", "permissions": ["stuff:save"] })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<Tool, _, _>(|ctx, call, a| async move { ctx.run_json(&call, "notes.add", json!({ "sessionId": a["of"] })).await });
        Ok(())
    }
}

fn agent() -> Caller {
    Caller { set: "agent:session".into(), session: Some("L".into()), plugin: None }
}

fn get(path: &str) -> Request {
    Request { method: "GET".into(), path: path.into(), params: std::collections::BTreeMap::default(), query: Vec::new(), headers: Vec::new(), body: Vec::new() }
}

#[tokio::test]
async fn an_agents_token_speaks_for_its_own_task_and_its_children_only() {
    let k = TestApp::new().with(Tasks).with(Notes).with(Mcp).start().await;
    // a command of another plugin, called directly
    for ok in ["L", "L-child"] {
        assert_eq!(k.call(agent(), "notes.add", json!({ "sessionId": ok })).await.unwrap()["noted"], ok);
    }
    let e = k.call(agent(), "notes.add", json!({ "sessionId": "A" })).await.unwrap_err();
    assert_eq!(e.code, Code::Forbidden, "{}", e.message);
    // the same command reached through a tool plugin, in the agent's call
    let r = k.call(agent(), "mcp.call", json!({ "of": "L-child" })).await;
    assert!(r.is_ok(), "{r:?}");
    assert_eq!(k.call(agent(), "mcp.call", json!({ "of": "A" })).await.unwrap_err().code, Code::Forbidden);
    // a list of every task
    assert_eq!(k.call(agent(), "notes.all", json!({})).await.unwrap_err().code, Code::Forbidden);
    // a route that names a task
    assert!(k.serve(agent(), get("/api/notes/L")).await.is_ok());
    assert_eq!(k.serve(agent(), get("/api/notes/A")).await.unwrap_err().code, Code::Forbidden);
    // anyone else is not scoped
    assert!(k.call(Caller::user(), "notes.add", json!({ "sessionId": "A" })).await.is_ok());
    assert!(k.call(Caller::user(), "notes.all", json!({})).await.is_ok());
    assert!(k.serve(Caller::user(), get("/api/notes/A")).await.is_ok());
}
