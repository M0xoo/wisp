//! wisp-lsp-api: the contract of wisp.lsp, language intelligence for the side panel's editor (v1
//! server/lsp.js): a language server per task folder and language, spoken to over stdio. It says where a
//! name is defined, every place it is used, what it is (hover), what's wrong in a file (diagnostics),
//! what may come next (completion), and renames a name across the task's files.
//!
//! Commands only: the HTTP routes (`POST /sessions/:id/lsp`, `POST /lsp/install`) are thin adapters over
//! the same work, with v1's paths, bodies and status codes.

pub mod model;

use wisp_kernel::Command;

pub use model::*;

/// The plugin id (manifest `id`).
pub const PLUGIN_ID: &str = "wisp.lsp";

/// Permissions, each a command's id (`lsp.ask` → `lsp:ask`). Default deny: a capability set names them.
pub mod permissions {
    /// ask a language server about a task's file (rename writes the task's files)
    pub const ASK: &str = "lsp:ask";
    /// install npm's language servers into `<home>/lsp`
    pub const INSTALL: &str = "lsp:install";
}

/// `lsp.ask`: one question to the task's language server, as `POST /sessions/:id/lsp`.
#[derive(Debug)]
pub struct Ask;
impl Command for Ask {
    const ID: &'static str = "lsp.ask";
    type Args = AskArgs;
    type Out = LspAnswer;
}

/// `lsp.install`: npm's servers for a language (TypeScript, Pyright) into `<home>/lsp`, one at a time.
#[derive(Debug)]
pub struct Install;
impl Command for Install {
    const ID: &'static str = "lsp.install";
    type Args = InstallArgs;
    type Out = Installed;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn answers_are_v1_json() {
        let none = LspAnswer::NoServer {
            lsp: (),
            lang: Some(Lang::Py),
            install: Some("Python".into()),
        };
        assert_eq!(
            serde_json::to_value(&none).ok(),
            Some(json!({ "lsp": null, "lang": "py", "install": "Python" }))
        );
        let none = LspAnswer::NoServer {
            lsp: (),
            lang: None,
            install: None,
        };
        assert_eq!(
            serde_json::to_value(&none).ok(),
            Some(json!({ "lsp": null, "lang": null, "install": null }))
        );
        let hits = LspAnswer::Hits {
            lsp: "TypeScript".into(),
            hits: vec![Hit {
                path: "a.js".into(),
                line: 1,
                col: 17,
                text: "x".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(&hits).ok(),
            Some(
                json!({ "lsp": "TypeScript", "hits": [{ "path": "a.js", "line": 1, "col": 17, "text": "x" }] })
            )
        );
        let ren = LspAnswer::Renamed {
            lsp: "Go".into(),
            files: vec!["a.go".into()],
            count: 2,
        };
        assert_eq!(
            serde_json::to_value(&ren).ok(),
            Some(json!({ "lsp": "Go", "files": ["a.go"], "count": 2 }))
        );
        let d = LspAnswer::Diagnostics {
            lsp: "Rust".into(),
            diagnostics: vec![Diagnostic {
                line: 2,
                col: 3,
                severity: Severity::Warning,
                message: "m".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(&d).ok(),
            Some(
                json!({ "lsp": "Rust", "diagnostics": [{ "line": 2, "col": 3, "severity": "warning", "message": "m" }] })
            )
        );
    }

    #[test]
    fn answers_read_back() {
        for v in [
            json!({ "lsp": null, "lang": "ts", "install": "TypeScript" }),
            json!({ "lsp": "TypeScript", "hover": "h" }),
            json!({ "lsp": "TypeScript", "items": [{ "label": "a", "detail": "", "insert": "a" }] }),
            json!({ "lsp": "TypeScript", "files": [], "count": 0 }),
            json!({ "lsp": "TypeScript", "hits": [] }),
            json!({ "lsp": "TypeScript", "diagnostics": [] }),
        ] {
            let a: Option<LspAnswer> = serde_json::from_value(v.clone()).ok();
            assert_eq!(a.and_then(|a| serde_json::to_value(a).ok()), Some(v));
        }
    }

    #[test]
    fn ask_args_flatten_the_route_body() {
        let a: Option<AskArgs> = serde_json::from_value(json!({ "id": "s1", "op": "rename", "path": "a.ts", "line": 2, "col": 3, "newName": "sum" })).ok();
        let a = a.map(|a| (a.id, a.request.op, a.request.line(), a.request.new_name));
        assert_eq!(a, Some(("s1".into(), Op::Rename, 2, Some("sum".into()))));
    }

    #[test]
    fn positions_default_to_one() {
        let r = LspRequest {
            op: Op::Hover,
            path: "a".into(),
            text: None,
            line: Some(0),
            col: None,
            new_name: None,
        };
        assert_eq!((r.line(), r.col()), (1, 1));
    }

    #[test]
    fn ops_and_langs_round_trip() {
        for op in Op::ALL {
            assert_eq!(Op::parse(op.as_str()), Some(op));
            assert_eq!(serde_json::to_value(op).ok(), Some(json!(op.as_str())));
        }
        for l in Lang::ALL {
            assert_eq!(Lang::parse(l.as_str()), Some(l));
        }
        assert_eq!(Op::parse("format"), None);
    }

    #[test]
    fn command_ids_are_their_permissions() {
        assert_eq!(Ask::ID.replace('.', ":"), permissions::ASK);
        assert_eq!(Install::ID.replace('.', ":"), permissions::INSTALL);
    }
}
