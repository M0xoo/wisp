use std::collections::BTreeMap;

use super::*;

struct Fake(BTreeMap<PathBuf, String>);
impl SshFiles for Fake {
    fn read(&self, path: &Path) -> Option<String> {
        self.0.get(path).cloned()
    }
    fn list(&self, dir: &Path) -> Vec<String> {
        self.0.keys().filter(|p| p.parent() == Some(dir)).filter_map(|p| p.file_name()?.to_str().map(str::to_owned)).collect()
    }
}

fn fake(files: &[(&str, &str)]) -> Fake {
    Fake(files.iter().map(|(p, t)| (PathBuf::from(p), (*t).to_owned())).collect())
}

#[test]
fn ssh_config_hosts_with_includes_under_the_ssh_dir() {
    let f = fake(&[
        ("/h/.ssh/config", "Host devbox gpu\n  HostName 10.0.0.5\n  User me\nHost *\n  ServerAliveInterval 30\nInclude extra/*.conf\n"),
        ("/h/.ssh/extra/work.conf", "Host build-1\n  HostName build.internal\n"),
        ("/h/.ssh/extra/notes.txt", "Host nope\n"),
    ]);
    let hosts = ssh_hosts(&f, Path::new("/h/.ssh/config"), Path::new("/h/.ssh"), Path::new("/h"));
    let got: Vec<_> = hosts.iter().map(|h| (h.host.as_str(), h.hostname.as_str(), h.user.as_str())).collect();
    assert_eq!(got, [("devbox", "10.0.0.5", "me"), ("gpu", "10.0.0.5", "me"), ("build-1", "build.internal", "")]);
    // a config elsewhere: its relative Include resolves under ~/.ssh, so the temp one isn't followed (v1)
    let f = fake(&[("/tmp/x/config", "Host a\nInclude extra/*.conf\n"), ("/tmp/x/extra/w.conf", "Host b\n")]);
    assert_eq!(ssh_hosts(&f, Path::new("/tmp/x/config"), Path::new("/h/.ssh"), Path::new("/h")).len(), 1);
}

#[test]
fn an_include_loop_ends() {
    let f = fake(&[("/h/.ssh/config", "Host a\nInclude config\nInclude ~/.ssh/config\n")]);
    assert_eq!(ssh_hosts(&f, Path::new("/h/.ssh/config"), Path::new("/h/.ssh"), Path::new("/h")).len(), 1);
    assert!(ssh_hosts(&f, Path::new("/missing"), Path::new("/h/.ssh"), Path::new("/h")).is_empty());
}

#[test]
fn known_hosts_skip_forges_hashes_ports_and_loopback() {
    let text = [
        "github.com ssh-ed25519 AAAA",
        "gpu.lan,192.168.1.20 ssh-ed25519 AAAA",
        "192.168.1.30 ecdsa-sha2-nistp256 AAAA",
        "[build.lan]:2222 ssh-ed25519 AAAA",
        "|1|aGFzaA==|aGFzaA== ssh-ed25519 AAAA",
        "@cert-authority *.corp ssh-ed25519 AAAA",
        "devbox ssh-ed25519 AAAA",
        "localhost ssh-ed25519 AAAA",
        "devbox ssh-rsa BBBB",
    ]
    .join("\n");
    assert_eq!(
        known_hosts(&text),
        [("gpu.lan".into(), "192.168.1.20".into()), ("192.168.1.30".into(), String::new()), ("devbox".into(), String::new())]
    );
}

const STATUS: &str = r#"{"Self":{"HostName":"me"},"Peer":{
  "a":{"HostName":"studio","DNSName":"studio.tail1.ts.net.","OS":"macOS","Online":true,"TailscaleIPs":["100.64.0.2"]},
  "b":{"HostName":"phone","DNSName":"phone.tail1.ts.net.","OS":"iOS","Online":true},
  "c":{"HostName":"old-vm","DNSName":"","OS":"linux","Online":false,"TailscaleIPs":["100.64.0.9"]}}}"#;

#[test]
fn tailnet_peers_without_phones() {
    let peers = tailscale_peers(STATUS);
    assert_eq!(
        peers,
        [
            TailPeer { host: "studio.tail1.ts.net".into(), name: "studio".into(), os: "macOS".into(), online: true },
            TailPeer { host: "100.64.0.9".into(), name: "old-vm".into(), os: "linux".into(), online: false }
        ]
    );
    assert!(tailscale_peers("not json").is_empty());
}

#[test]
fn discover_one_entry_per_target_offline_last() {
    let config = [SshHost { host: "devbox".into(), hostname: "10.0.0.5".into(), user: "me".into() }];
    let known = known_hosts("gpu.lan,192.168.1.20 k\n192.168.1.30 k\ndevbox k\n");
    let found = discover(&config, &tailscale_peers(STATUS), &known);
    let got: Vec<_> = found.iter().map(|x| (x.target.as_str(), x.name.as_str(), x.source.as_str())).collect();
    assert_eq!(
        got,
        [
            ("devbox", "devbox", "ssh-config"),
            ("studio.tail1.ts.net", "studio", "tailscale"),
            ("gpu.lan", "gpu", "known-hosts"),
            ("192.168.1.30", "192.168.1.30", "known-hosts"),
            ("100.64.0.9", "old-vm", "tailscale")
        ]
    );
    assert_eq!(found[0].detail, "me@10.0.0.5");
    assert_eq!(found[1].detail, "macOS · online");
}
