//! wisp's built-in MCP tools, called the way a harness calls them (`POST /api/mcp`): as a task's agent, with
//! the token its run was given, and as the user's editor (`wisp mcp`). Each tool here once ran an owner command no
//! plugin registered, and failed for every caller ("unknown command"); `tools/check` rust-mcp-owners now catches
//! that statically, and these tests catch a tool whose owner answers in the wrong shape.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use common::*;
use serde_json::{Value, json};

/// A running wisp with one task whose fake agent is mid-turn, and that task's MCP token.
struct Agent {
    serve: Serve,
    api: Api,
    port: u16,
    id: String,
    token: String,
    dir: std::path::PathBuf,
}

impl Agent {
    async fn start(name: &str) -> Self {
        Self::start_env(name, |_| Vec::new()).await
    }

    /// `start`, with more variables for the server (made from the test's folder, before it starts).
    async fn start_env(name: &str, env: impl FnOnce(&std::path::Path) -> Vec<(String, String)>) -> Self {
        let dir = temp(name);
        let rec = dir.join("rec");
        std::fs::create_dir_all(&rec).unwrap();
        let more = env(&dir);
        let mut vars = vec![("FAKE_DELAY", "20000"), ("FAKE_RECORD", rec.to_str().unwrap())];
        vars.extend(more.iter().map(|(k, v)| (k.as_str(), v.as_str())));
        let (serve, port) = start_with(&dir, &vars);
        let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
        let made = api.cmd("runtime.create", json!({ "prompt": "hi", "cwd": dir.join("proj"), "agent": "claude" })).await;
        let id = made["id"].as_str().unwrap().to_owned();
        api.until(&id, "the turn running", |t| t.len() == 1 && t[0]["status"] == "running").await;
        let runs = until_records(&rec.join("claude.jsonl"), "the run's record", |r| !r.is_empty()).await;
        let argv = argv(&runs[0]);
        let cfg: Value = serde_json::from_str(&argv[argv.iter().position(|a| a == "--mcp-config").expect("--mcp-config") + 1]).unwrap();
        let token = cfg["mcpServers"]["wisp"]["headers"]["x-wisp-token"].as_str().unwrap().to_owned();
        Self { serve, api, port, id, token, dir }
    }

    async fn post(&self, body: Value, agent: bool) -> Value {
        let mut r = self.api.http.post(format!("http://127.0.0.1:{}/api/mcp", self.port)).header("content-type", "application/json");
        if agent {
            r = r.header("x-wisp-token", &self.token).header("x-wisp-session", &self.id);
        } else {
            r = r.header("x-wisp-cwd", self.dir.join("proj").to_string_lossy().into_owned());
        }
        let r = r.body(body.to_string()).send().await.unwrap();
        serde_json::from_slice(&r.bytes().await.unwrap()).unwrap_or(Value::Null)
    }

    /// `tools/call` as the task's agent: (the tool's text, whether it's an error result).
    async fn call(&self, tool: &str, args: Value) -> (String, bool) {
        Self::text(
            &self
                .post(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } }), true)
                .await,
        )
    }

    /// `tools/call` as the user's editor (`wisp mcp`).
    async fn user_call(&self, tool: &str, args: Value) -> (String, bool) {
        Self::text(
            &self
                .post(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": tool, "arguments": args } }), false)
                .await,
        )
    }

    fn text(r: &Value) -> (String, bool) {
        let res = &r["result"];
        let text = res["content"].as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect::<Vec<_>>().join("\n");
        (if text.is_empty() { r.to_string() } else { text }, res["isError"] == true || r.get("error").is_some())
    }

    async fn names(&self, agent: bool) -> Vec<String> {
        let list = self.post(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }), agent).await;
        list["result"]["tools"].as_array().unwrap().iter().filter_map(|t| t["name"].as_str().map(str::to_owned)).collect()
    }
}

/// Never "unknown command": the tool's owner is registered (whatever it then says about these arguments).
fn reached(tool: &str, (text, _): &(String, bool)) {
    assert!(!text.contains("unknown command"), "{tool} runs an owner command no plugin registers: {text}");
}

