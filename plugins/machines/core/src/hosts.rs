//! Hosts this computer already knows how to reach (`~/.ssh/config`, `known_hosts`, the tailnet).
//! Pure: the host reads the files and runs `tailscale status --json`; these only parse.
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;
use wisp_machines_api::{FoundHost, SshHost};

use crate::shell::is_target;

/// What reading `~/.ssh/config` needs from the host: a file's text, a folder's names.
pub trait SshFiles {
    fn read(&self, path: &Path) -> Option<String>;
    fn list(&self, dir: &Path) -> Vec<String>;
}

/// `*` and `?` in an Include's last segment (ssh's own glob, enough for `config.d/*`).
fn glob(pat: &str, name: &str) -> bool {
    fn go(p: &[char], n: &[char]) -> bool {
        match (p.first(), n.first()) {
            (None, None) => true,
            (Some('*'), _) => go(&p[1..], n) || (!n.is_empty() && go(p, &n[1..])),
            (Some('?'), Some(_)) => go(&p[1..], &n[1..]),
            (Some(a), Some(b)) if a == b => go(&p[1..], &n[1..]),
            _ => false,
        }
    }
    go(&pat.chars().collect::<Vec<_>>(), &name.chars().collect::<Vec<_>>())
}

/// Hosts from `file` and the files it Includes (relative to `ssh_dir`, `~/` to `home`), one per
/// name, wildcard patterns skipped, at most 20 files deep (an Include loop ends).
pub fn ssh_hosts(files: &dyn SshFiles, file: &Path, ssh_dir: &Path, home: &Path) -> Vec<SshHost> {
    let mut seen = Vec::new();
    let mut hosts = Vec::new();
    read_config(files, file, ssh_dir, home, &mut seen, &mut hosts);
    let mut uniq: Vec<SshHost> = Vec::new();
    for h in hosts {
        // v1: a Map keyed by host keeps the first position and the last value
        match uniq.iter_mut().find(|u| u.host == h.host) {
            Some(u) => *u = h,
            None => uniq.push(h),
        }
    }
    uniq
}

fn read_config(files: &dyn SshFiles, file: &Path, ssh_dir: &Path, home: &Path, seen: &mut Vec<PathBuf>, hosts: &mut Vec<SshHost>) {
    if seen.iter().any(|s| s == file) || seen.len() > 20 {
        return;
    }
    seen.push(file.to_path_buf());
    let Some(text) = files.read(file) else { return };
    let mut current: Vec<usize> = Vec::new(); // one Host line may name several; what follows applies to each
    for raw in text.lines() {
        let line = raw.trim();
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or("").to_ascii_lowercase();
        let value = parts.collect::<Vec<_>>().join(" ");
        match key.as_str() {
            "include" => {
                for pat in value.split_whitespace() {
                    let pat = pat.strip_prefix("~/").map_or_else(|| PathBuf::from(pat), |rest| home.join(rest));
                    let abs = if pat.is_absolute() { pat } else { ssh_dir.join(pat) };
                    let (Some(dir), Some(base)) = (abs.parent(), abs.file_name().and_then(|b| b.to_str())) else {
                        continue;
                    };
                    let mut names = files.list(dir);
                    names.sort();
                    for n in names.iter().filter(|n| glob(base, n)) {
                        read_config(files, &dir.join(n), ssh_dir, home, seen, hosts);
                    }
                }
            }
            "host" => {
                current.clear();
                for h in value.split_whitespace().filter(|h| !h.contains(['*', '?', '!'])) {
                    current.push(hosts.len());
                    hosts.push(SshHost { host: h.to_owned(), hostname: String::new(), user: String::new() });
                }
            }
            "hostname" => current.iter().for_each(|&i| hosts[i].hostname.clone_from(&value)),
            "user" => current.iter().for_each(|&i| hosts[i].user.clone_from(&value)),
            _ => {}
        }
    }
}

/// Code hosts you push to, not computers to run agents on.
fn is_forge(host: &str) -> bool {
    const FORGES: [&str; 8] = [
        "github.com",
        "gitlab.com",
        "bitbucket.org",
        "ssh.dev.azure.com",
        "vs-ssh.visualstudio.com",
        "heroku.com",
        "codeberg.org",
        "sr.ht",
    ];
    let h = host.to_ascii_lowercase();
    FORGES.iter().any(|f| h == *f || h.ends_with(&format!(".{f}")))
}

