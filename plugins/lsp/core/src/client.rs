//! One language server's conversation, without the process: bytes in, actions out. It numbers our
//! requests and matches their answers, answers the server's own requests so it carries on, keeps each
//! open file's version, and keeps the diagnostics the server publishes per file. The host owns the pipe,
//! the timers and the waiting.

use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::Path;

use serde_json::{Value, json};
use wisp_lsp_api::Diagnostic;

use crate::frame::{Decoder, encode};
use crate::url::{path_to_file_url, uri_key};

/// What the host does after bytes arrive.
#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    /// our request `id` was answered: its result, or the server's refusal in words
    Reply {
        id: u64,
        result: Result<Value, String>,
    },
    /// write these bytes to the server (an answer to its request)
    Send(Vec<u8>),
    /// the server published diagnostics for this file (by `uri_key`)
    Diagnostics { uri: String },
}

#[derive(Debug, Clone, Copy)]
struct Doc {
    version: u32,
    hash: u64,
}

#[derive(Debug, Default)]
struct Diags {
    list: Vec<Diagnostic>,
    /// published since the editor's copy last changed
    fresh: bool,
}

#[derive(Debug, Default)]
pub struct Client {
    seq: u64,
    pending: HashMap<u64, String>,
    open: HashMap<String, Doc>,
    diags: HashMap<String, Diags>,
    decoder: Decoder,
}

fn hash_of(text: &str) -> u64 {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    h.finish()
}

/// What we tell the server we can do (v1's initialize, unchanged).
fn capabilities() -> Value {
    json!({ "textDocument": {
        "completion": { "completionItem": { "snippetSupport": false } },
        "hover": { "contentFormat": ["markdown", "plaintext"] },
        "definition": {}, "references": {}, "publishDiagnostics": {},
        "synchronization": { "didSave": true }
    } })
}

impl Client {
    pub fn new() -> Self {
        Self::default()
    }

    /// Our request: its id (to wait on) and the bytes to write.
    pub fn request(&mut self, method: &str, params: &Value) -> (u64, Vec<u8>) {
        self.seq += 1;
        let id = self.seq;
        self.pending.insert(id, method.to_owned());
        (
            id,
            encode(&json!({ "id": id, "method": method, "params": params })),
        )
    }

    pub fn notify(method: &str, params: Option<Value>) -> Vec<u8> {
        match params {
            Some(params) => encode(&json!({ "method": method, "params": params })),
            None => encode(&json!({ "method": method })),
        }
    }

    /// `initialize` for a server working in `root`.
    pub fn initialize(&mut self, root: &Path, process_id: u32) -> (u64, Vec<u8>) {
        let uri = path_to_file_url(root);
        let name = root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        self.request(
            "initialize",
            &json!({ "processId": process_id, "rootUri": uri, "workspaceFolders": [{ "uri": uri, "name": name }], "capabilities": capabilities() }),
        )
    }

    pub fn initialized() -> Vec<u8> {
        Self::notify("initialized", Some(json!({})))
    }

    /// The editor's copy of `file` (unsaved edits too) is what the server reads: `didOpen` the first
    /// time, `didChange` with the next version after, nothing when the text is what it already has.
    pub fn sync(&mut self, file: &Path, lang_id: &str, text: &str) -> (String, Option<Vec<u8>>) {
        let uri = path_to_file_url(file);
        let hash = hash_of(text);
        let key = uri_key(&uri);
        let msg = match self.open.get(&uri).copied() {
            Some(doc) if doc.hash == hash => return (uri, None),
            Some(doc) => {
                let version = doc.version + 1;
                self.open.insert(uri.clone(), Doc { version, hash });
                json!({ "method": "textDocument/didChange", "params": { "textDocument": { "uri": uri, "version": version }, "contentChanges": [{ "text": text }] } })
            }
            None => {
                self.open.insert(uri.clone(), Doc { version: 1, hash });
                json!({ "method": "textDocument/didOpen", "params": { "textDocument": { "uri": uri, "languageId": lang_id, "version": 1, "text": text } } })
            }
        };
        // What the server said about the old text no longer counts as an answer for the new one.
        if let Some(d) = self.diags.get_mut(&key) {
            d.fresh = false;
        }
        (uri, Some(encode(&msg)))
    }

