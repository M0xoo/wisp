//! wisp.lsp in `wisp serve` (v1 test/lsp.test.js): the task's language server (a stand-in here, named
//! with `WISP_LSP_TS` as v1 allowed) answers the editor through v1's route: where a name is defined,
//! where it's used, what it is, what's wrong, what may come next, and a rename across the task's files.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;

use common::*;
use serde_json::{Value, json};

#[tokio::test(flavor = "multi_thread")]
async fn the_editor_asks_the_tasks_language_server() {
    if cfg!(windows) || std::process::Command::new("python3").arg("-V").output().is_err() {
        return;
    }
    let dir = temp("serve-lsp");
    std::fs::write(dir.join("proj/a.ts"), "export const add = 1;\nadd;\n").unwrap();
    let fake = format!("python3 {}", std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_lsp.py").display());
    let (serve, port) = start_with(&dir, &[("WISP_LSP_TS", fake.as_str())]);
    let api = Arc::new(Api { http: reqwest::Client::new(), port, n: 0.into() });
    let (_, task) = run_task(&api, &dir, "claude").await;
    let id = task["id"].as_str().unwrap().to_owned();
    let ask = |body: Value| {
        let (http, id) = (api.http.clone(), id.clone());
        async move {
            let r = http
                .post(format!("http://127.0.0.1:{port}/api/sessions/{id}/lsp"))
                .header("content-type", "application/json")
                .body(body.to_string())
                .send()
                .await
                .unwrap();
            serde_json::from_slice::<Value>(&r.bytes().await.unwrap()).unwrap()
        }
    };
    let def = ask(json!({ "op": "definition", "path": "a.ts", "line": 2, "col": 1 })).await;
    assert_eq!(def, json!({ "lsp": "TypeScript", "hits": [{ "path": "a.ts", "line": 1, "col": 14, "text": "export const add = 1;" }] }));
    let refs = ask(json!({ "op": "references", "path": "a.ts", "line": 1, "col": 14 })).await;
    assert_eq!(refs["hits"].as_array().unwrap().len(), 2, "{refs}");
    assert_eq!(ask(json!({ "op": "hover", "path": "a.ts", "line": 1, "col": 14 })).await["hover"], "const add: 1");
    assert_eq!(ask(json!({ "op": "completion", "path": "a.ts", "line": 2, "col": 2 })).await["items"][0]["label"], "addAll");
    let d = ask(json!({ "op": "diagnostics", "path": "a.ts" })).await;
    assert_eq!(d["diagnostics"][0]["message"], "unused expression", "{d}");
    let ren = ask(json!({ "op": "rename", "path": "a.ts", "line": 1, "col": 14, "newName": "sum" })).await;
    assert_eq!((ren["files"].clone(), ren["count"].clone()), (json!(["a.ts"]), json!(2)), "{ren}");
    assert_eq!(std::fs::read_to_string(dir.join("proj/a.ts")).unwrap(), "export const sum = 1;\nsum;\n");
    // a language with no server: the page keeps its text search, offered an install where wisp can
    std::fs::write(dir.join("proj/b.py"), "x = 1\n").unwrap();
    assert_eq!(ask(json!({ "op": "hover", "path": "b.py" })).await, json!({ "lsp": null, "lang": "py", "install": "Python" }));
    drop(serve);
}
