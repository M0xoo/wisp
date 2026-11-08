//! A server's answers, as the editor wants them: places inside the task's folder with 1-based
//! positions, hover text, completion items, diagnostics. Each list is capped (v1's limits).

use std::path::{Component, Path, PathBuf};

use serde_json::Value;
use wisp_lsp_api::{CompletionItem, Diagnostic, Severity};

use crate::url::file_url_to_path;

pub const MAX_HITS: usize = 200;
pub const MAX_ITEMS: usize = 100;
pub const MAX_HOVER: usize = 4000;
pub const MAX_LINE: usize = 240;
pub const MAX_DETAIL: usize = 160;
pub const MAX_MESSAGE: usize = 500;

fn cap(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// v1's `String(x || '')`: a string as is, nothing as empty, anything else as its JSON.
fn text_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null | Value::Bool(false)) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
    }
}

fn lexical(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// `file` relative to `root` with `/`, or `None` when it lies outside (a library's: not this task's).
pub fn relative_inside(root: &Path, file: &Path) -> Option<String> {
    let rel = lexical(file)
        .strip_prefix(lexical(root))
        .ok()?
        .to_path_buf();
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

/// v1 `sourceFile`'s lexical half: `rel` inside `root` (not the root itself, not under `.git`). The host
/// then checks the real path (symlinks) and that the file is there.
pub fn resolve_inside(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.is_empty() || Path::new(rel).is_absolute() || rel.starts_with(['/', '\\']) {
        return None;
    }
    let file = lexical(&root.join(rel));
    let inside = relative_inside(root, &file)?;
    if inside.is_empty() || inside.split('/').next() == Some(".git") {
        return None;
    }
    Some(file)
}

/// Where an LSP `Location` or `LocationLink` points, before the line's text is read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Located {
    pub file: PathBuf,
    /// relative to the root, with `/`
    pub path: String,
    /// 0-based, to read the line's text
    pub line_index: usize,
    pub line: u32,
    pub col: u32,
}

fn start_of(range: &Value) -> Option<(u32, u32)> {
    let s = range.get("start")?;
    let n = |k: &str| {
        s.get(k)
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok())
    };
    Some((n("line")?, n("character")?))
}

pub fn locate(root: &Path, loc: &Value) -> Option<Located> {
    let uri = loc
        .get("uri")
        .or_else(|| loc.get("targetUri"))
        .and_then(Value::as_str)?;
    let range = ["range", "targetSelectionRange", "targetRange"]
        .iter()
        .find_map(|k| loc.get(*k).filter(|v| v.is_object()))?;
    if !uri.starts_with("file:") {
        return None;
    }
    let file = file_url_to_path(uri)?;
    let path = relative_inside(root, &file)?;
    let (line, ch) = start_of(range)?;
    Some(Located {
        file,
        path,
        line_index: line as usize,
        line: line + 1,
        col: ch + 1,
    })
}

/// A definition's or references' result: one location, a list, or nothing.
pub fn locations(res: &Value) -> Vec<&Value> {
    match res {
        Value::Array(a) => a.iter().collect(),
        Value::Null => Vec::new(),
        one => vec![one],
    }
}

/// The text of line `index`, trimmed, at most 240 characters.
pub fn line_text(text: &str, index: usize) -> String {
    text.split('\n')
        .nth(index)
        .map(|l| cap(l.trim(), MAX_LINE))
        .unwrap_or_default()
}

/// A hover's contents (a string, a `MarkupContent`, a `MarkedString` or a list of them), at most 4000.
pub fn hover_text(h: &Value) -> String {
    let one = |x: &Value| match x {
        Value::String(s) => s.clone(),
        other => other
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
    };
    let text = match h.get("contents") {
        Some(Value::Array(a)) => a.iter().map(one).collect::<Vec<_>>().join("\n\n"),
        Some(c) => one(c),
        None => String::new(),
    };
    cap(text.trim(), MAX_HOVER)
}

/// A completion's items (a list, or a `CompletionList`), the first 100.
pub fn completion_items(res: &Value) -> Vec<CompletionItem> {
    let items = match res {
        Value::Array(a) => a.as_slice(),
        other => other
            .get("items")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice),
    };
    items
        .iter()
        .take(MAX_ITEMS)
        .map(|x| {
            let label = text_of(x.get("label"));
            let edit = x
                .pointer("/textEdit/newText")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty());
            let insert = edit
                .or_else(|| {
                    x.get("insertText")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                })
                .map_or_else(|| label.clone(), str::to_owned);
            CompletionItem {
                detail: cap(&text_of(x.get("detail")), MAX_DETAIL),
                insert,
                label,
            }
        })
        .collect()
}

/// `publishDiagnostics`' list, 1-based, severity by name, messages at most 500.
pub fn diagnostics(list: &Value) -> Vec<Diagnostic> {
    list.as_array()
        .map_or(&[][..], Vec::as_slice)
        .iter()
        .map(|x| {
            let (line, ch) = x.get("range").and_then(start_of).unwrap_or((0, 0));
            let severity = match x.get("severity").and_then(Value::as_u64) {
                Some(1) => Severity::Error,
                Some(2) => Severity::Warning,
                _ => Severity::Info,
            };
            Diagnostic {
                line: line + 1,
                col: ch + 1,
                severity,
                message: cap(&text_of(x.get("message")), MAX_MESSAGE),
            }
        })
        .collect()
}

