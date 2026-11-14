//! Where a shared crew comes from (ADR-0052): a share link (wisp Cloud, the way v2 shares a crew), v1's gist
//! (`gist:<id>` or a gist.github.com page), or any https `.crew.json`. Pure: the host fetches what this names and
//! hands the answer back here to find the crew file in it.

use serde_json::Value;

use crate::error::{Result, bad};

/// The largest crew file taken in from a link (a crew of 12 with full kits stays well under it).
pub const MAX_FETCHED: usize = 1 << 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// a share link (`https://<grid>/s/<id>`, `wisp://open/<id>`, `grid://<handle>/<name>`), fetched through wisp.grid-client
    Share(String),
    /// a GitHub gist by id (v1's Share as a secret gist), read from api.github.com without a token
    Gist(String),
    /// any other https link to a `.crew.json`
    Url(String),
}

impl Source {
    /// How the import is told and tracked: link | gist | url.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::Share(_) => "link",
            Self::Gist(_) => "gist",
            Self::Url(_) => "url",
        }
    }
}

fn is_gist_id(s: &str) -> bool {
    (1..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// What a pasted link names, or why it can't be read.
pub fn source_of(raw: &str) -> Result<Source> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(bad("Paste a crew file, or a link to one."));
    }
    if let Some(id) = raw.strip_prefix("gist:") {
        return if is_gist_id(id.trim()) {
            Ok(Source::Gist(id.trim().to_owned()))
        } else {
            Err(bad(format!("“{raw}” isn't a gist id.")))
        };
    }
    if raw.starts_with("wisp://open/") || raw.starts_with("grid://") {
        return Ok(Source::Share(raw.to_owned()));
    }
    let Some(rest) = raw.strip_prefix("https://").or_else(|| raw.strip_prefix("http://")) else {
        return Err(bad("A link starts with https://, gist: or wisp://open/."));
    };
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let path = path.split(['?', '#']).next().unwrap_or_default().trim_end_matches('/');
    if host.eq_ignore_ascii_case("gist.github.com") {
        // gist.github.com/<owner>/<id> or gist.github.com/<id>
        let id = path.rsplit('/').next().unwrap_or_default();
        return if is_gist_id(id) { Ok(Source::Gist(id.to_owned())) } else { Err(bad(format!("“{raw}” isn't a gist's page."))) };
    }
    // a grid's share page is `<origin>/s/<id>` (a self-hosted grid on this network may be plain http)
    if path.strip_prefix("s/").is_some_and(|id| !id.is_empty() && !id.contains('/')) {
        return Ok(Source::Share(raw.to_owned()));
    }
    if raw.starts_with("http://") {
        return Err(bad("Only https links are read (or a wisp Cloud share link)."));
    }
    if is_private_host(host) {
        return Err(bad("A crew file is read from a public https address, not this computer or its network."));
    }
    Ok(Source::Url(raw.to_owned()))
}

/// This computer or a private network, by name or address literal: an https crew file is never read from there, so a
/// pasted link (or an agent's `from`) can't make the host reach inside the network.
pub fn is_private_host(authority: &str) -> bool {
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if let Some(v6) = host.strip_prefix('[') {
        v6.split(']').next().unwrap_or_default()
    } else {
        host.split(':').next().unwrap_or_default()
    };
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    // the last label: `localhost`, `x.localhost`, `nas.local`, `db.internal`
    if host.is_empty() || matches!(host.rsplit('.').next(), Some("localhost" | "local" | "internal")) {
        return true;
    }
    match host.parse::<core::net::IpAddr>() {
        Ok(core::net::IpAddr::V4(a)) => {
            a.is_loopback()
                || a.is_private()
                || a.is_link_local()
                || a.is_unspecified()
                || a.is_broadcast()
                || a.octets()[0] == 100 && (a.octets()[1] & 0xc0) == 64
        }
        Ok(core::net::IpAddr::V6(a)) => {
            a.is_loopback()
                || a.is_unspecified()
                || (a.segments()[0] & 0xfe00) == 0xfc00
                || (a.segments()[0] & 0xffc0) == 0xfe80
                || a.to_ipv4_mapped().is_some_and(|v4| v4.is_loopback() || v4.is_private() || v4.is_link_local())
        }
        Err(_) => false,
    }
}

/// The gist API's URL for `id` (`GET`, no token: a secret gist is readable by whoever has its id).
pub fn gist_api(id: &str) -> String {
    format!("https://api.github.com/gists/{id}")
}

