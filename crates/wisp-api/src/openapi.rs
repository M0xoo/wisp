//! `GET /api/openapi.json`, assembled from the route table (v1 openapi.js was written by hand and drifted).
//! Every route is in it but those marked `doc: false` (not public API, left out on purpose); a test
//! checks that every documented route has a summary, so nothing public goes undescribed.
use serde_json::{Map, Value, json};

use crate::router::Entry;

/// `/api/sessions/:id` → `/api/sessions/{id}` and its path parameters.
fn templated(path: &str) -> (String, Vec<String>) {
    let mut names = Vec::new();
    let segs: Vec<String> = path
        .split('/')
        .map(|s| match s.strip_prefix(':') {
            Some(n) => {
                names.push(n.to_owned());
                format!("{{{n}}}")
            }
            None => s.to_owned(),
        })
        .collect();
    (segs.join("/"), names)
}

fn operation_id(method: &str, path: &str) -> String {
    let mut id = method.to_ascii_lowercase();
    for part in path.split('/').filter(|s| !s.is_empty() && *s != "api") {
        let part = part.trim_start_matches(':');
        let mut cs = part.chars().filter(char::is_ascii_alphanumeric);
        if let Some(c) = cs.next() {
            id.push(c.to_ascii_uppercase());
            id.extend(cs);
        }
    }
    id
}

fn operation(e: &Entry, params: &[String]) -> Value {
    let mut op = json!({
        "summary": e.summary,
        "operationId": operation_id(&e.method, &e.path),
        "tags": [e.owner],
        "x-wisp-permission": e.permission,
        "responses": {
            "200": { "description": "OK", "content": { "application/json": { "schema": {} } } },
            "default": { "description": "A refusal or an error", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Error" } } } }
        }
    });
    if !params.is_empty() {
        op["parameters"] =
            params.iter().map(|n| json!({"name": n, "in": "path", "required": true, "schema": {"type": "string"}})).collect();
    }
    if !matches!(e.method.as_str(), "GET" | "HEAD" | "DELETE") {
        let ct = if e.max_body.is_some() { "application/octet-stream" } else { "application/json" };
        op["requestBody"] = json!({ "content": { ct: { "schema": {} } } });
    }
    op
}

pub fn document(routes: &[std::sync::Arc<Entry>], version: &str) -> Value {
    let mut paths = Map::new();
    for e in routes.iter().filter(|e| e.doc) {
        let (path, params) = templated(&e.path);
        let item = paths.entry(path).or_insert_with(|| Value::Object(Map::new()));
        if let Value::Object(item) = item {
            item.insert(e.method.to_ascii_lowercase(), operation(e, &params));
        }
    }
    json!({
        "openapi": "3.1.0",
        "info": { "title": "wisp", "version": version, "description": "wisp's HTTP API. Writes are JSON (uploads: octet-stream); errors are {error, code, message, retry}." },
        "servers": [{ "url": "http://127.0.0.1:4477" }],
        "paths": paths,
        "components": {
            "securitySchemes": { "token": { "type": "apiKey", "in": "header", "name": "x-wisp-token" } },
            "schemas": {
                "Error": {
                    "type": "object",
                    "required": ["error", "code", "message"],
                    "properties": {
                        "error": { "type": "string" },
                        "code": { "type": "string" },
                        "message": { "type": "string" },
                        "retry": { "type": "boolean" },
                        "details": {}
                    }
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn templates_and_ids() {
        assert_eq!(templated("/api/sessions/:id/turns/:tid").0, "/api/sessions/{id}/turns/{tid}");
        assert_eq!(templated("/api/sessions/:id/turns/:tid").1, vec!["id", "tid"]);
        assert_eq!(operation_id("POST", "/api/sessions/:id/stop"), "postSessionsIdStop");
        assert_eq!(operation_id("GET", "/api/openapi.json"), "getOpenapijson");
    }
}
