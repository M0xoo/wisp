//! F-mach-4: a machine with only SSH gets wisp installed and started by the bootstrap script, run the way `ssh … sh -s`
//! runs it (the script on stdin, a non-interactive shell, a bare PATH). The release is a local folder (`file://`) and
//! `curl` a stand-in that serves it and answers wisp's health check once the installed wisp has started, so the test
//! needs no network and no SSH server: what it checks is the script itself (download, checksum, unpack into
//! `~/.wisp/bin/<version>`, start, ready), and that a second connect reuses the install and the running wisp.
#![cfg(unix)]
#![allow(clippy::unwrap_used)]

use std::io::Write as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use wisp_machines_core::bootstrap::{Api, BootLine, BootOpts, bootstrap_script, parse_line};

const VERSION: &str = "9.9.9";
const PORT: u16 = 45_877;

fn scratch(name: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let d = std::env::temp_dir().join(format!("wisp-boot-{name}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn exe(path: &Path, body: &str) {
    std::fs::write(path, body).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
}

fn sh(cmd: &str, cwd: &Path) {
    let ok = Command::new("/bin/sh").arg("-c").arg(cmd).current_dir(cwd).status().unwrap().success();
    assert!(ok, "{cmd}");
}

/// A release folder like GitHub's: `wisp-bin-<os>-<arch>.tar.gz` for every system, and `SHA256SUMS.txt`
/// (`damaged`: a wrong sum for each).
fn release(root: &Path, damaged: bool) -> PathBuf {
    let stage = root.join("stage");
    let dist = root.join("dist");
    std::fs::create_dir_all(&stage).unwrap();
    std::fs::create_dir_all(&dist).unwrap();
    // the installed wisp: `wisp serve --port <port>` marks itself started (the stand-in curl's health reads it), then stays up
    exe(&stage.join("wisp"), "#!/bin/sh\n[ \"$1\" = serve ] || exit 2\n: > \"$HOME/started-$3\"\nexec sleep 3\n");
    for os in ["linux", "darwin"] {
        for arch in ["x64", "arm64"] {
            sh(&format!("tar -czf '{}/wisp-bin-{os}-{arch}.tar.gz' -C '{}' wisp", dist.display(), stage.display()), root);
        }
    }
    let sums = if damaged {
        "for f in wisp-bin-*.tar.gz; do echo \"0000000000000000000000000000000000000000000000000000000000000000  $f\"; done > SHA256SUMS.txt"
    } else {
        "for f in wisp-bin-*.tar.gz; do (sha256sum \"$f\" 2>/dev/null || shasum -a 256 \"$f\"); done > SHA256SUMS.txt"
    };
    sh(sums, &dist);
    dist
}

/// `curl` as the script calls it (`-fsSL <url>`, `-s --max-time 3 <url>`): a file:// URL is read; wisp's health
/// answers once that wisp has started.
fn fake_tools(root: &Path) -> PathBuf {
    let bin = root.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    exe(
        &bin.join("curl"),
        &format!(
            "#!/bin/sh\nfor a; do u=$a; done\ncase $u in\n  file://*) cat \"${{u#file://}}\" ;;\n  */api/health) [ -f \"$HOME/started-{PORT}\" ] || exit 7; printf '{{\"name\":\"wisp\",\"version\":\"{VERSION}\",\"proto_max\":3,\"pid\":4242}}' ;;\n  *) exit 6 ;;\nesac\n"
        ),
    );
    // the login shell the script asks for PATH: none here, as on a box with a bare profile
    exe(&bin.join("noshell"), "#!/bin/sh\nexit 1\n");
    bin
}

/// The script, on the stdin of `sh -s` with a bare environment, and what it printed.
fn connect(home: &Path, bin: &Path, dist: &Path) -> Vec<BootLine> {
    let script = bootstrap_script(&BootOpts {
        port: PORT,
        command: "",
        api: Api::AtLeast(3),
        install: true,
        version: VERSION,
        dist: Some(&format!("file://{}", dist.display())),
    });
    let mut child = Command::new("/bin/sh")
        .arg("-s")
        .env_clear()
        .env("HOME", home)
        .env("SHELL", bin.join("noshell"))
        .env("PATH", format!("{}:/usr/bin:/bin:/usr/sbin:/sbin", bin.display()))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(script.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    String::from_utf8_lossy(&out.stdout).lines().map(parse_line).filter(|l| !matches!(l, BootLine::Blank | BootLine::Log(_))).collect()
}

fn step(lines: &[BootLine], id: &str, status: &str) -> Option<String> {
    lines.iter().find_map(|l| match l {
        BootLine::Step { id: i, status: s, detail } if i == id && format!("{s:?}").eq_ignore_ascii_case(status) => Some(detail.clone()),
        _ => None,
    })
}

#[test]
fn a_machine_with_only_ssh_gets_wisp_installed_checked_and_started_then_reused() {
    let root = scratch("ok");
    let (home, bin, dist) = (root.join("home"), fake_tools(&root), release(&root, false));
    std::fs::create_dir_all(&home).unwrap();

    let first = connect(&home, &bin, &dist);
    assert!(step(&first, "ssh", "done").is_some(), "{first:?}");
    assert!(step(&first, "install", "run").is_some_and(|d| d.contains("no admin")), "{first:?}");
    assert_eq!(step(&first, "install", "done").as_deref(), Some(format!("wisp {VERSION}").as_str()));
    assert_eq!(step(&first, "wisp", "done").as_deref(), Some(format!("started · {VERSION}").as_str()));
    assert_eq!(first.last(), Some(&BootLine::Ready { version: VERSION.into(), pid: Some(4242) }));
    let installed = home.join(format!(".wisp/bin/{VERSION}/wisp"));
    assert!(installed.metadata().unwrap().permissions().mode() & 0o111 != 0, "installed and executable");
    assert!(!home.join(".wisp/bin/download").exists(), "the download is cleaned up");

    // connecting again: nothing downloaded, the wisp that runs there is taken as it is
    std::fs::remove_dir_all(&dist).unwrap();
    let again = connect(&home, &bin, &dist);
    assert_eq!(step(&again, "install", "done").as_deref(), Some(format!("wisp {VERSION}").as_str()));
    assert!(step(&again, "install", "run").is_none(), "{again:?}");
    assert_eq!(step(&again, "wisp", "done").as_deref(), Some(format!("already running · {VERSION}").as_str()));
    assert_eq!(again.last(), Some(&BootLine::Ready { version: VERSION.into(), pid: Some(4242) }));
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_damaged_wisp_download_is_refused_and_nothing_is_installed() {
    let root = scratch("bad");
    let (home, bin, dist) = (root.join("home"), fake_tools(&root), release(&root, true));
    std::fs::create_dir_all(&home).unwrap();
    let lines = connect(&home, &bin, &dist);
    assert!(
        lines.iter().any(|l| matches!(l, BootLine::Fail { id, message } if id == "install" && message.contains("checksum"))),
        "{lines:?}"
    );
    assert!(!lines.iter().any(|l| matches!(l, BootLine::Ready { .. })));
    assert!(!home.join(format!(".wisp/bin/{VERSION}")).exists());
    let _ = std::fs::remove_dir_all(&root);
}
