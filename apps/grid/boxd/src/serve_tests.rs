//! boxd over its socket, with a fake `docker` (a shell script): what a run streams, how it stops, what remove and
//! migrate do to the folders.
#![allow(clippy::unwrap_used, clippy::panic)]

use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::*;

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("boxd-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// `docker run …` prints its env file's mode and a line, then waits; TERM writes `<dir>/stopped` and exits 0.
fn fake_docker(dir: &Path) -> String {
    let p = dir.join("docker");
    let script = format!(
        r#"#!/bin/sh
case "$1" in
  run)
    for a in "$@"; do case "$prev" in --env-file) envf="$a";; esac; prev="$a"; done
    echo "env-mode $(stat -c %a "$envf" 2>/dev/null || stat -f %Lp "$envf")"
    echo "hello from the box"
    trap 'echo bye; touch {stopped}; exit 0' TERM
    while :; do sleep 0.05; done ;;
  *) exit 0 ;;
esac
"#,
        stopped = dir.join("stopped").display()
    );
    std::fs::write(&p, script).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p.to_string_lossy().into_owned()
}

fn boxd(dir: &Path) -> (Arc<Boxd>, PathBuf) {
    let o = Opts { socket: dir.join("box.sock"), group: String::new(), data: dir.join("data"), boxes: dir.join("boxes"), docker: fake_docker(dir), container: Container::default() };
    let b = Boxd::new(o);
    let sock = b.o.socket.clone();
    let l = UnixListener::bind(&sock).unwrap();
    let b2 = b.clone();
    std::thread::spawn(move || accept(&b2, &l));
    (b, sock)
}

fn ask(sock: &Path, line: &str) -> (UnixStream, BufReader<UnixStream>) {
    let mut c = UnixStream::connect(sock).unwrap();
    c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    c.write_all(format!("{line}\n").as_bytes()).unwrap();
    let r = BufReader::new(c.try_clone().unwrap());
    (c, r)
}

fn next(r: &mut BufReader<UnixStream>) -> Option<J> {
    let mut l = String::new();
    match r.read_line(&mut l) {
        Ok(n) if n > 0 => parse(l.trim_end()).ok(),
        _ => None,
    }
}

#[test]
fn a_run_streams_logs_and_exit_and_stops_when_the_grid_hangs_up() {
    let dir = tmp("run");
    let (b, sock) = boxd(&dir);
    let (c, mut r) = ask(&sock, r#"{"op":"run","id":"u1","port":4100,"env":{"WISP_TRUSTED_PROXY_SECRET":"s3"}}"#);
    let mut logs = String::new();
    while !logs.contains("hello from the box") {
        let m = next(&mut r).unwrap_or_else(|| panic!("no log: {logs}"));
        logs.push_str(m.get("log").and_then(J::str).unwrap_or_default());
    }
    assert!(logs.contains("env-mode 600"), "the env file (with the secret) is 0600: {logs}");
    assert!(dir.join("boxes/u1/home").is_dir());
    // the grid hangs up: the box gets TERM and stops
    drop(r);
    c.shutdown(std::net::Shutdown::Both).unwrap();
    let t = Instant::now();
    while !dir.join("stopped").exists() && t.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(dir.join("stopped").exists(), "TERM reached the box");
    let t = Instant::now();
    while dir.join("boxes/u1/env").exists() && t.elapsed() < Duration::from_secs(5) {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!dir.join("boxes/u1/env").exists(), "the env file goes with the run");
    assert!(dir.join("boxes/u1/home").is_dir(), "the home stays");
    // a refused run says why and runs nothing
    let (_c, mut r) = ask(&sock, r#"{"op":"run","id":"../x","port":4100}"#);
    assert!(next(&mut r).and_then(|m| m.get("error").and_then(J::str).map(str::to_owned)).is_some_and(|e| e.contains("user id")));
    // a signal on the connection
    let _ = std::fs::remove_file(dir.join("stopped"));
    let (mut c, mut r) = ask(&sock, r#"{"op":"run","id":"u2","port":4101}"#);
    while next(&mut r).and_then(|m| m.get("log").and_then(J::str).map(str::to_owned)).is_none_or(|l| !l.contains("hello")) {}
    c.write_all(b"{\"signal\":\"SIGTERM\"}\n").unwrap();
    let mut exit = None;
    while let Some(m) = next(&mut r) {
        if m.get("exit").is_some() {
            exit = Some(m);
            break;
        }
    }
    assert_eq!(exit.and_then(|m| m.get("exit").and_then(J::num)), Some(0.0), "the box's own exit");
    b.stop_all();
}

#[test]
fn ping_and_remove() {
    let dir = tmp("remove");
    let (_b, sock) = boxd(&dir);
    let (_c, mut r) = ask(&sock, r#"{"op":"ping"}"#);
    let m = next(&mut r).unwrap();
    assert_eq!((m.get("ok"), m.get("image").and_then(J::str)), (Some(&J::Bool(true)), Some("wisp-grid-user")));
    std::fs::create_dir_all(dir.join("boxes/u9/home/.wisp")).unwrap();
    let (_c, mut r) = ask(&sock, r#"{"op":"remove","id":"u9"}"#);
    assert_eq!(next(&mut r).and_then(|m| m.get("ok").cloned()), Some(J::Bool(true)));
    assert!(!dir.join("boxes/u9").exists());
    let (_c, mut r) = ask(&sock, r#"{"op":"remove","id":"../../etc"}"#);
    assert!(next(&mut r).and_then(|m| m.get("error").cloned()).is_some(), "never outside boxes");
    let (_c, mut r) = ask(&sock, "not json");
    assert_eq!(next(&mut r).and_then(|m| m.get("error").and_then(J::str).map(str::to_owned)).as_deref(), Some("Not JSON."));
}

#[test]
fn homes_move_once_and_never_through_a_link() {
    let dir = tmp("migrate");
    let o = Opts { socket: dir.join("s"), group: String::new(), data: dir.join("data"), boxes: dir.join("boxes"), docker: fake_docker(&dir), container: Container::default() };
    std::fs::create_dir_all(dir.join("data/users/u1/home/.wisp")).unwrap();
    std::fs::write(dir.join("data/users/u1/home/.wisp/x"), "1").unwrap();
    // u2's home is a link to somewhere else: never followed
    std::fs::create_dir_all(dir.join("elsewhere")).unwrap();
    std::fs::create_dir_all(dir.join("data/users/u2")).unwrap();
    std::os::unix::fs::symlink(dir.join("elsewhere"), dir.join("data/users/u2/home")).unwrap();
    // u3 is already moved
    std::fs::create_dir_all(dir.join("data/users/u3/home")).unwrap();
    std::fs::create_dir_all(dir.join("boxes/u3/home")).unwrap();
    let (moved, skipped) = migrate(&o).unwrap();
    assert_eq!((moved, skipped), (vec!["u1".to_owned()], vec!["u2".to_owned(), "u3".to_owned()]));
    assert_eq!(std::fs::read_to_string(dir.join("boxes/u1/home/.wisp/x")).unwrap(), "1");
    assert!(!dir.join("data/users/u1/home").exists());
    // and a run refuses a box whose files are still at the old place
    let b = Boxd::new(Opts { boxes: dir.join("boxes2"), ..o });
    assert!(b.prepare("u3").err().is_some_and(|e| e.contains("migrate")));
}
