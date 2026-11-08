use std::path::Path;

use serde_json::{Value, json};
use wisp_lsp_api::Severity;

use super::{Action, Client};
use crate::frame::{Decoder, encode};

/// What the client wrote, as messages.
fn sent(bytes: &[u8]) -> Vec<Value> {
    Decoder::new()
        .push(bytes)
        .iter()
        .filter_map(|b| serde_json::from_slice(b).ok())
        .collect()
}

#[cfg(unix)]
#[test]
fn initialize_says_where_and_what() {
    let mut c = Client::new();
    let (id, bytes) = c.initialize(Path::new("/w/my repo"), 42);
    let m = &sent(&bytes)[0];
    assert_eq!(
        (id, m["method"].as_str(), m["jsonrpc"].as_str()),
        (1, Some("initialize"), Some("2.0"))
    );
    assert_eq!(m["params"]["processId"], 42);
    assert_eq!(m["params"]["rootUri"], "file:///w/my%20repo");
    assert_eq!(
        m["params"]["workspaceFolders"],
        json!([{ "uri": "file:///w/my%20repo", "name": "my repo" }])
    );
    assert_eq!(
        m["params"]["capabilities"]["textDocument"]["completion"]["completionItem"]["snippetSupport"],
        false
    );
    assert_eq!(
        sent(&Client::initialized())[0],
        json!({ "jsonrpc": "2.0", "method": "initialized", "params": {} })
    );
}

#[test]
fn answers_match_requests() {
    let mut c = Client::new();
    let (a, _) = c.request("textDocument/hover", &json!({}));
    let (b, _) = c.request("textDocument/definition", &json!({}));
    assert_eq!((a, b, c.pending()), (1, 2, 2));
    assert_eq!(c.method_of(2), Some("textDocument/definition"));
    let mut bytes = encode(&json!({ "id": 2, "result": [1] }));
    bytes.extend(encode(
        &json!({ "id": 1, "error": { "code": -32603, "message": "boom" } }),
    ));
    bytes.extend(encode(&json!({ "id": 1, "result": "late twin" })));
    bytes.extend(encode(&json!({ "id": 99, "result": "nobody asked" })));
    assert_eq!(
        c.feed(&bytes),
        vec![
            Action::Reply {
                id: 2,
                result: Ok(json!([1]))
            },
            Action::Reply {
                id: 1,
                result: Err("boom".into())
            }
        ]
    );
    assert_eq!(c.pending(), 0);
}

#[test]
fn a_refusal_without_words() {
    let mut c = Client::new();
    let (id, _) = c.request("x", &json!({}));
    let got = c.feed(&encode(&json!({ "id": id, "error": { "code": 1 } })));
    assert_eq!(
        got,
        vec![Action::Reply {
            id,
            result: Err("The language server refused".into())
        }]
    );
    let (id, _) = c.request("x", &json!({}));
    assert_eq!(
        c.feed(&encode(&json!({ "id": id }))),
        vec![Action::Reply {
            id,
            result: Ok(Value::Null)
        }]
    );
}

#[test]
fn the_servers_questions_get_answers() {
    let mut c = Client::new();
    let ask = json!({ "id": "cfg-1", "method": "workspace/configuration", "params": { "items": [{ "section": "a" }, { "section": "b" }] } });
    let reg = json!({ "id": 7, "method": "client/registerCapability", "params": {} });
    let mut bytes = encode(&ask);
    bytes.extend(encode(&reg));
    let got = c.feed(&bytes);
    let answers: Vec<Value> = got
        .iter()
        .flat_map(|a| match a {
            Action::Send(b) => sent(b),
            _ => Vec::new(),
        })
        .collect();
    assert_eq!(
        answers,
        vec![
            json!({ "jsonrpc": "2.0", "id": "cfg-1", "result": [null, null] }),
            json!({ "jsonrpc": "2.0", "id": 7, "result": null })
        ]
    );
}

