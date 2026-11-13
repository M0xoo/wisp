//! The system prompt every task's agent gets (v1 `server/protocol.js` `systemPrompt`, `blockDocs`). The
//! text is a contract (plan §6.9): `tests/goldens/system-prompt*.txt` pin it byte for byte.

use super::protocol_text::{APP_BLOCK, ASK_BLOCK, ASK_TOOL, GRAPH_BLOCK, PLAIN_FINAL, PROTOCOL, WATCH_TOOL};
use super::text::is_js_space;

/// v1's default ask tool name (Claude Code's view of wisp's injected MCP server).
pub const DEFAULT_ASK_TOOL: &str = "mcp__wisp__ask_user";

/// A block type a plugin adds (`runtime.block@1`), as the agent is told about it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlockDoc {
    pub type_name: String,
    pub doc: String,
    /// who adds it ("From the user's spell <from>.")
    pub from: String,
}

/// v1's `systemPrompt({ askTool, ask, extraBlocks, apps, watch, blocks })`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemOpts {
    /// how the harness names wisp's ask tool; None: it can't take MCP (ask with a question block)
    pub ask_tool: Option<String>,
    /// replaces the ask guidance outright (a subagent has nobody to ask)
    pub ask: Option<String>,
    pub extra_blocks: Vec<BlockDoc>,
    /// offer the `app` block
    pub apps: bool,
    /// offer `wisp_watch` (where wisp's tools are)
    pub watch: bool,
    /// false: a plain markdown answer instead of a wisp block
    pub blocks: bool,
}

impl Default for SystemOpts {
    fn default() -> Self {
        Self { ask_tool: Some(DEFAULT_ASK_TOOL.to_owned()), ask: None, extra_blocks: Vec::new(), apps: false, watch: false, blocks: true }
    }
}

/// `tool.replace(/ask_user$/, name)`: the ask tool's sibling on the same server.
fn sibling(tool: &str, name: &str) -> String {
    match tool.strip_suffix("ask_user") {
        Some(prefix) => format!("{prefix}{name}"),
        None => tool.to_owned(),
    }
}

fn ask_tool_text(tool: &str, watch: bool) -> String {
    let mut out = ASK_TOOL.replace("{tool}", tool);
    for name in ["resume_later", "wisp_tag", "wisp_pr", "wisp_session", "wisp_save"] {
        out = out.replace(&format!("{{{name}}}"), &sibling(tool, name));
    }
    if watch {
        out.push_str(&WATCH_TOOL.replace("{wisp_watch}", &sibling(tool, "wisp_watch")));
    }
    out
}

fn stub(type_name: &str, what: &str, tool: &str) -> String {
    format!(
        "- {{\"type\":\"{type_name}\",…}} {what} Read its fields with `wisp_blocks` ({}) before you use it.",
        sibling(tool, "wisp_blocks")
    )
}

/// `b.doc.trim().replace(/\}\s+(?=\S)/, '}\n  ')`: a doc that starts with its JSON shape gets its prose on
/// the next line.
fn shape_first(doc: &str) -> String {
    let mut search = 0;
    while let Some(off) = doc[search..].find('}') {
        let at = search + off;
        let rest = &doc[at + 1..];
        let ws = rest.len() - rest.trim_start_matches(is_js_space).len();
        if ws > 0 && ws < rest.len() {
            return format!("{}}}\n  {}", &doc[..at], &rest[ws..]);
        }
        search = at + 1;
    }
    doc.to_owned()
}

fn extra_doc(b: &BlockDoc) -> String {
    let doc = b.doc.trim_matches(is_js_space);
    let body = if doc.starts_with('{') { shape_first(doc) } else { format!("{{\"type\":\"{}\"}} {}", b.type_name, b.doc) };
    format!("- {body}\n  (From the user's spell {}.)", b.from)
}

/// v1's `plain(out)`: the final-message section swapped for plain markdown, and the block-only hints
/// worded for prose.
fn plain(out: &str) -> String {
    let mut s = match out.find("## Your final message") {
        Some(at) => format!("{}{PLAIN_FINAL}", &out[..at]),
        None => out.to_owned(),
    };
    for (from, to) in [
        ("end with a \"question\" block instead", "end by asking it"),
        ("end with a \"question\" block (2–4 options)", "end by asking it, with 2–4 options"),
        ("\n  Show each task you name in the answer as a \"task\" block so the user can open it.", ""),
        (" and show its \"stuff\" block", ""),
    ] {
        s = s.replacen(from, to, 1);
    }
    s
}

/// The system prompt for one run.
pub fn system_prompt(o: &SystemOpts) -> String {
    let ask = o.ask.as_deref().filter(|a| !a.is_empty());
    let tool = o.ask_tool.as_deref().filter(|t| !t.is_empty());
    let tools = tool.filter(|_| ask.is_none());
    let ask_text = match (ask, tool) {
        (Some(a), _) => a.to_owned(),
        (None, Some(t)) => ask_tool_text(t, o.watch),
        (None, None) => ASK_BLOCK.to_owned(),
    };
    let graph = tools
        .map_or_else(|| GRAPH_BLOCK.to_owned(), |t| stub("graph", "Branch graph: merge conflicts, a rebase, where branches diverged.", t));
    let out = PROTOCOL.replacen("{{ASK}}", &ask_text, 1).replacen("{{GRAPH}}", &graph, 1);
    if !o.blocks {
        return plain(&out);
    }
    let mut docs: Vec<String> = Vec::new();
    if o.apps {
        docs.push(tools.map_or_else(
            || APP_BLOCK.to_owned(),
            |t| stub("app", "A small interactive page in your answer, for when the user has to try, tune, pick several or explore.", t),
        ));
    }
    docs.extend(o.extra_blocks.iter().map(extra_doc));
    if docs.is_empty() {
        return out;
    }
    out.replacen("\nStrings must be valid JSON", &format!("\n{}\n\nStrings must be valid JSON", docs.join("\n")), 1)
}

/// What `wisp_blocks` answers: the full docs of the block types asked for.
pub fn block_docs(types: &[String]) -> String {
    let mut want: Vec<String> = Vec::new();
    for t in types {
        let t = t.trim_matches(is_js_space).to_lowercase();
        if !want.contains(&t) {
            want.push(t);
        }
    }
    let full = |t: &str| match t {
        "graph" => Some(GRAPH_BLOCK),
        "app" => Some(APP_BLOCK),
        _ => None,
    };
    let mut docs: Vec<String> = want.iter().filter_map(|t| full(t)).map(str::to_owned).collect();
    let rest: Vec<String> = want.iter().filter(|t| full(t).is_none()).map(|t| format!("\"{t}\"")).collect();
    if !rest.is_empty() {
        docs.push(format!(
            "No long docs for {}: graph and app have them; the others are described in full in your instructions.",
            rest.join(", ")
        ));
    }
    docs.join("\n\n")
}