/// The crew file in a gist (the API's answer): the first `*.crew.json`, else the only JSON file, else the first file.
pub fn gist_text(api: &Value) -> Result<String> {
    let files = api.get("files").and_then(Value::as_object).ok_or_else(|| bad("That gist has no files."))?;
    let pick = files
        .iter()
        .find(|(n, _)| n.to_ascii_lowercase().ends_with(".crew.json"))
        .or_else(|| files.iter().find(|(n, _)| n.to_ascii_lowercase().ends_with(".json")))
        .or_else(|| files.iter().next())
        .map(|(_, f)| f)
        .ok_or_else(|| bad("That gist has no files."))?;
    if pick.get("truncated").and_then(Value::as_bool) == Some(true) {
        return Err(bad("That gist's crew file is too big to read."));
    }
    pick.get("content").and_then(Value::as_str).map(str::to_owned).ok_or_else(|| bad("That gist's file is empty."))
}

/// The crew file a fetched share holds: its content must be a crew (`wispCrew`), not a task or a setup.
pub fn share_crew(content: &Value, card_kind: &str) -> Result<Value> {
    if !card_kind.is_empty() && card_kind != "crew" {
        return Err(bad(format!("That link shares a {card_kind}, not a crew: open it with wisp open.")));
    }
    if content.get("wispCrew").is_none() {
        return Err(bad("That link doesn't hold a crew."));
    }
    Ok(content.clone())
}

/// A fetched body as the crew file's JSON, refused when it's too big or isn't JSON.
pub fn parse_fetched(bytes: &[u8]) -> Result<Value> {
    if bytes.len() > MAX_FETCHED {
        return Err(bad("That file is too big to be a crew file."));
    }
    serde_json::from_slice(bytes).map_err(|_| bad("That link isn't a crew file: it isn't JSON."))
}

/// The key a crew share is kept under on the destination, so sharing the same members again updates the same link:
/// `crew` for the whole crew, else `crew:<ids, sorted>`.
pub fn share_key(ids: &[String], whole: bool) -> String {
    if whole {
        return "crew".into();
    }
    let mut v: Vec<&str> = ids.iter().map(String::as_str).collect();
    v.sort_unstable();
    v.dedup();
    format!("crew:{}", v.join(","))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_pasted_link_names_a_share_a_gist_or_a_file() {
        assert_eq!(source_of("gist:abc123").unwrap(), Source::Gist("abc123".into()));
        assert_eq!(source_of(" https://gist.github.com/ada/abc123 ").unwrap(), Source::Gist("abc123".into()));
        assert_eq!(source_of("https://gist.github.com/abc123#file-x").unwrap(), Source::Gist("abc123".into()));
        assert_eq!(source_of("https://grid.trywisp.dev/s/k3j").unwrap(), Source::Share("https://grid.trywisp.dev/s/k3j".into()));
        assert_eq!(source_of("http://localhost:7000/s/k3j").unwrap().kind(), "link");
        assert_eq!(source_of("wisp://open/k3j").unwrap().kind(), "link");
        assert_eq!(source_of("https://example.com/ada.crew.json").unwrap().kind(), "url");
        assert!(source_of("http://example.com/ada.crew.json").is_err(), "plain http only for a share link");
        assert!(source_of("gist:../etc").is_err());
        assert!(source_of("ftp://x").is_err());
        assert!(source_of("  ").is_err());
        for inside in [
            "https://127.0.0.1/a.crew.json",
            "https://169.254.169.254/latest",
            "https://10.0.0.4:8443/x",
            "https://[::1]/x",
            "https://localhost/x",
            "https://u@192.168.1.2/x",
            "https://nas.local/x",
        ] {
            assert!(source_of(inside).is_err(), "{inside} is inside the network");
        }
        assert!(source_of("http://evil.example/x/s/y").is_err(), "a share page is <origin>/s/<id>, nothing deeper");
    }

    #[test]
    fn a_gist_s_crew_file_is_found_among_its_files() {
        let api = json!({ "files": { "README.md": { "content": "hi" }, "ada.crew.json": { "content": "{\"wispCrew\":1}" } } });
        assert_eq!(gist_text(&api).unwrap(), "{\"wispCrew\":1}");
        assert!(gist_text(&json!({ "files": { "a.crew.json": { "content": "x", "truncated": true } } })).is_err());
        assert!(gist_text(&json!({})).is_err());
    }

    #[test]
    fn a_share_of_another_kind_is_not_a_crew() {
        assert!(share_crew(&json!({ "wispCrew": 1, "members": [] }), "crew").is_ok());
        assert!(share_crew(&json!({ "wispTask": 1 }), "task").is_err());
        assert!(share_crew(&json!({ "wispTask": 1 }), "").is_err());
        assert!(parse_fetched(&vec![b' '; MAX_FETCHED + 1]).is_err());
        assert_eq!(share_key(&["b".into(), "a".into(), "a".into()], false), "crew:a,b");
        assert_eq!(share_key(&[], true), "crew");
    }
}
