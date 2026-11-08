//! A peer's row from add/update input (v1 `#clean`, `addGrid`), and the card it shows (v1 `view()`).
use std::cmp::Ordering;
use std::collections::BTreeMap;

use serde_json::Value;
use wisp_machines_api::{AddArgs, Cleaned, PeerRow, PeerStatus, PeerView, RemoteAgent};

use crate::shell::{host_of, is_target};

pub const DEFAULT_PORT: u16 = 4477;
pub const MAX_NAME: usize = 40;

fn cut(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// v1's `Number(v)`: a number, or a string of one.
fn port_value(v: Option<&Value>, prev: Option<u16>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => Some(f64::from(prev.unwrap_or(DEFAULT_PORT))),
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) if s.trim().is_empty() => Some(0.0),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}

/// An ssh peer's fields (v1 `#clean`): every field falls back to the row's, then the default.
pub fn clean_ssh(input: &AddArgs, prev: Option<&PeerRow>) -> Result<Cleaned, String> {
    let target = input.address().map_or_else(|| prev.map(|p| p.address.clone()).unwrap_or_default(), str::to_owned);
    let target = target.trim().to_owned();
    if !is_target(&target) {
        return Err("SSH host: user@host, a host name, or a Host from ~/.ssh/config.".into());
    }
    let port = port_value(input.port.as_ref(), prev.map(|p| p.port)).filter(|p| p.fract() == 0.0 && (1.0..=65535.0).contains(p)).ok_or("Port: a number from 1 to 65535.")?;
    let command = input.command.clone().or_else(|| prev.map(|p| p.command.clone())).unwrap_or_default().trim().to_owned();
    let name = input.name.clone().or_else(|| prev.map(|p| p.name.clone())).unwrap_or_default();
    let name = cut(name.trim(), MAX_NAME);
    let name = if name.is_empty() { host_of(&target).to_owned() } else { name };
    let auto = input.auto_connect.or(prev.map(|p| p.auto_connect)).unwrap_or(true);
    #[expect(clippy::cast_possible_truncation, clippy::cast_sign_loss, reason = "checked to be an integer in 1..=65535 above")]
    let port = port as u16;
    Ok(Cleaned { name: Some(name), address: Some(target), port: Some(port), command: Some(command), auto_connect: Some(auto) })
}

/// A grid peer's address comes from the grid: only its name and auto-connect change here.
pub fn clean_grid(input: &AddArgs, prev: &PeerRow) -> Cleaned {
    let name = cut(input.name.as_deref().unwrap_or(&prev.name).trim(), MAX_NAME);
    Cleaned { name: Some(if name.is_empty() { prev.name.clone() } else { name }), auto_connect: Some(input.auto_connect.unwrap_or(prev.auto_connect)), ..Cleaned::default() }
}

/// A cloud computer's name: a second account's same-named one gets " (<handle>)", so Run on, the
/// card and every toast tell them apart.
pub fn grid_label(name: Option<&str>, handle: Option<&str>, host: &str, taken: &[&str]) -> String {
    let label = name.filter(|s| !s.is_empty()).or(handle.filter(|s| !s.is_empty())).unwrap_or(host).to_owned();
    let label = match handle {
        Some(h) if !h.is_empty() && taken.contains(&cut(&label, MAX_NAME).as_str()) => format!("{label} ({h})"),
        _ => label,
    };
    cut(&label, MAX_NAME)
}

/// The origin's port (v1: `Number(u.port) || (https ? 443 : 80)`).
pub fn origin_port(origin: &str) -> u16 {
    let https = origin.starts_with("https:");
    let rest = origin.split_once("://").map_or(origin, |(_, r)| r);
    let host = rest.split('/').next().unwrap_or("");
    let port = host.rsplit_once(':').filter(|(h, _)| !h.ends_with(']') || host.starts_with('[')).and_then(|(_, p)| p.parse().ok());
    port.unwrap_or(if https { 443 } else { 80 })
}

/// A 6-hex local handle from 3 random bytes (v1 `randomBytes(3)`).
pub fn handle(bytes: [u8; 3]) -> String {
    bytes.iter().fold(String::with_capacity(6), |mut s, b| {
        use std::fmt::Write as _;
        let _ = write!(s, "{b:02x}");
        s
    })
}

