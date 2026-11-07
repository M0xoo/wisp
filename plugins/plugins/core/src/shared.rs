//! A shared file from a link (v1 routes/spells.js fetchShared): any https URL to the JSON, or
//! `gist:<id>` (the first `*.<kind>.json` in it), and the links a spell may open. Pure: the host
//! fetches what `Link` names and hands the text back.
use serde_json::Value;

pub const MAX_BYTES: usize = 512 * 1024;
pub const MAX_OPEN: usize = 20;
pub const FETCH_TIMEOUT_MS: u64 = 15_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Link {
    /// `https://api.github.com/gists/<id>`
    Gist(String),
    Url(String),
}

impl Link {
    /// The URL to GET, and whether GitHub's API accept header goes with it.
    pub fn url(&self) -> (String, bool) {
        match self {
            Self::Gist(id) => (format!("https://api.github.com/gists/{id}"), true),
            Self::Url(u) => (u.clone(), false),
        }
    }
}

fn gist_id(s: &str) -> Option<&str> {
    let id = s.strip_prefix("gist:").or_else(|| {
        let rest = s.strip_prefix("https://gist.github.com/")?;
        let rest = rest.strip_suffix('/').unwrap_or(rest);
        Some(rest.rsplit_once('/').map_or(rest, |(owner, id)| if owner.contains('/') || owner.is_empty() { "" } else { id }))
    })?;
    ((6..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_hexdigit())).then_some(id)
}

/// What a link names, or why it isn't one (`kind`: 'spell', 'plugin' or 'crew').
pub fn parse_link(src: &str, kind: &str) -> Result<Link, String> {
    let s = src.trim();
    if let Some(id) = gist_id(s) {
        return Ok(Link::Gist(id.to_owned()));
    }
    if s.get(..8).is_some_and(|p| p.eq_ignore_ascii_case("https://")) {
        return Ok(Link::Url(s.to_owned()));
    }
    Err(format!("A {kind} link is an https URL or gist:<id>."))
}

pub fn parse_json(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|e| format!("That isn't JSON: {e}"))
}

pub fn too_big(text: &str, kind: &str) -> Option<String> {
    (text.len() > MAX_BYTES).then(|| format!("That {} is bigger than 512 KB.", if kind == "crew" { "file" } else { kind }))
}

/// From a gist's API answer: the file to read (its content, or its raw URL when GitHub truncated it).
pub enum GistFile {
    Content(String),
    Raw(String),
}

pub fn gist_file(gist: &Value, kind: &str) -> Result<(GistFile, String), String> {
    let files: Vec<&Value> = gist.get("files").and_then(Value::as_object).map(|o| o.values().collect()).unwrap_or_default();
    let name = |f: &Value| f.get("filename").and_then(Value::as_str).unwrap_or("").to_lowercase();
    let file = files.iter().find(|f| name(f).ends_with(&format!(".{kind}.json"))).or_else(|| files.iter().find(|f| name(f).ends_with(".json"))).ok_or_else(|| format!("That gist has no .{kind}.json file."))?;
    let owner = gist.pointer("/owner/login").and_then(Value::as_str).unwrap_or("").to_owned();
    let truncated = file.get("truncated").and_then(Value::as_bool).unwrap_or(false);
    let raw = file.get("raw_url").and_then(Value::as_str);
    let out = match (truncated, raw) {
        (true, Some(u)) => GistFile::Raw(u.to_owned()),
        _ => GistFile::Content(file.get("content").and_then(Value::as_str).unwrap_or("").to_owned()),
    };
    Ok((out, owner))
}

/// Links to open: only http(s) without spaces or quotes, at most MAX_OPEN.
pub fn openable(urls: &Value) -> Result<Vec<String>, String> {
    let all: Vec<String> = match urls {
        Value::Array(a) => a.iter().map(crate::js::js_string).collect(),
        Value::Null => vec!["null".into()],
        v => vec![crate::js::js_string(v)],
    };
    let ok = |u: &String| {
        let lower = u.to_ascii_lowercase();
        let rest = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://"));
        rest.is_some_and(|r| !r.is_empty()) && !u.contains(|c: char| c.is_whitespace() || c == '"' || c == '\'')
    };
    let list: Vec<String> = all.into_iter().filter(ok).take(MAX_OPEN).collect();
    if list.is_empty() { Err("Nothing to open: only http(s) links.".into()) } else { Ok(list) }
}

/// How the default browser opens a link, per platform (v1 openUrls).
pub fn open_command(os: &str, url: &str) -> (String, Vec<String>) {
    match os {
        "macos" | "darwin" => ("open".into(), vec![url.into()]),
        "windows" | "win32" => ("cmd".into(), vec!["/c".into(), "start".into(), "\"\"".into(), url.into()]),
        _ => ("xdg-open".into(), vec![url.into()]),
    }
}