#[tokio::test(flavor = "multi_thread")]
async fn every_builtin_tool_reaches_a_registered_owner() {
    let a = Agent::start("mcp-sweep").await;
    // these wait on the user or on other tasks; their owners are typed commands rust-mcp-owners checks
    let waits = ["ask_user", "delegate", "subagent_results", "wisp_launch"];
    let agent = a.names(true).await;
    assert!(agent.len() >= 20, "{agent:?}");
    for t in agent.iter().filter(|t| (!waits.contains(&t.as_str()) && t.starts_with("wisp_")) || *t == "resume_later") {
        reached(t, &a.call(t, json!({})).await);
    }
    for t in ["wisp_crew", "wisp_crew_add", "wisp_crew_edit", "wisp_crew_remove", "wisp_list", "wisp_agents"] {
        reached(t, &a.user_call(t, json!({})).await);
    }
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_mcp_crew_tools_add_read_edit_and_remove_a_member() {
    let a = Agent::start("mcp-user-crew").await;
    let (t, err) = a.user_call("wisp_crew_add", json!({ "name": "Quill", "role": "Docs writer", "agent": "claude" })).await;
    assert!(!err && t.starts_with("Added Quill to the crew.") && t.contains("Docs writer"), "add: {t}");
    let (t, err) = a.user_call("wisp_crew", json!({})).await;
    assert!(!err && t.contains("**Quill** (@quill"), "list: {t}");
    let (t, err) = a.user_call("wisp_crew_edit", json!({ "member": "@Quill", "role": "Editor", "remember": ["likes short PRs"] })).await;
    assert!(!err && t.starts_with("Updated.") && t.contains("Editor"), "edit: {t}");
    let (t, err) = a.user_call("wisp_crew", json!({ "member": "Quill" })).await;
    assert!(!err && t.contains("## Notebook") && t.contains("- likes short PRs"), "detail: {t}");
    let (t, err) = a.user_call("wisp_crew_remove", json!({ "member": "Quill" })).await;
    assert!(!err && t.starts_with("Removed Quill from the crew."), "remove: {t}");
    let (t, _) = a.user_call("wisp_crew", json!({})).await;
    assert_eq!(t, "No crew yet. Add a member with wisp_crew_add.");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_crew_lists_the_crew_and_reads_one_member_in_full() {
    let a = Agent::start("mcp-crew-list").await;
    assert_eq!(a.call("wisp_crew", json!({})).await.0, "The user has no crew yet. Add a member with wisp_crew_add.");
    a.api.cmd("crew.create", json!({ "name": "Scout", "role": "CI watcher", "agent": "claude", "notebook": "main is green" })).await;
    let (t, err) = a.call("wisp_crew", json!({})).await;
    assert!(!err && t.starts_with("1 on the user's crew:") && t.contains("**Scout** (@scout"), "{t}");
    let (t, err) = a.call("wisp_crew", json!({ "member": "@scout" })).await;
    assert!(!err && t.contains("## Notebook\n\nmain is green") && t.contains("## Kit"), "{t}");
    let (t, err) = a.call("wisp_crew", json!({ "member": "Nobody" })).await;
    assert!(err && t.contains("No one called “Nobody” on the user's crew."), "{t}");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_crew_edit_changes_only_the_fields_given_and_remembers_lines() {
    let a = Agent::start("mcp-crew-edit").await;
    a.api.cmd("crew.create", json!({ "name": "Scout", "role": "CI watcher", "agent": "claude", "notebook": "main is green" })).await;
    let (t, err) =
        a.call("wisp_crew_edit", json!({ "member": "Scout", "role": "Release captain", "remember": ["ships on fridays"] })).await;
    assert!(!err && t.starts_with("Updated Scout.") && t.contains("Release captain") && t.contains("Their notebook now has"), "{t}");
    let m = a.api.cmd("crew.get", json!({ "id": "Scout" })).await;
    assert_eq!(m["notebook"], "main is green\n- ships on fridays");
    assert_eq!(m["agent"], "claude", "a field not given stays");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_crew_remove_removes_a_member() {
    let a = Agent::start("mcp-crew-remove").await;
    a.api.cmd("crew.create", json!({ "name": "Scout", "agent": "claude" })).await;
    let (t, err) = a.call("wisp_crew_remove", json!({ "member": "scout" })).await;
    assert!(!err && t.starts_with("Removed Scout from the user's crew."), "{t}");
    assert_eq!(a.api.cmd("crew.list", json!({})).await, json!([]));
    let (t, err) = a.call("wisp_crew_remove", json!({ "member": "scout" })).await;
    assert!(err && t.contains("No one called"), "{t}");
    a.serve.stop();
}

/// A remote connector the agent adds by its header's name (`linear`, `Authorization` unset): the same in each test.
async fn add_linear(a: &Agent) -> (String, bool) {
    a.call("wisp_connector_add", json!({ "name": "Linear", "url": "https://mcp.linear.app/mcp", "headers": ["Authorization"] })).await
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_connectors_lists_the_users_connectors() {
    let a = Agent::start("mcp-connectors-list").await;
    let (t, err) = a.call("wisp_connectors", json!({})).await;
    assert!(!err, "{t}");
    assert_eq!(t, "The user has no connectors yet. Add one with wisp_connector_add.");
    add_linear(&a).await;
    let (t, err) = a.call("wisp_connectors", json!({})).await;
    assert!(!err, "{t}");
    assert_eq!(
        t,
        "The user's connectors (MCP servers every task gets; not in Plan mode, not Cursor or Antigravity):\n\n\
         - **linear** · remote: https://mcp.linear.app/mcp · needs Authorization from the user (wisp_connector_signin)"
    );
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_connector_add_adds_a_connector_by_key_names() {
    let a = Agent::start("mcp-connectors-add").await;
    // a value would sit in the transcript: refused in v1's words, nothing added
    let (t, err) = a
        .call(
            "wisp_connector_add",
            json!({ "name": "linear", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer x" } }),
        )
        .await;
    assert!(err && t.contains("headers: give the names only, like [\"API_KEY\"]. The user types the values on the card"), "{t}");
    let (t, err) = add_linear(&a).await;
    assert!(!err, "{t}");
    assert_eq!(
        t,
        "Added linear to the user's connectors (Settings → Connectors).\n\n\
         - **linear** · remote: https://mcp.linear.app/mcp · needs Authorization from the user (wisp_connector_signin)\n\n\
         Next: call wisp_connector_signin so the user can sign in or give the keys."
    );
    let (t, err) = add_linear(&a).await;
    assert!(err && t.contains("There's a connector called linear already"), "a second one by the same name: {t}");
    let v = a.api.cmd("connectors.list", json!({})).await;
    let c = &v["connectors"][0];
    assert_eq!(
        (c["id"].as_str(), c["headers"][0]["key"].as_str(), c["headers"][0]["set"].as_bool()),
        (Some("linear"), Some("Authorization"), Some(false))
    );
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_connector_signin_answers_for_a_connector() {
    let a = Agent::start("mcp-connectors-signin").await;
    let (t, err) = a.call("wisp_connector_signin", json!({ "name": "github" })).await;
    assert!(err && t.contains("No connector called “github”. List them with wisp_connectors."), "{t}");
    add_linear(&a).await;
    let (t, err) = a.call("wisp_connector_signin", json!({ "name": "Linear", "why": "to read the issue" })).await;
    assert!(!err, "{t}");
    assert!(
        t.starts_with("linear needs Authorization. Ask the user to open Settings → Connectors and type Authorization on linear"),
        "{t}"
    );
    assert!(
        t.ends_with("Tasks get it from their next turn: harnesses load MCP servers when a turn starts, so this turn can’t call it yet."),
        "{t}"
    );
    a.serve.stop();
}

/// The id in `wisp_save`'s answer (`…, id <id>. …`).
fn saved_id(t: &str) -> String {
    t.split(", id ").nth(1).and_then(|r| r.split('.').next()).unwrap_or_default().to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_save_keeps_text_in_my_stuff() {
    let a = Agent::start("mcp-stuff-save").await;
    let (t, err) = a.call("wisp_save", json!({})).await;
    assert!(err && t.contains("Give exactly one of path (a file), text (with a name like notes.md), url, or app (a folder)"), "{t}");
    let (t, err) = a.call("wisp_save", json!({ "text": "x", "url": "https://example.com" })).await;
    assert!(err && t.contains("Give exactly one of"), "two at once: {t}");
    let (t, err) = a.call("wisp_save", json!({ "text": "# Plan\nShip on friday\n", "name": "plan.md", "title": "Launch plan" })).await;
    assert!(!err && t.starts_with("Saved “Launch plan” (doc, 22 B) to the user's My Stuff, id "), "{t}");
    let id = saved_id(&t);
    assert!(t.ends_with(&format!("Show it in your answer as {{\"type\":\"stuff\",\"id\":\"{id}\"}}.")), "{t}");
    let list = a.api.cmd("stuff.list", json!({})).await;
    let it = &list.as_array().unwrap()[0];
    assert_eq!((it["id"].as_str(), it["by"].as_str()), (Some(id.as_str()), Some("agent")));
    assert_eq!(it["from"]["session"].as_str(), Some(a.id.as_str()), "kept for the task that saved it");
    // a file, relative to the task's folder
    std::fs::write(a.dir.join("proj/notes.txt"), "hello").unwrap();
    let (t, err) = a.call("wisp_save", json!({ "path": "notes.txt" })).await;
    assert!(!err && t.starts_with("Saved “notes”") && t.contains("5 B"), "{t}");
    let (t, err) = a.call("wisp_save", json!({ "path": "gone.png" })).await;
    assert!(err && t.contains(&format!("Nothing at {}.", a.dir.join("proj/gone.png").display())), "{t}");
    // id alone: only its details change, the version before kept
    let (t, err) = a.call("wisp_save", json!({ "id": id, "note": "for friday" })).await;
    assert!(!err && t.starts_with("Updated “Launch plan” (doc, 22 B) in the user's My Stuff, now v"), "{t}");
    let (t, err) = a.call("wisp_save", json!({ "id": "nope", "title": "x" })).await;
    assert!(err && t.contains("That’s no longer in My Stuff."), "{t}");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_stuff_lists_and_reads_one_item() {
    let a = Agent::start("mcp-stuff-list").await;
    let (t, err) = a.call("wisp_stuff", json!({})).await;
    assert!(!err && t == "My Stuff is empty.", "{t}");
    let (t, _) =
        a.call("wisp_save", json!({ "text": "Ship on friday", "name": "plan.md", "title": "Launch plan", "tags": ["launch"] })).await;
    let id = saved_id(&t);
    a.call("wisp_save", json!({ "url": "https://example.com/brand", "title": "Brand guide" })).await;
    let (t, err) = a.call("wisp_stuff", json!({})).await;
    assert!(!err && t.starts_with("2 items in My Stuff:\n"), "{t}");
    assert!(
        t.contains("**Launch plan** — doc") && t.contains("**Brand guide** — link") && t.contains("url: https://example.com/brand"),
        "{t}"
    );
    assert!(t.ends_with("wisp_save with an id updates it."), "{t}");
    let (t, err) = a.call("wisp_stuff", json!({ "query": "launch" })).await;
    assert!(!err && t.starts_with("1 item in My Stuff:\n") && t.contains("#launch"), "{t}");
    let (t, err) = a.call("wisp_stuff", json!({ "kind": "link", "query": "launch" })).await;
    assert!(!err && t == "Nothing in My Stuff matches that.", "{t}");
    let (t, err) = a.call("wisp_stuff", json!({ "id": id })).await;
    assert!(!err && t.contains("```md\nShip on friday\n```"), "one item in full, its text too: {t}");
    assert!(t.contains("To change it, write the new version and wisp_save with id and text (or path)."), "{t}");
    let (t, err) = a.call("wisp_stuff", json!({ "id": "nope" })).await;
    assert!(!err && t == "No item nope in My Stuff.", "{t}");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_pr_attaches_and_detaches_a_pr() {
    let a = Agent::start_env("mcp-pr", |dir| {
        // gh is wisp-testkit's fake, first on PATH, with one open PR
        let bin = dir.join("gh-bin");
        install_fakes(&bin, &["gh"]);
        let state = dir.join("gh-state.json");
        let pr = json!({ "number": 12, "url": "https://github.com/acme/repo/pull/12", "title": "Fix the login", "state": "OPEN",
            "isDraft": false, "headRefName": "fix-login", "baseRefName": "main", "reviewDecision": "", "mergeStateStatus": "CLEAN",
            "statusCheckRollup": [] });
        std::fs::write(&state, json!({ "prs": { "12": pr } }).to_string()).unwrap();
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        vec![("PATH".into(), path), ("FAKE_GH_STATE".into(), state.display().to_string())]
    })
    .await;
    let (t, err) = a.call("wisp_pr", json!({ "pr": " " })).await;
    assert!(
        err && t.contains("Give the pull request’s URL (https://github.com/owner/repo/pull/123), or its number in this task’s repo."),
        "{t}"
    );
    let (t, err) = a.call("wisp_pr", json!({ "pr": "99" })).await;
    assert!(err && t.contains("gh could not read that PR"), "{t}");
    let (t, err) = a.call("wisp_pr", json!({ "pr": "#12" })).await;
    assert_eq!(
        (t.as_str(), err),
        (
            "Attached PR #12 “Fix the login” (open): https://github.com/acme/repo/pull/12. It shows on the task, and wisp follows its checks and reviews.",
            false
        )
    );
    let (t, err) = a.call("wisp_pr", json!({ "pr": "https://github.com/acme/repo/pull/12", "remove": true })).await;
    assert_eq!((t.as_str(), err), ("Detached PR #12 (https://github.com/acme/repo/pull/12).", false));
    let (t, err) = a.call("wisp_pr", json!({ "pr": "12", "remove": true })).await;
    assert!(err && t.contains("No PR like that is attached to this task."), "{t}");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_tag_replaces_the_tasks_tags() {
    let a = Agent::start("mcp-tag").await;
    let (t, err) = a.call("wisp_tag", json!({ "tags": ["Auth", "#Redis", "rate limit", "auth"] })).await;
    assert_eq!(
        (t.as_str(), err),
        ("Tagged: #auth #redis #rate-limit. Call wisp_tag again only if the work moves to another topic; it replaces these.", false)
    );
    assert_eq!(a.api.cmd("runtime.get", json!({ "id": a.id })).await["tags"], json!(["auth", "redis", "rate-limit"]));
    let (t, err) = a.call("wisp_tag", json!({ "tags": ["billing"] })).await;
    assert!(!err && t.starts_with("Tagged: #billing."), "{t}");
    assert_eq!(a.api.cmd("runtime.get", json!({ "id": a.id })).await["tags"], json!(["billing"]), "it replaces them");
    let (t, err) = a.call("wisp_tag", json!({ "tags": ["#", " "] })).await;
    assert!(err && t.contains("Give 3 to 8 short topic words, e.g. [\"auth\", \"rate-limit\", \"redis\"]."), "{t}");
    assert_eq!(a.api.cmd("runtime.get", json!({ "id": a.id })).await["tags"], json!(["billing"]), "a refusal changes nothing");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_blocks_answers_the_block_formats() {
    let a = Agent::start("mcp-blocks").await;
    let (t, err) = a.call("wisp_blocks", json!({ "types": ["graph"] })).await;
    assert!(!err && t.starts_with("- {\"type\":\"graph\""), "{t}");
    let (t, err) = a.call("wisp_blocks", json!({ "types": ["App", "table"] })).await;
    assert!(!err && t.starts_with("- {\"type\":\"app\""), "{t}");
    assert!(
        t.ends_with("No long docs for \"table\": graph and app have them; the others are described in full in your instructions."),
        "{t}"
    );
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_stats_answers_tool_counts() {
    let a = Agent::start("mcp-stats").await;
    // a finished codex task from v1, with three tool calls (and an answer, which isn't one)
    let v1 = a.dir.join("v1");
    std::fs::create_dir_all(&v1).unwrap();
    let now = i64::try_from(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()).unwrap();
    let at = now - 3_600_000;
    let step = |kind: &str, t: i64| json!({ "kind": kind, "label": format!("a {kind}"), "t": t });
    let old = json!({
        "id": "old-1", "title": "Fix the build", "agent": "codex", "model": "gpt-5", "cwd": a.dir.join("site"), "state": "done",
        "createdAt": at, "updatedAt": at + 60_000,
        "turns": [{ "id": "old-1-t1", "prompt": "fix it", "agent": "codex", "model": "gpt-5", "status": "done",
            "startedAt": at, "endedAt": at + 60_000, "stats": { "costUsd": 0.5, "inputTokens": 100, "outputTokens": 20 },
            "activity": [step("run", at + 1), step("read", at + 2), step("run", at + 3), step("answer", at + 4)] }]
    });
    std::fs::write(v1.join("old-1.json"), old.to_string()).unwrap();
    let r = a.api.cmd("runtime.import", json!({ "dir": v1 })).await;
    assert_eq!(r["imported"], 1, "{r}");

    let (t, err) = a.call("wisp_stats", json!({})).await;
    assert!(
        !err && t
            .starts_with("## wisp tool stats — last 30 days\n3 tool calls in 1 turns across 1 sessions. Success rate 100%, cost $0.50"),
        "{t}"
    );
    assert!(t.contains("| run | 2 | 67% |") && t.contains("| read | 1 | 33% |"), "{t}");
    assert!(t.contains("| codex | 3 | 1 | 100% | $0.50 | run 2, read 1 |") && t.contains("| site | 3 | 1 |"), "{t}");
    let (t, err) = a.call("wisp_stats", json!({ "days": "7", "agent": "claude" })).await;
    assert!(
        !err && t.starts_with("## wisp tool stats — last 7 days (harness claude)") && t.ends_with("No finished turns in this range."),
        "{t}"
    );
    let (t, err) = a.call("wisp_stats", json!({ "project": "current" })).await;
    assert!(
        !err && t.starts_with("## wisp tool stats — last 30 days (project proj)") && t.ends_with("No finished turns in this range."),
        "{t}"
    );
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_available_lists_harnesses_and_projects() {
    let a = Agent::start("mcp-available").await;
    let path = a.dir.join("proj").display().to_string();
    a.api
        .cmd("resources.apply", json!({ "resources": [{ "kind": "project", "name": "proj", "spec": { "path": path } }], "trust": true }))
        .await;
    let (t, err) = a.call("wisp_available", json!({})).await;
    assert!(!err && t.starts_with("## Harnesses on this computer\n"), "{t}");
    assert!(t.contains("- **claude** (") && t.contains("- **auto**: wisp picks the harness and model"), "{t}");
    assert!(t.contains("## Machines\nNone: everything runs on this computer."), "{t}");
    assert!(t.contains("## Projects\n- **proj**: ") && t.contains("/proj\n"), "{t}");
    assert!(t.contains("## Subagent presets (saved teams)\nNone."), "{t}");
    assert!(t.contains(&format!("Task `{}` on claude", a.id)) && t.contains("No subagents yet: delegate creates them on the fly."), "{t}");
    assert!(t.ends_with("wisp_task: follow up, stop, finish or archive a task."), "{t}");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_task_replies_to_another_task() {
    let a = Agent::start("mcp-task-reply").await;
    let made = a.api.cmd("runtime.create", json!({ "prompt": "other work", "cwd": a.dir.join("proj"), "agent": "claude" })).await;
    let other = made["id"].as_str().unwrap().to_owned();
    a.api.until(&other, "its turn running", |t| t.len() == 1 && t[0]["status"] == "running").await;
    a.api.cmd("runtime.stop", json!({ "id": other })).await;
    a.api.until(&other, "its turn over", |t| t.len() == 1 && ended(&t[0])).await;
    let (t, err) = a.call("wisp_task", json!({ "task": format!("wisp:{other}"), "action": "reply", "text": " " })).await;
    assert!(err && t.contains("text is required."), "{t}");
    let (t, err) = a.call("wisp_task", json!({ "task": other, "action": "reply", "text": "and the tests", "mode": "fast" })).await;
    assert!(err && t.contains("mode must be plan, edits or auto."), "{t}");
    let (t, err) = a.call("wisp_task", json!({ "task": other, "action": "reply", "text": "and the tests" })).await;
    assert!(!err && t.starts_with("Sent; it is working on it. “"), "{t}");
    assert!(t.ends_with(&format!("(`{other}`). wisp_task with action \"wait\" blocks until it is done.")), "{t}");
    let turns = a.api.until(&other, "the reply's turn", |t| t.len() == 2).await;
    assert_eq!(turns[1]["prompt"], "and the tests");
    let (t, err) = a.call("wisp_task", json!({ "task": other, "action": "rename", "title": "  Tests\n too " })).await;
    assert_eq!((t.as_str(), err), ("Renamed it “Tests too”.", false));
    assert_eq!(a.api.cmd("runtime.get", json!({ "id": other })).await["title"], "Tests too");
    let (t, err) = a.call("wisp_task", json!({ "task": other, "action": "launch" })).await;
    assert!(err && t.contains("action is one of reply, stop, done, archive, unarchive, rename"), "{t}");
    let (t, err) = a.call("wisp_task", json!({ "task": "nope", "action": "stop" })).await;
    assert!(err && t.contains("No task `nope` on this computer. wisp_sessions lists them."), "{t}");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_task_refuses_this_task_itself() {
    let a = Agent::start("mcp-task-self").await;
    let (t, err) = a.call("wisp_task", json!({ "task": a.id, "action": "reply", "text": "hello me" })).await;
    assert!(err && t.contains("That is this task. resume_later schedules a follow-up to yourself."), "{t}");
    assert_eq!(a.api.turns(&a.id).await.len(), 1, "nothing was sent");
    a.serve.stop();
}

// ---- writing an untrusted plugin (ADR-0048): v1's spell tools in their v2 form ----

/// A plugin of the user's, in a folder: a Settings pane that lists their plugins.
fn my_plugins(dir: &std::path::Path) -> (Value, String) {
    let manifest = json!({
        "wispPlugin": 1, "id": "user.my-plugins", "name": "My plugins", "version": "1.0.0", "api": "^1",
        "description": "Lists the plugins this wisp has.", "permissions": ["plugins:read"],
        "contributes": { "ui": [{ "id": "user.my-plugins.pane", "attachTo": { "id": "shell.settings", "input": "pane" }, "component": "./ui.js#default", "title": "My plugins" }] }
    });
    let ui = "wisp.call('plugins.list', {}).then((rows) => wisp.render({ c: 'Stack', k: rows.map((r) => ({ c: 'ListRow', p: { title: r.id } })) }));".to_owned();
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("wisp-plugin.json"), manifest.to_string()).unwrap();
    std::fs::write(dir.join("ui.js"), &ui).unwrap();
    (manifest, ui)
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_plugins_lists_the_users_own_plugins_in_plain_words_then_wisps() {
    let a = Agent::start("mcp-plugins").await;
    let (t, err) = a.call("wisp_plugins", json!({})).await;
    assert!(!err && t.starts_with("The user has no plugins of their own yet"), "{t}");
    assert!(t.contains("**Plugins** (wisp.plugins): on."), "wisp's own, one line each: {t}");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_plugins_shows_an_installed_plugin_off_untrusted_with_its_manifest() {
    let a = Agent::start("mcp-plugins-mine").await;
    let _ = my_plugins(&a.dir.join("mine"));
    a.api.cmd("plugins.install", json!({ "source": a.dir.join("mine") })).await;
    let (t, err) = a.call("wisp_plugins", json!({})).await;
    assert!(!err && t.starts_with("The user's own plugins (1)"), "{t}");
    assert!(t.contains("- **My plugins** (user.my-plugins 1.0.0): off, untrusted. Lists the plugins this wisp has."), "{t}");
    assert!(t.contains("Shows a pane in Settings → Advanced (“My plugins”)") && t.contains("May: `plugins:read`."), "{t}");
    assert!(t.contains("\"id\": \"user.my-plugins\""), "its manifest in full: {t}");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_plugin_schema_is_the_reference_made_from_the_real_types() {
    let a = Agent::start("mcp-plugin-schema").await;
    let (t, err) = a.call("wisp_plugin_schema", json!({})).await;
    assert!(!err && t.starts_with("# Writing a wisp plugin (the untrusted tier)"), "{}", &t[..t.len().min(300)]);
    for want in [
        "- `permissions`: ",
        "- `ui`: ",
        "- `SettingsRow` {",
        "`wisp.call(command, args)`",
        "- `shell.settings`: ",
        "- `plugins.list` ",
        "(`plugins:read`, reads)",
        "### “A Settings pane that lists my plugins and which are on”",
    ] {
        assert!(t.contains(want), "{want} in the reference");
    }
    assert!(!t.contains("`plugins.agent.list`"), "an agent's own tools aren't a plugin's commands");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_plugin_data_samples_a_read_only_command_and_refuses_the_rest() {
    let a = Agent::start("mcp-plugin-data").await;
    let (t, err) = a.call("wisp_plugin_data", json!({ "command": "plugins.list" })).await;
    assert!(!err && t.starts_with("plugins.list answered a list of "), "{t}");
    assert!(t.contains("needs \"plugins:read\" in its permissions") && t.contains("\"id\": ") && t.contains(" more\""), "a sample: {t}");
    let (t, err) =
        a.call("wisp_plugin_data", json!({ "command": "plugins.setEnabled", "args": { "id": "wisp.plugins", "enabled": false } })).await;
    assert!(err && t.contains("plugins.setEnabled isn't a data source"), "{t}");
    let (t, err) = a.call("wisp_plugin_data", json!({ "command": "nope.nothing" })).await;
    assert!(err && t.contains("nope.nothing isn't a command wisp has"), "{t}");
    // another plugin's data: the nested call narrows through wisp.plugins' own grant, which declares its sources
    a.api.cmd("crew.create", json!({ "name": "Scout", "role": "CI watcher", "agent": "claude" })).await;
    let (t, err) = a.call("wisp_plugin_data", json!({ "command": "crew.list" })).await;
    assert!(!err && t.starts_with("crew.list answered a list of 1") && t.contains("\"Scout\""), "{t}");
    let (t, err) = a.call("wisp_plugin_data", json!({ "command": "runtime.unmasked" })).await;
    assert!(
        err && t.contains("runtime.unmasked (\"runtime:unmasked\") isn't one wisp_plugin_data samples"),
        "never what reveals a secret: {t}"
    );
    let (t, err) = a.call("wisp_plugin_data", json!({ "command": "plugins.agent.list" })).await;
    assert!(err && t.contains("isn't a data source"), "not its own tools: {t}");
    // nothing was switched off
    let list = a.api.cmd("plugins.list", json!({})).await;
    assert!(list.as_array().unwrap().iter().any(|p| p["id"] == "wisp.plugins" && p["enabled"] == true), "{list}");
    a.serve.stop();
}

#[tokio::test(flavor = "multi_thread")]
async fn wisp_plugin_check_validates_a_plugin_without_installing_it() {
    let a = Agent::start("mcp-plugin-check").await;
    let (manifest, ui) = my_plugins(&a.dir.join("mine"));
    let (t, err) = a.call("wisp_plugin_check", json!({ "manifest": manifest, "files": { "ui.js": ui } })).await;
    assert!(!err && t.starts_with("ok: My plugins (user.my-plugins) would install."), "{t}");
    assert!(t.contains("- calls plugins.list (") && t.contains("which only reads"), "{t}");
    let list = a.api.cmd("plugins.list", json!({})).await;
    assert!(!list.to_string().contains("user.my-plugins"), "checked, never installed: {list}");
    let (t, err) = a.call("wisp_plugin_check", json!({ "manifest": { "wispPlugin": 1, "id": "my-plugins", "version": "1.0.0", "api": "^1", "permissions": [], "contributes": manifest["contributes"] } })).await;
    assert!(!err && t.contains("problems to fix") && t.contains("isn't a plugin of yours") && t.contains("ui.js isn't given"), "{t}");
    a.serve.stop();
}
