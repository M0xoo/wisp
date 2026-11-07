//! Can other devices reach this computer over SSH? What Settings → Machines → This computer shows.
//! The host knocks on its own SSH port and asks the local tailscale CLI; these only read answers.
use serde_json::Value;
use wisp_machines_api::{Reachability, SshServer, TailscaleSelf};

/// An SSH server says `SSH-…` first; anything else on the port isn't one. `None` until a line (or
/// 255 bytes) has come.
pub fn banner(buf: &[u8]) -> Option<Option<String>> {
    let text = String::from_utf8_lossy(buf);
    if !text.contains('\n') && buf.len() <= 255 {
        return None;
    }
    let first = text.lines().next().unwrap_or("").trim().to_owned();
    Some(text.starts_with("SSH-").then_some(first))
}

/// This computer on the tailnet, from `tailscale status --json` and `tailscale debug prefs`.
/// `status`: `None` when the CLI isn't installed.
pub fn tailscale_self(status: Option<&str>, prefs: Option<&str>) -> TailscaleSelf {
    let Some(status) = status else {
        return TailscaleSelf::default();
    };
    let Ok(j) = serde_json::from_str::<Value>(status) else {
        return TailscaleSelf {
            installed: true,
            ..TailscaleSelf::default()
        };
    };
    let me = j.get("Self").cloned().unwrap_or(Value::Null);
    let name = me
        .get("DNSName")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim_end_matches('.')
        .to_owned();
    let ip = me
        .get("TailscaleIPs")
        .and_then(Value::as_array)
        .and_then(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .find(|x| !x.contains(':'))
        })
        .unwrap_or("")
        .to_owned();
    let ssh = prefs
        .and_then(|p| serde_json::from_str::<Value>(p).ok())
        .and_then(|p| p.get("RunSSH").and_then(Value::as_bool));
    TailscaleSelf {
        installed: true,
        running: j.get("BackendState").and_then(Value::as_str) == Some("Running"),
        name: Some(name),
        ip: Some(ip),
        ssh,
    }
}

/// Keys in `authorized_keys` (comments and blank lines aside).
pub fn authorized_keys(text: &str) -> u32 {
    u32::try_from(
        text.lines()
            .filter(|l| !l.trim().is_empty() && !l.trim().starts_with('#'))
            .count(),
    )
    .unwrap_or(u32::MAX)
}

pub struct Facts<'a> {
    pub os: &'a str,
    pub user: &'a str,
    pub hostname: &'a str,
    pub ssh_port: u16,
    pub banner: Option<String>,
    pub tailscale: TailscaleSelf,
    pub keys: u32,
}

pub fn reachability(f: Facts<'_>) -> Reachability {
    let ts_name = f
        .tailscale
        .name
        .clone()
        .filter(|n| f.tailscale.running && !n.is_empty());
    let host = ts_name.unwrap_or_else(|| f.hostname.to_owned());
    Reachability {
        os: f.os.to_owned(),
        user: f.user.to_owned(),
        hostname: f.hostname.to_owned(),
        ssh: SshServer {
            running: f.banner.is_some(),
            banner: f.banner.unwrap_or_default(),
            port: f.ssh_port,
        },
        target: format!("{}@{host}", f.user),
        supported: f.os != "win32" && f.os != "windows",
        tailscale: f.tailscale,
        keys: f.keys,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn banners() {
        assert_eq!(
            banner(b"SSH-2.0-OpenSSH_test\r\n"),
            Some(Some("SSH-2.0-OpenSSH_test".into()))
        );
        assert_eq!(banner(b"HTTP/1.1 400 Bad Request\r\n"), Some(None));
        assert_eq!(banner(b"SSH-2.0"), None);
        assert_eq!(banner(&[b'x'; 300]), Some(None));
    }

    #[test]
    fn tailscale_and_keys() {
        let st = r#"{"BackendState":"Running","Self":{"DNSName":"box.tail1.ts.net.","TailscaleIPs":["fd7a::1","100.64.0.9"]}}"#;
        let ts = tailscale_self(Some(st), Some(r#"{"RunSSH": true}"#));
        assert_eq!(
            ts,
            TailscaleSelf {
                installed: true,
                running: true,
                name: Some("box.tail1.ts.net".into()),
                ip: Some("100.64.0.9".into()),
                ssh: Some(true)
            }
        );
        assert_eq!(
            serde_json::to_value(tailscale_self(None, None)).ok(),
            Some(serde_json::json!({"installed": false, "running": false}))
        );
        assert_eq!(
            authorized_keys("# mine\nssh-ed25519 AAAA laptop\n\nssh-ed25519 BBBB wisp-phone\n"),
            2
        );
        let r = reachability(Facts {
            os: "darwin",
            user: "me",
            hostname: "mac",
            ssh_port: 22,
            banner: Some("SSH-2.0-x".into()),
            tailscale: ts,
            keys: 2,
        });
        assert_eq!(r.target, "me@box.tail1.ts.net"); // the tailnet name, when there is one
        assert!(r.ssh.running && r.supported);
        let r = reachability(Facts {
            os: "win32",
            user: "me",
            hostname: "pc",
            ssh_port: 22,
            banner: None,
            tailscale: TailscaleSelf::default(),
            keys: 0,
        });
        assert_eq!((r.target.as_str(), r.supported), ("me@pc", false));
    }
}
