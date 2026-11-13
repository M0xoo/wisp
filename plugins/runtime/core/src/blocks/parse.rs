//! Reading an agent's answer back (v1 `server/protocol.js` `parsePresentation`): the last fenced `wisp`
//! block's JSON, forgiving the slips models make (trailing commas, smart quotes, a stray quote in a
//! terminal output, a lost closing brace), and plain markdown when there is none.
//!
//! It runs on every finished turn, so it does v1's work and no more: one pass to find the openers, a
//! bracket match per opener, and the slower salvage only when the JSON is broken.

use serde_json::{Map, Value};

use super::js;

/// Bumped when the parser changes: a stored presentation from an older one is rebuilt lazily.
pub const PARSER_VERSION: u32 = 1;

// Only the opener is matched. The closing fence can't be: the JSON itself often contains ``` (a
// markdown block with a code sample), and a lazy match would cut it there.
const OPEN: &str = "```wisp";
const FENCE: &str = "```";
const EMPTY: &str = "_The agent finished without a message._";

/// An answer, read.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Parsed {
    /// every block is an object with a string `type`
    pub blocks: Vec<Value>,
    /// prose ahead of the wisp block
    pub notes: Option<String>,
    /// the block's top-level topic, trimmed (names the task when no hero does)
    pub topic: Option<String>,
    /// the agent ignored or broke the protocol: `blocks` is its answer as one markdown block
    pub fallback: bool,
}

/// v1's `parsePresentation(text)`.
pub fn parse(text: &str) -> Parsed {
    let opens = openers(text);
    for &(at, body) in opens.iter().rev() {
        if let Some(p) = from_block(text, at, read_json(&text[body..])) {
            return p;
        }
    }
    // The agent ignored (or broke) the protocol: its answer as plain markdown, with any broken wisp
    // payload kept verbatim in a fence rather than half-rendered as prose.
    let md = match opens.last() {
        Some(&(at, body)) => {
            let prose = js::trim(&text[..at]);
            let raw = strip_close(&text[body..]);
            js::trim(&format!("{prose}\n\n`````json\n{raw}\n`````")).to_owned()
        }
        None => js::trim(text).to_owned(),
    };
    Parsed { fallback: true, blocks: vec![markdown(if md.is_empty() { EMPTY.to_owned() } else { md })], ..Parsed::default() }
}

/// The first `hero` block.
pub fn hero_of(blocks: &[Value]) -> Option<&Value> {
    blocks.iter().find(|b| b.get("type").and_then(Value::as_str) == Some("hero"))
}

