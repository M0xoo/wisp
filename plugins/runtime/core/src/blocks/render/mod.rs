//! Presentation → plain markdown (v1 `server/render.js`), for places that can't run the web UI: the CLI,
//! MCP clients, webhooks, chat apps, a lead reading its delegates' reports. Lossy by design (no
//! animation, no syntax colours), never fails: a block that can't be rendered renders as nothing.
//! Output is byte for byte v1's (`tests/goldens/blocks-real.md` pins it), JavaScript's quirks included:
//! where v1 threw on a block (a `null` item), that block is left out here too.

mod kinds;
mod rich;

use std::fmt;

use serde_json::{Map, Value};
use wisp_runtime_api::model::{Activity, FileChange, Session, Turn, TurnStatus};

use super::js;

/// A contributed block type's summary template, by type.
pub type SummaryFn = dyn Fn(&str) -> Option<String>;

/// What a block may read besides itself: the turn it belongs to, and the contributed block types.
#[derive(Clone, Copy, Default)]
pub struct Context<'a> {
    /// the turn's captured edits, which `diff` blocks without their own snippet show
    pub changes: &'a [FileChange],
    /// what the user decided about the turn's blocked actions ("allowed"), shown on `blocked`
    pub approval: Option<&'a str>,
    /// a contributed block type's text stand-in: its summary template ("{title}: {count} rows")
    pub summary: Option<&'a SummaryFn>,
}

impl fmt::Debug for Context<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Context")
            .field("changes", &self.changes.len())
            .field("approval", &self.approval)
            .field("summary", &self.summary.is_some())
            .finish()
    }
}

/// A question the agent is waiting on (v1 `session.ask`).
#[derive(Debug, Clone, Copy, Default)]
pub struct Ask<'a> {
    pub question: &'a str,
    pub context: Option<&'a str>,
    pub options: &'a [String],
    /// it asks for a permission rather than an answer
    pub permission: bool,
}

/// What a session's markdown reads that the session and turn rows don't carry.
#[derive(Debug, Clone, Copy, Default)]
pub struct SessionView<'a> {
    /// the last turn's activity (read while it runs)
    pub activity: &'a [Activity],
    /// the last turn's blocks' context (captured edits, approval, contributed types)
    pub cx: Context<'a>,
    pub ask: Option<Ask<'a>>,
    /// lines other plugins add once the turn is done (wisp.worktrees: where the changes are, the PR)
    pub notes: &'a [String],
}

/// v1 threw while rendering a block: the block renders as nothing.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Thrown;

pub(crate) type Out = Result<String, Thrown>;

/// An item read the way v1 read it: null or undefined throws, a primitive or an array has no fields.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Fields<'a>(Option<&'a Map<String, Value>>);

impl<'a> Fields<'a> {
    pub(crate) fn of(m: &'a Map<String, Value>) -> Self {
        Self(Some(m))
    }

    /// `x.k` on a value that must not be null or undefined
    pub(crate) fn item(v: Option<&'a Value>) -> Result<Self, Thrown> {
        match v {
            None | Some(Value::Null) => Err(Thrown),
            Some(Value::Object(m)) => Ok(Self(Some(m))),
            Some(_) => Ok(Self(None)),
        }
    }

    pub(crate) fn get(self, k: &str) -> Option<&'a Value> {
        self.0.and_then(|m| m.get(k))
    }

    /// `if (x.k)`
    pub(crate) fn has(self, k: &str) -> bool {
        js::truthy(self.get(k))
    }

    /// v1's `str(x.k)`
    pub(crate) fn s(self, k: &str) -> String {
        js::str_of(self.get(k))
    }

    /// `${x.k ? `<pre>${x.k}<post>` : ''}`
    pub(crate) fn opt(self, k: &str, pre: &str, post: &str) -> String {
        if self.has(k) {
            format!("{pre}{}{post}", self.s(k))
        } else {
            String::new()
        }
    }
}

/// `v?.k`
pub(crate) fn prop<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a Value> {
    v.and_then(|v| v.get(k))
}