    /// The version the server has of `uri`, 0 when not open.
    pub fn version(&self, uri: &str) -> u32 {
        self.open.get(uri).map_or(0, |d| d.version)
    }

    /// Bytes from the server's stdout.
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Action> {
        let mut out = Vec::new();
        for body in self.decoder.push(bytes) {
            // A frame that isn't JSON is skipped; the next one still parses.
            if let Ok(Value::Object(msg)) = serde_json::from_slice::<Value>(&body) {
                self.handle(&Value::Object(msg), &mut out);
            }
        }
        out
    }

    fn handle(&mut self, msg: &Value, out: &mut Vec<Action>) {
        let id = msg.get("id").filter(|v| !v.is_null());
        let method = msg.get("method").and_then(Value::as_str);
        match (id, method) {
            (Some(id), None) => {
                let Some(id) = id.as_u64().filter(|id| self.pending.remove(id).is_some()) else {
                    return;
                };
                let result = match msg.get("error") {
                    Some(e) if !e.is_null() => Err(e
                        .get("message")
                        .and_then(Value::as_str)
                        .filter(|m| !m.is_empty())
                        .unwrap_or("The language server refused")
                        .to_owned()),
                    _ => Ok(msg.get("result").cloned().unwrap_or(Value::Null)),
                };
                out.push(Action::Reply { id, result });
            }
            // The server asking us something (workspace/configuration, registerCapability, …): answer
            // so it carries on. Configuration gets one null per item: "use your defaults".
            (Some(id), Some(method)) => {
                let result = if method == "workspace/configuration" {
                    let n = msg
                        .pointer("/params/items")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    Value::Array(vec![Value::Null; n])
                } else {
                    Value::Null
                };
                out.push(Action::Send(encode(&json!({ "id": id, "result": result }))));
            }
            (None, Some("textDocument/publishDiagnostics")) => {
                let params = msg.get("params").unwrap_or(&Value::Null);
                let Some(uri) = params.get("uri").and_then(Value::as_str) else {
                    return;
                };
                let key = uri_key(uri);
                let list =
                    crate::answer::diagnostics(params.get("diagnostics").unwrap_or(&Value::Null));
                self.diags.insert(key.clone(), Diags { list, fresh: true });
                out.push(Action::Diagnostics { uri: key });
            }
            _ => {}
        }
    }

    /// Diagnostics published since the editor's copy of `uri` last changed.
    pub fn fresh_diagnostics(&self, uri: &str) -> Option<&[Diagnostic]> {
        self.diags
            .get(&uri_key(uri))
            .filter(|d| d.fresh)
            .map(|d| d.list.as_slice())
    }

    /// The last diagnostics the server published for `uri`, fresh or not.
    pub fn last_diagnostics(&self, uri: &str) -> Option<&[Diagnostic]> {
        self.diags.get(&uri_key(uri)).map(|d| d.list.as_slice())
    }

    /// A request we stopped waiting for (it timed out): its late answer is dropped.
    pub fn forget(&mut self, id: u64) -> bool {
        self.pending.remove(&id).is_some()
    }

    /// The server is gone: every request still waiting, to fail.
    pub fn fail_all(&mut self) -> Vec<u64> {
        let mut ids: Vec<u64> = self.pending.drain().map(|(id, _)| id).collect();
        ids.sort_unstable();
        ids
    }

    pub fn pending(&self) -> usize {
        self.pending.len()
    }

    /// The method request `id` asked, while it waits.
    pub fn method_of(&self, id: u64) -> Option<&str> {
        self.pending.get(&id).map(String::as_str)
    }

    /// `shutdown` then `exit`: how a server is asked to go (its answer to shutdown isn't waited for).
    pub fn shutdown(&mut self) -> Vec<u8> {
        self.seq += 1;
        let mut out = encode(&json!({ "id": self.seq, "method": "shutdown" }));
        out.extend(Self::notify("exit", None));
        out
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