/// Where the JSON value at the start of `src` ends (bracket matching that respects strings and
/// escapes): the byte index just past its closing bracket. None when `src` doesn't start with `{` or
/// `[` (after whitespace) or the brackets never close.
pub fn json_end(src: &str) -> Option<usize> {
    let start = js::skip_ws(src, 0);
    let bytes = src.as_bytes();
    if !matches!(bytes.get(start), Some(b'{' | b'[')) {
        return None;
    }
    let mut depth = 0_usize;
    let mut in_str = false;
    let mut i = start;
    while let Some(&c) = bytes.get(i) {
        if in_str {
            match c {
                b'\\' => i += 1,
                b'"' => in_str = false,
                _ => {}
            }
        } else {
            match c {
                b'"' => in_str = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(i + 1);
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }
    None
}

/// The ```` ```wisp…\n ```` openers, in order: (where the fence starts, where its body starts).
fn openers(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(p) = text[from..].find(OPEN).map(|p| from + p) {
        let Some(nl) = text[p + OPEN.len()..].find('\n') else {
            break;
        };
        let body = p + OPEN.len() + nl + 1;
        out.push((p, body));
        from = body;
    }
    out
}

/// The answer from one opener's JSON, or None to try the opener before it.
fn from_block(text: &str, at: usize, json: Option<Value>) -> Option<Parsed> {
    let json = json?;
    // A top-level topic names the task when no hero does (runner finishTurn).
    let topic = match &json {
        Value::Object(o) => o.get("topic").and_then(Value::as_str).map(js::trim).filter(|t| !t.is_empty()).map(str::to_owned),
        _ => None,
    };
    let extra = js::trim(&text[..at]);
    let blocks = match json {
        Value::Array(a) => Some(Some(a)),
        Value::Object(mut o) => o.remove("blocks").map(|b| match b {
            Value::Array(a) => Some(a),
            _ => None,
        }),
        _ => None,
    };
    match blocks {
        Some(Some(list)) if !list.is_empty() => Some(Parsed {
            blocks: list.into_iter().filter(|b| b.get("type").is_some_and(Value::is_string)).collect(),
            notes: (!extra.is_empty()).then(|| extra.to_owned()),
            topic,
            fallback: false,
        }),
        // A quick answer: plain text, then a wisp block with only its topic. The text is the answer, as
        // it is (not a slip, so no fallback), and the block shows nothing.
        None | Some(Some(_)) if topic.is_some() => {
            let text = if extra.is_empty() { EMPTY } else { extra };
            Some(Parsed { blocks: vec![markdown(text.to_owned())], topic, ..Parsed::default() })
        }
        _ => None,
    }
}

fn markdown(text: String) -> Value {
    let mut m = Map::new();
    m.insert("type".to_owned(), Value::String("markdown".to_owned()));
    m.insert("text".to_owned(), Value::String(text));
    Value::Object(m)
}

/// v1's `raw.replace(/\n?```\s*$/, '')`: the closing fence (and the newline before it) off the end.
fn strip_close(raw: &str) -> &str {
    match js::trim_end(raw).strip_suffix(FENCE) {
        Some(rest) => rest.strip_suffix('\n').unwrap_or(rest),
        None => raw,
    }
}

// The JSON value at the start of `src` (the body after a ```wisp opener). First its end by bracket
// matching, respecting strings; if that fails (a stray unescaped quote), every ``` after it as the
// closing fence; then block by block. None is v1's falsy result.
fn read_json(src: &str) -> Option<Value> {
    if let Some(end) = json_end(src)
        && let Some(json) = try_json(&src[..end]).filter(|v| js::truthy(Some(v)))
    {
        return Some(json);
    }
    let mut at = src.find(FENCE);
    while let Some(i) = at {
        if let Some(json) = try_json(&src[..i]).filter(|v| js::truthy(Some(v))) {
            return Some(json);
        }
        at = src[i + 3..].find(FENCE).map(|k| i + 3 + k);
    }
    salvage_blocks(src)
}

// Last resort: the blocks array one element at a time, so one malformed block (an unescaped quote in a
// terminal output) costs that block rather than the whole answer.
fn salvage_blocks(src: &str) -> Option<Value> {
    let mut i = salvage_start(src)?;
    let mut blocks = Vec::new();
    let mut bad = 0_usize;
    while i < src.len() {
        i = src[i..].char_indices().find(|&(_, c)| c != ',' && !js::is_ws(c)).map_or(src.len(), |(k, _)| i + k);
        if !src[i..].starts_with('{') {
            break;
        }
        let Some(len) = json_end(&src[i..]) else {
            // The last block is missing closing braces (a common slip after a long string): close it.
            match close_braces(&src[i..]) {
                Some(fixed) => blocks.push(fixed),
                None => bad += 1,
            }
            break;
        };
        // A bracket count that ends early on a `]` usually means a block lost a closing brace.
        let piece = &src[i..i + len];
        match try_json(piece).filter(|v| js::truthy(Some(v))).or_else(|| close_braces(piece)) {
            Some(block @ (Value::Object(_) | Value::Array(_))) => blocks.push(block),
            _ => bad += 1,
        }
        i += len;
    }
    if blocks.is_empty() {
        return None;
    }
    if bad > 0 {
        let mut m = Map::new();
        m.insert("type".to_owned(), Value::String("callout".to_owned()));
        m.insert("tone".to_owned(), Value::String("warn".to_owned()));
        m.insert("title".to_owned(), Value::String(format!("{bad} block{} skipped", if bad > 1 { "s" } else { "" })));
        m.insert("text".to_owned(), Value::String("Part of the agent's answer was malformed JSON and could not be shown.".to_owned()));
        blocks.push(Value::Object(m));
    }
    Some(Value::Array(blocks))
}

/// v1's `/^\s*(\{\s*"blocks"\s*:\s*)?\[/`: where the first block would start.
fn salvage_start(src: &str) -> Option<usize> {
    let s = js::skip_ws(src, 0);
    let rest = &src[s..];
    if rest.starts_with('[') {
        return Some(s + 1);
    }
    if !rest.starts_with('{') {
        return None;
    }
    let j = js::skip_ws(src, s + 1);
    if !src[j..].starts_with("\"blocks\"") {
        return None;
    }
    let j = js::skip_ws(src, j + "\"blocks\"".len());
    if !src[j..].starts_with(':') {
        return None;
    }
    let j = js::skip_ws(src, j + 1);
    src[j..].starts_with('[').then_some(j + 1)
}

// A block whose closing braces went missing at the end of the answer: cut it at each of its last few
// `}` and add up to three more until it parses. None when that doesn't help.
fn close_braces(src: &str) -> Option<Value> {
    let body = js::trim_end(src.find(FENCE).map_or(src, |p| &src[..p]));
    let mut cut = body.len();
    let mut attempt = String::with_capacity(body.len() + 3);
    for _ in 0..6 {
        if cut == 0 {
            break;
        }
        cut = body[..cut].rfind('}')?;
        attempt.clear();
        attempt.push_str(&body[..=cut]);
        for _ in 1..=3 {
            attempt.push('}');
            if let Some(json) = try_json(&attempt)
                && json.get("type").is_some_and(Value::is_string)
            {
                return Some(json);
            }
        }
    }
    None
}

fn try_json(src: &str) -> Option<Value> {
    if let Ok(v) = serde_json::from_str(src) {
        return Some(v);
    }
    // Common LLM slips: trailing commas, smart quotes.
    serde_json::from_str(&relaxed(src)?).ok()
}

/// v1's `src.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"')`, or None when it changes nothing.
fn relaxed(src: &str) -> Option<String> {
    let trailing_comma = |at: usize| matches!(src.as_bytes()[js::skip_ws(src, at + 1)..].first(), Some(b'}' | b']'));
    let dirty = src.contains(['“', '”']) || src.match_indices(',').any(|(i, _)| trailing_comma(i));
    if !dirty {
        return None;
    }
    let mut out = String::with_capacity(src.len());
    let mut chars = src.char_indices();
    while let Some((i, c)) = chars.next() {
        match c {
            ',' if trailing_comma(i) => {
                // drop the comma and the whitespace after it; the bracket is copied next
                let next = js::skip_ws(src, i + 1);
                while chars.as_str().len() > src.len() - next {
                    chars.next();
                }
            }
            '“' | '”' => out.push('"'),
            c => out.push(c),
        }
    }
    Some(out)
}