#[test]
fn notifications_other_than_diagnostics_are_ignored() {
    let mut c = Client::new();
    assert_eq!(
        c.feed(&encode(
            &json!({ "method": "window/logMessage", "params": { "message": "hi" } })
        ))
        .len(),
        0
    );
    assert_eq!(c.feed(b"Content-Length: 5\r\n\r\nnope!").len(), 0);
}

#[cfg(unix)]
#[test]
fn open_then_change_with_versions() {
    let mut c = Client::new();
    let f = Path::new("/r/a.ts");
    let (uri, first) = c.sync(f, "typescript", "a");
    let m = &sent(&first.unwrap_or_default())[0];
    assert_eq!(m["method"], "textDocument/didOpen");
    assert_eq!(
        m["params"]["textDocument"],
        json!({ "uri": "file:///r/a.ts", "languageId": "typescript", "version": 1, "text": "a" })
    );
    let (_, same) = c.sync(f, "typescript", "a");
    assert!(same.is_none(), "the server already has this text");
    let (_, second) = c.sync(f, "typescript", "b");
    let m = &sent(&second.unwrap_or_default())[0];
    assert_eq!(m["method"], "textDocument/didChange");
    assert_eq!(
        m["params"],
        json!({ "textDocument": { "uri": uri, "version": 2 }, "contentChanges": [{ "text": "b" }] })
    );
    assert_eq!(c.version(&uri), 2);
}

#[cfg(unix)]
#[test]
fn diagnostics_by_file_fresh_after_each_change() {
    let mut c = Client::new();
    let f = Path::new("/r/math.js");
    let (uri, _) = c.sync(f, "javascript", "// TODO");
    assert_eq!(c.fresh_diagnostics(&uri), None);
    let publish = |diags: Value| {
        encode(
            &json!({ "method": "textDocument/publishDiagnostics", "params": { "uri": "file:///r/math%2Ejs", "diagnostics": diags } }),
        )
    };
    let got = c.feed(&publish(json!([{ "range": { "start": { "line": 1, "character": 18 } }, "severity": 2, "message": "Something is left to do" }])));
    assert_eq!(got, vec![Action::Diagnostics { uri: uri.clone() }]);
    let d = c
        .fresh_diagnostics(&uri)
        .map(<[_]>::to_vec)
        .unwrap_or_default();
    assert_eq!(
        d.iter()
            .map(|x| (x.line, x.col, x.severity))
            .collect::<Vec<_>>(),
        [(2, 19, Severity::Warning)]
    );
    c.sync(f, "javascript", "clean");
    assert_eq!(c.fresh_diagnostics(&uri), None, "stale after the edit");
    assert_eq!(c.last_diagnostics(&uri).map(<[_]>::len), Some(1));
    c.feed(&publish(json!([])));
    assert_eq!(c.fresh_diagnostics(&uri).map(<[_]>::len), Some(0));
}

#[test]
fn a_dead_server_fails_whats_waiting() {
    let mut c = Client::new();
    c.request("a", &json!({}));
    c.request("b", &json!({}));
    let (id, _) = c.request("c", &json!({}));
    assert!(c.forget(id));
    assert!(!c.forget(id));
    assert_eq!(c.fail_all(), vec![1, 2]);
    assert_eq!(c.pending(), 0);
    // a late answer to a forgotten request is dropped
    assert_eq!(c.feed(&encode(&json!({ "id": id, "result": 1 }))).len(), 0);
}

#[test]
fn shutdown_then_exit() {
    let mut c = Client::new();
    c.request("initialize", &json!({}));
    let msgs = sent(&c.shutdown());
    assert_eq!(
        msgs,
        vec![
            json!({ "jsonrpc": "2.0", "id": 2, "method": "shutdown" }),
            json!({ "jsonrpc": "2.0", "method": "exit" })
        ]
    );
}
