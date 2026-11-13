//! The answer's blocks drawn for a terminal (`term.block@1`, ADR-0022): one renderer per v1 block type,
//! width-aware, colour only when the style allows it. A type nobody draws gets its title and a
//! one-line summary with "Update wisp to see this", never raw JSON.

mod rich;
mod text;

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;
use wisp_cli_api::{Style, TermBlock};

use crate::term::{self, DIM, paint};

/// The block types wisp's protocol documents (plugins/runtime/core `BUILTIN_BLOCKS`; a test keeps
/// them in step).
pub const BUILTIN: &[&str] = &[
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

/// A line the host replaces with an inline image (it reads the file; the renderers do no IO):
/// `IMAGE_MARK` then the path.
pub const IMAGE_MARK: &str = "\u{1}image:";

pub(crate) fn s<'a>(b: &'a Value, k: &str) -> &'a str {
    b.get(k).and_then(Value::as_str).unwrap_or("")
}

pub(crate) fn items(b: &Value) -> &[Value] {
    b.get("items").and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// A JSON scalar as text (`42`, `true`, a string as it is).
pub(crate) fn text_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Null) | None => String::new(),
        Some(Value::Number(n)) => n.to_string(),
        Some(other) => other.to_string(),
    }
}

/// A block's optional title as a bold line.
pub(crate) fn title(st: &Style, b: &Value, out: &mut Vec<String>) {
    let t = s(b, "title");
    if !t.is_empty() {
        out.extend(term::wrap(&term::bold(st, t), st.width));
    }
}

/// A dim caption under a block.
pub(crate) fn caption(st: &Style, b: &Value, out: &mut Vec<String>) {
    let c = s(b, "caption");
    if !c.is_empty() {
        out.extend(term::wrap(c, st.width).into_iter().map(|l| paint(st, DIM, &l)));
    }
}

/// The built-in renderers.
#[derive(Debug, Default)]
pub struct Builtin;

impl TermBlock for Builtin {
    fn types(&self) -> &[&str] {
        BUILTIN
    }
    fn render(&self, b: &Value, st: &Style) -> Vec<String> {
        let ty = s(b, "type");
        match ty {
            "hero" => text::hero(b, st),
            "markdown" => crate::md::render(st, s(b, "text")),
            "steps" => text::steps(b, st),
            "checklist" => text::checklist(b, st),
            "stats" => text::stats(b, st),
            "tests" => text::tests(b, st),
            "code" => text::code(b, st),
            "terminal" => text::terminal(b, st),
            "callout" => text::callout(b, st),
            "question" => text::question(b, st),
            "blocked" => text::blocked(b, st),
            "actions" => text::actions(b, st),
            "next" => text::next(b, st),
            "files" => rich::files(b, st),
            "diff" => rich::diff(b, st),
            "commits" => rich::commits(b, st),
            "graph" => rich::graph(b, st),
            "tree" => rich::tree(b, st),
            "compare" => rich::compare(b, st),
            "flow" => rich::flow(b, st),
            "chart" => rich::chart(b, st),
            "image" | "video" => rich::media(b, st),
            "preview" => rich::preview(b, st),
            "doc" => rich::doc(b, st),
            "task" => rich::task(b, st),
            "stuff" => rich::stuff(b, st),
            "map" => rich::map(b, st),
            "app" => rich::app(b, st),
            _ => unknown(b, st),
        }
    }
}

/// A block type this build doesn't know: its title and a summary, never JSON.
pub fn unknown(b: &Value, st: &Style) -> Vec<String> {
    let ty = s(b, "type");
    let name =
        ["title", "label", "name"].iter().map(|k| s(b, k)).find(|x| !x.is_empty()).unwrap_or(if ty.is_empty() { "a block" } else { ty });
    let summary = ["summary", "text", "caption", "note"].iter().map(|k| s(b, k)).find(|x| !x.is_empty()).unwrap_or("");
    let mut out = term::wrap(&format!("▪ {}", term::bold(st, name)), st.width);
    if !summary.is_empty() {
        out.extend(term::hang("  ", summary, st.width));
    }
    out.push(paint(st, DIM, &term::truncate(&format!("  ({ty}: update wisp to see this)"), st.width)));
    out
}

/// Every renderer this terminal has: the built-ins, then what plugins contribute (a later one wins).
#[derive(Clone)]
pub struct Renderers {
    by_type: HashMap<String, Arc<dyn TermBlock>>,
}

impl std::fmt::Debug for Renderers {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut k: Vec<&String> = self.by_type.keys().collect();
        k.sort();
        f.debug_struct("Renderers").field("types", &k).finish()
    }
}

impl Default for Renderers {
    fn default() -> Self {
        Self::builtin()
    }
}

impl Renderers {
    pub fn builtin() -> Self {
        let mut r = Self { by_type: HashMap::new() };
        r.add(Arc::new(Builtin));
        r
    }

    /// A contribution to `term.block@1`.
    #[allow(clippy::needless_pass_by_value)] // the registry keeps a clone per type
    pub fn add(&mut self, t: Arc<dyn TermBlock>) {
        for ty in t.types() {
            self.by_type.insert((*ty).to_owned(), t.clone());
        }
    }

    pub fn has(&self, ty: &str) -> bool {
        self.by_type.contains_key(ty)
    }

    pub fn block(&self, b: &Value, st: &Style) -> Vec<String> {
        match self.by_type.get(s(b, "type")) {
            Some(r) => r.render(b, st),
            None => unknown(b, st),
        }
    }

    /// The whole answer: blocks one after the other, a blank line between.
    pub fn answer(&self, blocks: &[Value], st: &Style) -> Vec<String> {
        let mut out = Vec::new();
        for b in blocks {
            let lines = self.block(b, st);
            if lines.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push(String::new());
            }
            out.extend(lines);
        }
        out
    }
}
