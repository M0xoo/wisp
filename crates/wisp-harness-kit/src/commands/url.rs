//! The host a URL points at, as WHATWG's `new URL(…)` reads it (v1 `host()`): only the part v1 used,
//! the hostname and the port, with the URL parser's refusals (an empty or malformed host) kept, since
//! v1 then fell back to the raw text.

use super::clip;

/// Code points a domain may not hold (WHATWG "forbidden domain code point").
fn forbidden(c: char) -> bool {
    matches!(c, '\0'..='\u{1f}' | ' ' | '#' | '/' | ':' | '<' | '>' | '?' | '@' | '[' | '\\' | ']' | '^' | '|' | '%' | '\u{7f}')
}

/// (hostname, port without the scheme's default), or None where `new URL` throws.
fn parse(url: &str) -> Option<(String, String)> {
    // Leading and trailing C0 controls and spaces go; tabs and newlines inside are removed.
    let s: String = url.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    let colon = s.find(':')?;
    let scheme = s[..colon].to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" => "80",
        "https" => "443",
        _ => return None,
    };
    let rest = s[colon + 1..].trim_start_matches(['/', '\\']);
    let end = rest.find(['/', '\\', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let hostport = authority.rfind('@').map_or(authority, |at| &authority[at + 1..]);
    let (host, port) = if hostport.starts_with('[') {
        let close = hostport.find(']')?;
        let after = &hostport[close + 1..];
        let port = if after.is_empty() { "" } else { after.strip_prefix(':')? };
        (hostport[..=close].to_ascii_lowercase(), port)
    } else {
        match hostport.rfind(':') {
            Some(i) => (hostport[..i].to_owned(), &hostport[i + 1..]),
            None => (hostport.to_owned(), ""),
        }
    };
    if !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port = port.trim_start_matches('0');
    let port = if port.is_empty() && !host.is_empty() && authority.ends_with(":0") { "0" } else { port };
    if port.parse::<u32>().is_ok_and(|p| p > 65_535) {
        return None;
    }
    if host.is_empty() || (!host.starts_with('[') && host.chars().any(forbidden)) {
        return None;
    }
    let host = host.to_lowercase();
    let port = if port == default_port { String::new() } else { port.to_owned() };
    Some((host, port))
}

/// The host a URL points at; localhost keeps its port, since that's what tells dev servers apart.
pub(super) fn host(url: &str) -> String {
    let full = if url.starts_with("http:") || url.starts_with("https:") { url.to_owned() } else { format!("https://{url}") };
    match parse(&full) {
        Some((hostname, port)) => {
            let local = hostname == "localhost" || hostname.starts_with("127.");
            let name = hostname.strip_prefix("www.").unwrap_or(&hostname);
            if local && !port.is_empty() { format!("{name}:{port}") } else { name.to_owned() }
        }
        None => clip(url, 40),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hosts() {
        assert_eq!(host("https://www.example.com/a?b"), "example.com");
        assert_eq!(host("localhost:3000/x"), "localhost:3000");
        assert_eq!(host("http://127.0.0.1:80/"), "127.0.0.1");
        assert_eq!(host("http://Example.COM:8080"), "example.com");
        assert_eq!(host("https://"), "https://");
        assert_eq!(host("http://a b.com"), "http://a b.com");
    }
}