fn is_ipv4ish(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit() || c == '.')
}

/// Hosts you've `SSHed` to, from `known_hosts`. Hashed entries, markers and `[host]:port` ones (a bare
/// target can't say the port) are skipped, as are forges and loopback.
pub fn known_hosts(text: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(['#', '@', '|']) {
            continue;
        }
        let first = line.split_whitespace().next().unwrap_or("");
        let names: Vec<&str> = first.split(',').filter(|n| !n.is_empty() && !n.starts_with('[') && !n.contains(['*', '?', '!'])).collect();
        // "devbox,10.0.0.5": the name, with the address as a detail
        let Some(host) = names.iter().find(|n| !is_ipv4ish(n) && !n.contains(':')).or(names.first()).copied() else {
            continue;
        };
        let loopback = host == "localhost" || host.starts_with("127.") || host == "::1";
        if is_forge(host) || loopback || !is_target(host) || out.iter().any(|(h, _)| h == host) {
            continue;
        }
        let detail = names.iter().find(|n| **n != host).copied().unwrap_or("");
        out.push((host.to_owned(), detail.to_owned()));
    }
    out
}

/// A peer on the tailnet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TailPeer {
    pub host: String,
    pub name: String,
    pub os: String,
    pub online: bool,
}

/// Peers from `tailscale status --json`; phones and tablets don't run agents.
pub fn tailscale_peers(status_json: &str) -> Vec<TailPeer> {
    let Ok(v) = serde_json::from_str::<Value>(status_json) else {
        return Vec::new();
    };
    let Some(peers) = v.get("Peer").and_then(Value::as_object) else {
        return Vec::new();
    };
    let s = |p: &Value, k: &str| p.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    peers
        .values()
        .filter(|p| !matches!(s(p, "OS").to_ascii_lowercase().as_str(), "ios" | "android" | "tvos"))
        .map(|p| {
            let dns = s(p, "DNSName");
            let dns = dns.strip_suffix('.').unwrap_or(&dns).to_owned();
            let ip = p.get("TailscaleIPs").and_then(|a| a.get(0)).and_then(Value::as_str).unwrap_or("");
            TailPeer {
                host: if dns.is_empty() { ip.to_owned() } else { dns },
                name: s(p, "HostName"),
                os: s(p, "OS"),
                online: p.get("Online").and_then(Value::as_bool).unwrap_or(false),
            }
        })
        .filter(|p| !p.host.is_empty() && is_target(&p.host))
        .collect()
}

/// Every host found, one per target: `~/.ssh/config` first (your own names), then the tailnet,
/// then `known_hosts`; offline tailnet peers last.
pub fn discover(config: &[SshHost], tail: &[TailPeer], known: &[(String, String)]) -> Vec<FoundHost> {
    let mut out: BTreeMap<String, usize> = BTreeMap::new();
    let mut list: Vec<FoundHost> = Vec::new();
    let mut put = |x: FoundHost| {
        if !x.target.is_empty() && !out.contains_key(&x.target) {
            out.insert(x.target.clone(), list.len());
            list.push(x);
        }
    };
    for h in config {
        let detail = [h.user.as_str(), h.hostname.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("@");
        put(FoundHost { target: h.host.clone(), name: h.host.clone(), source: "ssh-config".into(), detail, online: None });
    }
    for p in tail {
        let name = if p.name.is_empty() { p.host.split('.').next().unwrap_or("").to_owned() } else { p.name.clone() };
        let detail = [p.os.as_str(), if p.online { "online" } else { "offline" }]
            .iter()
            .filter(|s| !s.is_empty())
            .copied()
            .collect::<Vec<_>>()
            .join(" · ");
        put(FoundHost { target: p.host.clone(), name, source: "tailscale".into(), detail, online: Some(p.online) });
    }
    for (host, hostname) in known {
        let name = if is_ipv4ish(host) { host.clone() } else { host.split('.').next().unwrap_or("").to_owned() };
        put(FoundHost { target: host.clone(), name, source: "known-hosts".into(), detail: hostname.clone(), online: None });
    }
    list.sort_by_key(|x| x.online == Some(false)); // stable: the rest keep their order
    list
}

#[cfg(test)]
#[path = "hosts_tests.rs"]
mod tests;