/// v1's rename rule: a name the editor may type, `^[A-Za-z_$][\w$]*$`.
pub fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(unix)]
    #[test]
    fn places_inside_the_root() {
        let loc = json!({ "uri": "file:///r/src/a%20b.ts", "range": { "start": { "line": 0, "character": 16 }, "end": { "line": 0, "character": 19 } } });
        assert_eq!(
            locate(Path::new("/r"), &loc),
            Some(Located {
                file: "/r/src/a b.ts".into(),
                path: "src/a b.ts".into(),
                line_index: 0,
                line: 1,
                col: 17
            })
        );
        let link = json!({ "targetUri": "file:///r/b.ts", "targetRange": { "start": { "line": 4, "character": 0 } }, "targetSelectionRange": { "start": { "line": 5, "character": 2 } } });
        assert_eq!(
            locate(Path::new("/r"), &link).map(|l| (l.line, l.col)),
            Some((6, 3))
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_library_is_not_the_tasks_to_open() {
        let lib = json!({ "uri": "file:///usr/lib/node_modules/x.d.ts", "range": { "start": { "line": 0, "character": 0 } } });
        assert_eq!(locate(Path::new("/r"), &lib), None);
        let sib = json!({ "uri": "file:///r2/a.ts", "range": { "start": { "line": 0, "character": 0 } } });
        assert_eq!(locate(Path::new("/r"), &sib), None);
        let up = json!({ "uri": "file:///r/../etc/passwd", "range": { "start": { "line": 0, "character": 0 } } });
        assert_eq!(locate(Path::new("/r"), &up), None);
        let other =
            json!({ "uri": "jdt://x", "range": { "start": { "line": 0, "character": 0 } } });
        assert_eq!(locate(Path::new("/r"), &other), None);
        assert_eq!(
            locate(Path::new("/r"), &json!({ "uri": "file:///r/a" })),
            None
        );
    }

    #[test]
    fn one_a_list_or_none() {
        assert_eq!(locations(&Value::Null).len(), 0);
        assert_eq!(locations(&json!({ "uri": "x" })).len(), 1);
        assert_eq!(locations(&json!([1, 2])).len(), 2);
    }

    #[test]
    fn line_texts_are_trimmed_and_capped() {
        assert_eq!(
            line_text("a\n   export function add(a, b) {  \r\n", 1),
            "export function add(a, b) {"
        );
        assert_eq!(line_text("x", 5), "");
        assert_eq!(line_text(&"é".repeat(300), 0).chars().count(), 240);
    }

    #[test]
    fn hovers() {
        assert_eq!(
            hover_text(&json!({ "contents": { "kind": "markdown", "value": " ```ts\nf\n``` " } })),
            "```ts\nf\n```"
        );
        assert_eq!(
            hover_text(&json!({ "contents": ["a", { "language": "ts", "value": "b" }] })),
            "a\n\nb"
        );
        assert_eq!(hover_text(&json!({ "contents": "plain" })), "plain");
        assert_eq!(hover_text(&Value::Null), "");
        assert_eq!(
            hover_text(&json!({ "contents": "x".repeat(5000) })).len(),
            4000
        );
    }

    #[test]
    fn completions() {
        let res = json!({ "items": [{ "label": "add", "detail": "function add(a, b)" }, { "label": "addAll", "insertText": "addAll" }, { "label": "e", "textEdit": { "newText": "edit", "range": {} } }] });
        let items = completion_items(&res);
        assert_eq!(
            items.iter().map(|x| x.insert.as_str()).collect::<Vec<_>>(),
            ["add", "addAll", "edit"]
        );
        assert_eq!(items[0].detail, "function add(a, b)");
        assert_eq!(items[1].detail, "");
        let many: Vec<Value> = (0..150)
            .map(|i| json!({ "label": format!("x{i}"), "detail": "d".repeat(200) }))
            .collect();
        let items = completion_items(&Value::Array(many));
        assert_eq!(items.len(), 100);
        assert_eq!(items[0].detail.len(), 160);
        assert_eq!(completion_items(&Value::Null).len(), 0);
    }

    #[test]
    fn diagnostics_by_name() {
        let list = json!([
            { "range": { "start": { "line": 1, "character": 15 } }, "severity": 2, "message": "Something is left to do" },
            { "range": { "start": { "line": 0, "character": 0 } }, "severity": 1, "message": "m".repeat(600) },
            { "range": { "start": { "line": 3, "character": 1 } }, "message": 42 },
            { "severity": 4 }
        ]);
        let d = diagnostics(&list);
        assert_eq!(
            (d[0].line, d[0].col, d[0].severity),
            (2, 16, Severity::Warning)
        );
        assert_eq!((d[1].severity, d[1].message.len()), (Severity::Error, 500));
        assert_eq!(
            (d[2].severity, d[2].message.as_str()),
            (Severity::Info, "42")
        );
        assert_eq!((d[3].line, d[3].col, d[3].message.as_str()), (1, 1, ""));
    }

    #[test]
    fn names() {
        for ok in ["sum", "_x", "$el", "a1_$"] {
            assert!(valid_name(ok), "{ok}");
        }
        for bad in ["", "1a", "a-b", "a b", "é", "a.b"] {
            assert!(!valid_name(bad), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn source_files() {
        let r = Path::new("/r");
        assert_eq!(
            resolve_inside(r, "src/a.ts"),
            Some(PathBuf::from("/r/src/a.ts"))
        );
        assert_eq!(
            resolve_inside(r, "src/../b.ts"),
            Some(PathBuf::from("/r/b.ts"))
        );
        assert_eq!(resolve_inside(r, "../x"), None);
        assert_eq!(resolve_inside(r, "/etc/passwd"), None);
        assert_eq!(resolve_inside(r, ""), None);
        assert_eq!(resolve_inside(r, "."), None);
        assert_eq!(resolve_inside(r, ".git/config"), None);
        assert_eq!(resolve_inside(r, "a/../.git/HEAD"), None);
        assert_eq!(
            resolve_inside(r, ".github/ci.yml"),
            Some(PathBuf::from("/r/.github/ci.yml"))
        );
    }
}
