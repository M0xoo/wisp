//! An ask, from the route's body to the LSP request it becomes.

use serde_json::{Value, json};
use wisp_lsp_api::{LspRequest, Op};

/// v1's 400 for an op it doesn't know.
pub fn bad_op() -> String {
    let ops: Vec<&str> = Op::ALL.iter().map(|o| o.as_str()).collect();
    format!("op is one of {}", ops.join(", "))
}

/// v1's `Number(x) || 1`, kept to a 1-based position: a number, or a number in a string.
fn position(v: Option<&Value>) -> Option<u32> {
    let n = match v? {
        Value::Number(n) => n.as_f64()?,
        Value::String(s) => s.trim().parse::<f64>().ok()?,
        _ => return None,
    };
    // Truncation is the point: a fractional or huge position is clamped to a line the server can take.
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let n = n.floor().clamp(0.0, f64::from(u32::MAX)) as u32;
    (n > 0).then_some(n)
}

/// The route's body as v1 read it (lenient: a field of the wrong type counts as missing). `Err` is the
/// 400 for an unknown op.
pub fn parse_request(body: &Value) -> Result<LspRequest, String> {
    let op = body.get("op").and_then(Value::as_str).and_then(Op::parse).ok_or_else(bad_op)?;
    let new_name = match body.get("newName") {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    };
    Ok(LspRequest {
        op,
        path: body.get("path").and_then(Value::as_str).unwrap_or("").to_owned(),
        text: body.get("text").and_then(Value::as_str).map(str::to_owned),
        line: position(body.get("line")),
        col: position(body.get("col")),
        new_name,
    })
}

/// The LSP request an op makes at a 1-based position; `None` for diagnostics, which are published.
pub fn lsp_request(op: Op, uri: &str, line: u32, col: u32, new_name: &str) -> Option<(&'static str, Value)> {
    let at = json!({ "textDocument": { "uri": uri }, "position": { "line": line.saturating_sub(1), "character": col.saturating_sub(1) } });
    let with = |k: &str, v: Value| {
        let mut p = at.clone();
        p[k] = v;
        p
    };
    match op {
        Op::Diagnostics => None,
        Op::Hover => Some(("textDocument/hover", at)),
        Op::Completion => Some(("textDocument/completion", at)),
        Op::Definition => Some(("textDocument/definition", at)),
        Op::References => Some(("textDocument/references", with("context", json!({ "includeDeclaration": true })))),
        Op::Rename => Some(("textDocument/rename", with("newName", json!(new_name)))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bodies_as_v1_read_them() {
        let r = parse_request(&json!({ "op": "hover", "path": "a.ts", "text": "x", "line": "3", "col": 4.7 }));
        assert_eq!(r.as_ref().map(|r| (r.line(), r.col(), r.text.clone())), Ok((3, 4, Some("x".into()))));
        let r = parse_request(&json!({ "op": "definition", "path": 7, "text": 9, "line": 0, "col": "x" }));
        assert_eq!(r.map(|r| (r.line(), r.col(), r.path, r.text)), Ok((1, 1, String::new(), None)));
        let r = parse_request(&json!({ "op": "rename", "path": "a", "newName": 12, "line": -3 }));
        assert_eq!(r.map(|r| (r.line(), r.new_name)), Ok((1, Some("12".into()))));
    }

    #[test]
    fn unknown_ops_are_a_400() {
        let msg = "op is one of definition, references, hover, diagnostics, rename, completion";
        assert_eq!(parse_request(&json!({ "op": "format" })), Err(msg.into()));
        assert_eq!(parse_request(&json!({})), Err(msg.into()));
        assert_eq!(parse_request(&Value::Null), Err(msg.into()));
    }

    #[test]
    fn requests_per_op() {
        assert_eq!(lsp_request(Op::Diagnostics, "u", 1, 1, ""), None);
        let (m, p) = lsp_request(Op::References, "file:///a", 2, 23, "").unwrap_or_default();
        assert_eq!(m, "textDocument/references");
        assert_eq!(
            p,
            json!({ "textDocument": { "uri": "file:///a" }, "position": { "line": 1, "character": 22 }, "context": { "includeDeclaration": true } })
        );
        let (m, p) = lsp_request(Op::Rename, "u", 1, 1, "sum").unwrap_or_default();
        assert_eq!((m, p["newName"].clone()), ("textDocument/rename", json!("sum")));
        assert_eq!(lsp_request(Op::Definition, "u", 1, 1, "").map(|x| x.0), Some("textDocument/definition"));
        assert_eq!(lsp_request(Op::Hover, "u", 1, 1, "").map(|x| x.0), Some("textDocument/hover"));
        assert_eq!(lsp_request(Op::Completion, "u", 1, 1, "").map(|x| x.0), Some("textDocument/completion"));
    }
}
