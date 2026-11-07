//! Just enough TOML for Codex's `[mcp_servers.<name>]` tables (v1 `codexServers`): strings, string
//! arrays and inline tables of strings, plus the `.env` and `.http_headers` sub-tables.

use std::collections::BTreeMap;

use serde_json::{Map, Value};

/// A basic string's escapes, as JSON reads them (TOML's are the same for what configs hold).
fn basic(raw: &str) -> Option<(String, usize)> {
    let b = raw.as_bytes();
    let mut i = 1;
    while i < b.len() {
        match b[i] {
            b'\\' => i += 2,
            b'"' => return serde_json::from_str::<String>(&raw[..=i]).ok().map(|s| (s, i + 1)),
            _ => i += 1,
        }
    }
    None
}

/// A value as a string: `"…"`, `'…'`, or the bare text.
fn str_value(v: &str) -> String {
    let v = v.trim();
    if v.starts_with('"') {
        return basic(v).map(|(s, _)| s).unwrap_or_default();
    }
    if let Some(rest) = v.strip_prefix('\'') {
        return rest.find('\'').map_or_else(|| rest.to_owned(), |end| rest[..end].to_owned());
    }
    v.to_owned()
}

/// Every quoted string in `v`, in order (`["a", 'b']`).
fn strings(v: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = v;
    while let Some(i) = rest.find(['"', '\'']) {
        rest = &rest[i..];
        if rest.starts_with('"') {
            let Some((s, used)) = basic(rest) else { break };
            out.push(s);
            rest = &rest[used..];
        } else {
            let Some(end) = rest[1..].find('\'') else { break };
            out.push(rest[1..=end].to_owned());
            rest = &rest[end + 2..];
        }
    }
    out
}

fn is_bare_key(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// `{ "A" = "x", B = 'y' }` → {A: x, B: y}.
fn table(v: &str) -> Map<String, Value> {
    let inner = v.trim().trim_start_matches('{').trim_end_matches('}');
    let mut out = Map::new();
    for part in split_top(inner) {
        let Some((k, val)) = part.split_once('=') else { continue };
        let k = k.trim().trim_matches('"');
        let val = val.trim();
        if !k.is_empty() && k.chars().all(|c| is_bare_key(c) || c == '.' || c == ' ') && (val.starts_with('"') || val.starts_with('\'')) {
            out.insert(k.to_owned(), Value::String(str_value(val)));
        }
    }
    out
}

/// Splits on commas outside quotes.
fn split_top(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut start, mut quote, mut esc) = (0, None::<char>, false);
    for (i, c) in s.char_indices() {
        match quote {
            Some('"') if esc => esc = false,
            Some('"') if c == '\\' => esc = true,
            Some(q) if c == q => quote = None,
            Some(_) => {}
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c == ',' => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            None => {}
        }
    }
    out.push(&s[start..]);
    out
}

/// `[mcp_servers.<name>]` or `[mcp_servers.<name>.env|http_headers]` → (name, sub-table).
fn header(line: &str) -> Option<(String, Option<&'static str>)> {
    let body = line.strip_prefix('[')?.trim_start().strip_prefix("mcp_servers.")?;
    let (name, rest) = if let Some(q) = body.strip_prefix('"') {
        let end = q.find('"')?;
        (q[..end].to_owned(), &q[end + 1..])
    } else {
        let end = body.find(|c: char| !is_bare_key(c)).unwrap_or(body.len());
        (body[..end].to_owned(), &body[end..])
    };
    if name.is_empty() {
        return None;
    }
    let (sub, rest) = if let Some(r) = rest.strip_prefix(".env") {
        (Some("env"), r)
    } else if let Some(r) = rest.strip_prefix(".http_headers") {
        (Some("http_headers"), r)
    } else {
        (None, rest)
    };
    rest.trim_start().starts_with(']').then_some((name, sub))
}

/// config.toml text → server name → `{command, args, env, url, bearer_token, http_headers}`.
pub fn codex_servers(text: &str) -> BTreeMap<String, Map<String, Value>> {
    let mut out: BTreeMap<String, Map<String, Value>> = BTreeMap::new();
    let mut cur: Option<(String, Option<&'static str>)> = None;
    for raw in text.lines() {
        let line = raw.trim_start();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some((name, sub)) = header(line) {
            out.entry(name.clone()).or_default();
            cur = Some((name, sub));
            continue;
        }
        if line.starts_with('[') {
            cur = None;
            continue;
        }
        let Some((name, sub)) = &cur else { continue };
        let Some((k, val)) = line.split_once('=') else { continue };
        let key = k.trim().replace('"', "");
        if key.is_empty() || !key.chars().all(is_bare_key) {
            continue;
        }
        let Some(server) = out.get_mut(name) else { continue };
        put(server, *sub, &key, val.trim());
    }
    out
}

fn put(server: &mut Map<String, Value>, sub: Option<&str>, key: &str, val: &str) {
    if let Some(sub) = sub {
        if let Value::Object(t) = server.entry(sub).or_insert_with(|| Value::Object(Map::new())) {
            t.insert(key.to_owned(), Value::String(str_value(val)));
        }
        return;
    }
    match key {
        "args" => {
            server.insert("args".into(), Value::Array(strings(val).into_iter().map(Value::String).collect()));
        }
        "env" | "http_headers" => {
            server.insert(key.into(), Value::Object(table(val)));
        }
        "command" | "url" | "bearer_token" => {
            server.insert(key.into(), Value::String(str_value(val)));
        }
        _ => {}
    }
}