/// v1 `newer(a, b)`: is `a` a later version than `b` (semver, prereleases before their release)?
#[allow(clippy::many_single_char_names)]
pub fn newer(a: &str, b: &str) -> bool {
    fn parse(v: &str) -> (Vec<u64>, Vec<String>) {
        let v = v.trim_start_matches('v').split('+').next().unwrap_or("");
        let (core, pre) = v.split_once('-').map_or((v, ""), |(c, p)| (c, p));
        (core.split('.').map(|n| n.parse().unwrap_or(0)).collect(), if pre.is_empty() { Vec::new() } else { pre.split('.').map(str::to_owned).collect() })
    }
    let ((x, xp), (y, yp)) = (parse(a), parse(b));
    for i in 0..3 {
        let (p, q) = (x.get(i).copied().unwrap_or(0), y.get(i).copied().unwrap_or(0));
        if p != q {
            return p > q;
        }
    }
    if xp.is_empty() || yp.is_empty() {
        return xp.is_empty() && !yp.is_empty(); // a release beats its prereleases
    }
    for i in 0..xp.len().max(yp.len()) {
        let (Some(s), Some(t)) = (xp.get(i), yp.get(i)) else { return yp.get(i).is_none() }; // more identifiers sort later
        if s == t {
            continue;
        }
        return match (s.parse::<u64>(), t.parse::<u64>()) {
            (Ok(m), Ok(n)) => m > n,
            (Ok(_), Err(_)) => false, // numbers sort before words
            (Err(_), Ok(_)) => true,
            (Err(_), Err(_)) => s.cmp(t) == Ordering::Greater,
        };
    }
    false
}

/// The version Restart wisp there would bring it to: this one, unless a custom command decides.
pub fn update_to(local: &str, remote: Option<&str>, command: &str) -> Option<String> {
    let remote = remote?;
    (command.is_empty() && newer(local, remote)).then(|| local.to_owned())
}

/// What the UI keeps of a peer's harness (v1 `remoteAgent`): `signedIn` only when false.
pub fn remote_agent(v: &Value) -> Option<RemoteAgent> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    let keep = |k: &str| v.get(k).filter(|x| !x.is_null()).cloned();
    Some(RemoteAgent {
        id: s("id")?,
        name: s("name").unwrap_or_default(),
        available: v.get("available").and_then(Value::as_bool).unwrap_or(false),
        version: s("version"),
        models: keep("models"),
        efforts: keep("efforts"),
        delegates: keep("delegates"),
        signed_in: (v.get("signedIn") == Some(&Value::Bool(false))).then_some(false),
    })
}

pub fn remote_agents(v: &Value) -> Vec<RemoteAgent> {
    v.as_array().map(|a| a.iter().filter_map(remote_agent).collect()).unwrap_or_default()
}

/// What the card needs beside the row and its status.
#[derive(Debug, Clone, Default)]
pub struct Extras {
    pub version: String,
    pub default_command: String,
    pub log: Vec<String>,
    pub projects: u32,
    pub working: u32,
}

pub fn view(row: &PeerRow, status: &PeerStatus, x: Extras) -> PeerView {
    let mut data: BTreeMap<String, Value> = row.data.clone();
    data.retain(|k, _| !matches!(k.as_str(), "id" | "name" | "state" | "kind" | "target" | "port"));
    PeerView {
        id: row.id.clone(),
        peer: row.peer.clone(),
        name: row.name.clone(),
        transport: row.transport.clone(),
        address: row.address.clone(),
        port: row.port,
        command: row.command.clone(),
        auto_connect: row.auto_connect,
        added_at: row.added_at,
        kind: row.kind().to_owned(),
        target: row.address.clone(),
        default_command: x.default_command,
        state: status.state,
        steps: status.steps.clone(),
        error: status.error.clone(),
        hint: status.hint.clone(),
        stale: status.stale.is_some(),
        attempt: status.attempt,
        since: status.since,
        remote: status.remote.clone(),
        outdated: update_to(&x.version, status.remote.as_ref().and_then(|r| r.version.as_deref()), &row.command),
        log: x.log,
        projects: x.projects,
        working: x.working,
        update: status.update.clone(),
        data,
    }
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;