/// v1's `list(v)`
pub(crate) fn list(v: Option<&Value>) -> &[Value] {
    match v {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

/// v1's `fence(text, lang)`: longer than any run of backticks inside it.
pub(crate) fn fence(text: &str, lang: &str) -> String {
    let (mut longest, mut run) = (0, 0);
    for b in text.bytes() {
        if b == b'`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let ticks = "`".repeat(3.max(longest + 1));
    let body = text.strip_suffix('\n').unwrap_or(text);
    format!("{ticks}{lang}\n{body}\n{ticks}")
}

/// v1's `blocksToMarkdown(blocks, turn)`.
pub fn blocks_to_markdown(blocks: &[Value], cx: &Context<'_>) -> String {
    let mut out = String::new();
    for b in blocks {
        let md = render(b, cx).unwrap_or_default();
        if !md.is_empty() {
            if !out.is_empty() {
                out.push_str("\n\n");
            }
            out.push_str(&md);
        }
    }
    out
}

fn render(b: &Value, cx: &Context<'_>) -> Out {
    let ty = b.get("type").and_then(Value::as_str);
    if let (Some(ty), Value::Object(m)) = (ty, b)
        && let Some(out) = kinds::render(ty, Fields::of(m), cx)
    {
        return out;
    }
    if let Some(ty) = ty
        && let Some(tpl) = cx.summary.and_then(|f| f(ty))
        && !tpl.is_empty()
    {
        return Ok(fill_fields(&tpl, b));
    }
    Ok(fence(&js::stringify_pretty(b), "json"))
}

// A contributed block's summary template: "{title}" and "{a.b}" read the block's fields.
fn fill_fields(tpl: &str, b: &Value) -> String {
    let mut out = String::with_capacity(tpl.len());
    let mut rest = tpl;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let path_len = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.'))
            .unwrap_or(after.len());
        let starts_ok = after.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_');
        if starts_ok && after[path_len..].starts_with('}') {
            out.push_str(&js::str_of(lookup(b, &after[..path_len]).as_ref()));
            rest = &after[path_len + 1..];
        } else {
            out.push('{');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// `k.split('.').reduce((x, y) => x?.[y], b)`: object keys, array indices and `length`.
fn lookup(b: &Value, path: &str) -> Option<Value> {
    let mut at = b.clone();
    for k in path.split('.') {
        at = match &at {
            Value::Object(m) => m.get(k)?.clone(),
            Value::Array(a) if k == "length" => Value::from(a.len()),
            Value::Array(a) => a.get(index(k)?)?.clone(),
            Value::String(s) if k == "length" => Value::from(s.encode_utf16().count()),
            Value::String(s) => Value::String(
                char::from_u32(u32::from(s.encode_utf16().nth(index(k)?)?))?.to_string(),
            ),
            _ => return None,
        };
    }
    Some(at)
}

/// A canonical array index ("0", "12"; not "01" or "+1").
fn index(k: &str) -> Option<usize> {
    (k == "0" || (!k.starts_with('0') && k.bytes().all(|b| b.is_ascii_digit())))
        .then(|| k.parse().ok())
        .flatten()
}

/// v1's `sessionToMarkdown(session)`: the newest turn's presentation (or what a running one is doing),
/// a pending question if the agent is blocked on one, and the notes other plugins add once it's done.
/// v2's rows don't carry the ask, the activity or the captured edits: they come in `view`.
pub fn session_to_markdown(_session: &Session, turns: &[Turn], view: &SessionView<'_>) -> String {
    let turn = turns.last();
    let running = turn.is_some_and(|t| t.status == TurnStatus::Running);
    let mut out: Vec<String> = Vec::new();
    if running {
        let label = view
            .activity
            .iter()
            .rev()
            .find(|a| !matches!(a, Activity::Text { .. } | Activity::ToolOutput { .. }))
            .and_then(|a| match a {
                Activity::Tool { label, .. } if !label.is_empty() => Some(label.as_str()),
                _ => None,
            })
            .unwrap_or("starting up");
        out.push(format!("_Working… ({label})_"));
    } else if let Some(p) = turn.and_then(|t| t.presentation.as_ref()) {
        out.push(blocks_to_markdown(&p.blocks, &view.cx));
    }
    if let Some(ask) = view.ask {
        let who = if ask.permission {
            "🔒 The agent needs your approval"
        } else {
            "❓ The agent is waiting for your answer"
        };
        let context = ask
            .context
            .filter(|c| !c.is_empty())
            .map(|c| format!("\n\n{c}"))
            .unwrap_or_default();
        out.push(format!("**{who}:** {}{context}", ask.question));
        if !ask.options.is_empty() {
            let lines: Vec<String> = ask
                .options
                .iter()
                .enumerate()
                .map(|(i, x)| format!("{}. {x}", i + 1))
                .collect();
            out.push(lines.join("\n"));
        }
    }
    if !running {
        out.extend(view.notes.iter().filter(|n| !n.is_empty()).cloned());
    }
    out.join("\n\n")
}
