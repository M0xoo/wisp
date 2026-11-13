//! Small text rules with v1's semantics: names, command lines, clipping, hosts, HTML escaping.

/// A name from anything: "GitHub MCP" → "`github_mcp`" (lowercase letters, digits and _, ≤ 40).
pub fn slug(s: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for ch in s.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_' {
            if gap {
                out.push('_');
            }
            gap = false;
            out.push(ch);
        } else {
            gap = true;
        }
    }
    if gap {
        out.push('_');
    }
    out.trim_matches('_').chars().take(40).collect()
}

/// A connector's name: 1–40 of `[a-z0-9_]` (Copilot names tools `<server>-<tool>`, so no dash).
pub fn valid_name(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// An env var or header name: `[A-Za-z_][A-Za-z0-9_-]{0,63}`.
pub fn valid_key(s: &str) -> bool {
    let b = s.as_bytes();
    match b.first() {
        Some(f) if f.is_ascii_alphabetic() || *f == b'_' => {
            b.len() <= 64 && b[1..].iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
        }
        _ => false,
    }
}

/// "npx -y @x/server --root '/a b'" → `["npx", "-y", "@x/server", "--root", "/a b"]`, as a shell
/// would split it (quotes group, an empty pair of quotes is an empty word; no escapes, no expansion).
pub fn split_command(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    let mut any = false;
    for ch in line.trim().chars() {
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            } else {
                cur.push(ch);
            }
        } else if ch == '"' || ch == '\'' {
            quote = Some(ch);
            any = true;
        } else if ch.is_whitespace() {
            if !cur.is_empty() || any {
                out.push(std::mem::take(&mut cur));
            }
            any = false;
        } else {
            cur.push(ch);
        }
    }
    if !cur.is_empty() || any {
        out.push(cur);
    }
    out
}

/// Whitespace collapsed, trimmed, and at most `n` characters (the last one an ellipsis).
pub fn clip(s: &str, n: usize) -> String {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() > n {
        let mut out: String = t.chars().take(n.saturating_sub(1)).collect();
        out.push('…');
        out
    } else {
        t
    }
}

/// `new URL(u).host`: host and a non-default port; "" when it isn't a URL.
pub fn host_of(u: &str) -> String {
    match url::Url::parse(u) {
        Ok(p) => match (p.host_str(), p.port()) {
            (Some(h), Some(port)) => format!("{h}:{port}"),
            (Some(h), None) => h.to_owned(),
            _ => String::new(),
        },
        Err(_) => String::new(),
    }
}

/// `new URL(u).origin`; "" when it isn't a URL.
pub fn origin_of(u: &str) -> String {
    url::Url::parse(u).map(|p| p.origin().ascii_serialization()).unwrap_or_default()
}

/// `&<>"'` as numeric entities, for the sign-in callback page.
pub fn esc_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' | '<' | '>' | '"' | '\'' => {
                out.push_str("&#");
                out.push_str(&u32::from(ch).to_string());
                out.push(';');
            }
            _ => out.push(ch),
        }
    }
    out
}

/// "s" for a count other than one.
pub fn plural(n: u32) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// Upper-cases the first character (v1 `replace(/^./, x => x.toUpperCase())`).
pub fn capitalize(s: &str) -> String {
    let mut it = s.chars();
    match it.next() {
        Some(f) if f != '\n' && f != '\r' => f.to_uppercase().chain(it).collect(),
        _ => s.to_owned(),
    }
}
