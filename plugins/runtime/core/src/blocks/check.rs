//! Checking parsed blocks (plan §6.9: the agent protocol is a contract). v1 kept every block with a
//! string type and let each renderer ignore what it couldn't use; that stays, so old answers render as
//! they did. On top: block types a plugin contributes (`runtime.block@1`) get its check, which may
//! normalise or drop a block, and the built-in types are known so a typo shows up in the problems.

use std::sync::Arc;

use serde_json::Value;
use wisp_runtime_api::model::Presentation;
use wisp_runtime_api::points::BlockType;

use super::js;
use super::parse::{PARSER_VERSION, parse};

/// The block types the protocol prompt documents, plus what wisp writes itself.
pub const BUILTIN_BLOCKS: &[&str] = &[
    "hero",
    "markdown",
    "steps",
    "stats",
    "files",
    "diff",
    "tests",
    "commits",
    "graph",
    "tree",
    "code",
    "compare",
    "flow",
    "chart",
    "terminal",
    "checklist",
    "callout",
    "image",
    "video",
    "preview",
    "map",
    "doc",
    "task",
    "stuff",
    "question",
    "blocked",
    "actions",
    "next",
    "app",
];

const STATUS: &[&str] = &["done", "partial", "blocked", "info"];

pub fn is_builtin(type_name: &str) -> bool {
    BUILTIN_BLOCKS.contains(&type_name)
}

/// The blocks kept (in order) and what was dropped or looks wrong, for logs and goldens (the user never
/// sees these). A contributed type wins over a built-in of the same name; of two contributions with
/// one name, the later one.
pub fn check(blocks: Vec<Value>, contributed: &[Arc<dyn BlockType>]) -> (Vec<Value>, Vec<String>) {
    let mut problems = Vec::new();
    let mut kept = Vec::with_capacity(blocks.len());
    for (i, block) in blocks.into_iter().enumerate() {
        let ty = block.get("type").and_then(Value::as_str).unwrap_or("undefined").to_owned();
        if let Some(own) = contributed.iter().rev().find(|c| c.type_name() == ty) {
            let Value::Object(mut map) = block else {
                problems.push(format!("block {i} ({ty}) dropped: not an object"));
                continue;
            };
            match own.check(&mut map) {
                Ok(()) => {
                    map.insert("type".to_owned(), Value::String(ty));
                    kept.push(Value::Object(map));
                }
                Err(reason) => problems.push(format!("block {i} ({ty}) dropped: {reason}")),
            }
            continue;
        }
        if !is_builtin(&ty) {
            problems.push(format!("block {i}: unknown type \"{ty}\""));
        } else if ty == "hero"
            && let Some(status) = block.get("status").map(js::string)
            && !STATUS.contains(&status.as_str())
        {
            problems.push(format!("block {i} (hero): status \"{status}\" is none of done, partial, blocked, info"));
        }
        kept.push(block);
    }
    (kept, problems)
}

/// An answer's text as it is stored: parsed, checked, stamped with the parser version.
pub fn presentation(text: &str, contributed: &[Arc<dyn BlockType>]) -> Presentation {
    let parsed = parse(text);
    let (blocks, dropped) = check(parsed.blocks, contributed);
    Presentation { blocks, v: PARSER_VERSION, dropped, topic: parsed.topic, notes: parsed.notes, fallback: parsed.fallback }
}
