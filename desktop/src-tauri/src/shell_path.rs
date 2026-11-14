// The PATH of the user's login shell, for an app started from Finder or the Dock: launchd hands it
// /usr/bin:/bin:/usr/sbin:/sbin, where `wisp serve` finds no agent CLI (v1 desktop/shell-path.js). The server starts
// on the PATH read last time (`<data>/shell-path`) and the login shell is asked again behind it, for the next start.
// Only the first open, with nothing saved, waits for the shell, and never past FIRST_LIMIT: a slow ~/.zshrc must not
// keep the window from showing (F-desk-5). Not on Windows, whose apps get the user's PATH.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// How long the first open (nothing saved) waits for the login shell before starting on the inherited PATH.
pub const FIRST_LIMIT: Duration = Duration::from_secs(2);
/// How long the shell may take behind a start that had a saved PATH.
const LIMIT: Duration = Duration::from_secs(20);
const MARK: &str = "__WISP__";
const FILE: &str = "shell-path";

/// The PATH between the marks: an rc file may print anything around it (a banner, a fortune).
pub fn parse(out: &str) -> Option<String> {
    let (_, rest) = out.split_once(MARK)?;
    let (path, _) = rest.split_once(MARK)?;
    Some(path.trim().to_owned()).filter(|p| !p.is_empty())
}

/// The login shell's PATH, or None when it fails or takes longer than `limit`. The clock is ours and the kill is
/// SIGKILL, to the shell's own process group (an interactive zsh ignores SIGTERM, and a slow rc file's children would
/// outlive it); stdin is closed, so a prompt in an rc file reads end-of-file.
pub fn read(shell: &Path, limit: Duration) -> Option<String> {
    let mut cmd = Command::new(shell);
    cmd.args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
    let mut child = cmd.spawn().ok()?;
    let mut out = child.stdout.take()?;
    // Read until the second mark, not to the end: a job the rc file put in the background (`watcher &`) may hold the
    // pipe long after the shell is done.
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let (mut text, mut buf) = (Vec::new(), [0u8; 4096]);
        loop {
            match out.read(&mut buf) {
                Ok(0) | Err(_) => return drop(tx.send(parse(&String::from_utf8_lossy(&text)))),
                Ok(n) => text.extend_from_slice(&buf[..n]),
            }
            let seen = String::from_utf8_lossy(&text);
            if seen.matches(MARK).count() >= 2 {
                return drop(tx.send(parse(&seen)));
            }
        }
    });
    let got = rx.recv_timeout(limit).ok().flatten();
    if got.is_none() {
        stop(&mut child);
    }
    got
}

// The shell and whatever its rc file started under it.
fn stop(child: &mut std::process::Child) {
    if !matches!(child.try_wait(), Ok(None)) {
        return;
    }
    #[cfg(unix)]
    let _ = Command::new("kill").args(["-KILL", "--", &format!("-{}", child.id())]).stdout(Stdio::null()).stderr(Stdio::null()).status();
    let _ = child.kill();
    let _ = child.wait();
}

// An app started from a terminal (`npx wisp-agents`, `npm run dev`) has the login shell's PATH already, and an
// interactive shell started under it would take the terminal over (and keep it, once killed at the limit).
#[cfg(unix)]
fn has_terminal() -> bool {
    std::fs::File::open("/dev/tty").is_ok()
}
#[cfg(not(unix))]
fn has_terminal() -> bool {
    false
}

fn saved(data: &Path) -> Option<String> {
    std::fs::read_to_string(data.join(FILE)).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
}

fn save(data: &Path, path: &str) {
    let _ = std::fs::create_dir_all(data).and_then(|()| std::fs::write(data.join(FILE), path));
}

/// The login shell's PATH first, then what this process had that it hasn't (an app started from a terminal, or
/// by `npx wisp-agents`, may carry more), once each.
pub fn merge(login: &str, inherited: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    login.split(':').chain(inherited.split(':')).filter(|d| !d.is_empty() && seen.insert(*d)).collect::<Vec<_>>().join(":")
}

/// The user's shell, as Terminal opens it.
pub fn login_shell() -> PathBuf {
    std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .map_or_else(|| PathBuf::from(if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" }), PathBuf::from)
}

/// The PATH to start the server on: the saved one at once, or the shell's if it answers within `first`; None keeps
/// the inherited one. The shell is asked either way, and a new answer is saved for the next start. Started from a
/// terminal, or on Windows, the inherited PATH is the user's already.
pub fn for_server(data: &Path, shell: &Path, first: Duration) -> Option<String> {
    if cfg!(windows) || has_terminal() {
        return None;
    }
    resolve(data, shell, first)
}

fn resolve(data: &Path, shell: &Path, first: Duration) -> Option<String> {
    let known = saved(data);
    let (tx, rx) = mpsc::channel();
    let (dir, sh, had) = (data.to_path_buf(), shell.to_path_buf(), known.clone());
    thread::spawn(move || {
        let fresh = read(&sh, LIMIT);
        if let Some(p) = fresh.as_deref().filter(|p| had.as_deref() != Some(*p)) {
            save(&dir, p);
        }
        let _ = tx.send(fresh);
    });
    let login = known.or_else(|| rx.recv_timeout(first).ok().flatten())?;
    Some(merge(&login, &std::env::var("PATH").unwrap_or_default()))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::Instant;

    fn room(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("wisp-shell-path-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    // A stand-in login shell: `body` runs with the -ilc command it's given as $2.
    // Written by a child, never by this process: a test on another thread forking while this one held the file open
    // for writing would leave its child with that fd, and exec'ing the script then fails with ETXTBSY.
    fn shell(dir: &Path, body: &str) -> PathBuf {
        let sh = dir.join("fake-shell");
        let wrote = Command::new("/bin/sh")
            .args(["-c", "printf '#!/bin/sh\\n%s\\n' \"$1\" > \"$2\" && chmod 755 \"$2\"", "sh", body])
            .arg(&sh)
            .status()
            .unwrap();
        assert!(wrote.success());
        sh
    }

    fn until(what: &str, f: impl Fn() -> bool) {
        let start = Instant::now();
        while !f() {
            assert!(start.elapsed() < Duration::from_secs(30), "waited 30 s for {what}");
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn parse_takes_the_path_between_the_marks() {
        assert_eq!(parse("Welcome!\n__WISP__/opt/homebrew/bin:/usr/bin__WISP__bye").as_deref(), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(parse("__WISP____WISP__"), None);
        assert_eq!(parse("no marks"), None);
        assert_eq!(parse("__WISP__/half"), None);
    }

    #[test]
    fn merge_puts_the_login_shell_first_and_keeps_the_rest_once() {
        assert_eq!(merge("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:/usr/bin"), "/opt/homebrew/bin:/usr/bin:/bin");
        assert_eq!(merge("/a::/b", ""), "/a:/b");
    }

    #[test]
    fn read_runs_the_login_shell_and_reads_its_path() {
        let dir = room("read");
        let sh = shell(&dir, r#"[ "$1" = -ilc ] || exit 3; echo "hello from rc"; PATH=/from/rc:/usr/bin; eval "$2""#);
        assert_eq!(read(&sh, Duration::from_secs(30)).as_deref(), Some("/from/rc:/usr/bin"));
    }

    #[test]
    fn read_gives_up_on_a_slow_rc_file_at_its_limit() {
        let dir = room("slow");
        let sh = shell(&dir, "trap '' TERM; sleep 60; eval \"$2\"");
        let start = Instant::now();
        assert_eq!(read(&sh, Duration::from_millis(300)), None);
        // the spawn itself may take seconds on a loaded machine; the shell's own 60 s never counts
        assert!(start.elapsed() < Duration::from_secs(20), "took {:?}", start.elapsed());
    }

    // an rc file that leaves a job in the background holding stdout: the PATH is read at its second mark
    #[test]
    fn read_does_not_wait_on_a_background_job_holding_the_pipe() {
        let dir = room("bg");
        let sh = shell(&dir, "sleep 60 & PATH=/bg/bin; eval \"$2\"");
        let start = Instant::now();
        assert_eq!(read(&sh, Duration::from_secs(50)).as_deref(), Some("/bg/bin"));
        assert!(start.elapsed() < Duration::from_secs(30), "waited on the background job: {:?}", start.elapsed());
    }

    // killed at the limit, the rc file's own children go with the shell (its process group, as read() starts it)
    #[test]
    fn stop_takes_the_shells_children_with_it() {
        let dir = room("group");
        let pid = dir.join("pid");
        let sh = shell(&dir, &format!("sleep 60 & echo $! > {}; wait", pid.display()));
        let mut cmd = Command::new(&sh);
        std::os::unix::process::CommandExt::process_group(&mut cmd, 0);
        let mut child = cmd.stdout(Stdio::null()).spawn().unwrap();
        until("the rc file's sleep to start", || saved_pid(&pid).is_some());
        stop(&mut child);
        let sleep = saved_pid(&pid).unwrap();
        until("the rc file's sleep to be gone", || {
            !Command::new("kill").args(["-0", &sleep]).stderr(Stdio::null()).status().unwrap().success()
        });
    }

    fn saved_pid(file: &Path) -> Option<String> {
        std::fs::read_to_string(file).ok().map(|s| s.trim().to_owned()).filter(|s| !s.is_empty())
    }

    #[test]
    fn read_reads_eof_where_an_rc_file_prompts() {
        let dir = room("prompt");
        let sh = shell(&dir, "read answer; PATH=/after/prompt; eval \"$2\"");
        assert_eq!(read(&sh, Duration::from_secs(30)).as_deref(), Some("/after/prompt"));
    }

    // F-desk-5: nothing saved and a ~/.zshrc that takes 30 s: the server starts after `first`, on the inherited PATH.
    #[test]
    fn a_slow_zshrc_never_holds_the_first_open_past_its_limit() {
        let dir = room("first-slow");
        let sh = shell(&dir, "sleep 30; eval \"$2\"");
        let start = Instant::now();
        assert_eq!(resolve(&dir.join("data"), &sh, Duration::from_millis(400)), None);
        assert!(start.elapsed() < Duration::from_secs(2), "took {:?}", start.elapsed());
    }

    #[test]
    fn the_first_open_waits_for_a_quick_shell_and_saves_its_path() {
        let dir = room("first-quick");
        let sh = shell(&dir, "PATH=/quick/bin:/usr/bin; eval \"$2\"");
        let data = dir.join("data");
        assert!(resolve(&data, &sh, Duration::from_secs(30)).unwrap().starts_with("/quick/bin:/usr/bin"));
        until("the PATH to be saved", || saved(&data).as_deref() == Some("/quick/bin:/usr/bin"));
    }

    // A saved PATH starts the server at once; a CLI installed since (a new PATH) is saved for the next start.
    #[test]
    fn a_saved_path_starts_at_once_and_a_new_one_is_saved_behind_it() {
        let dir = room("saved");
        let data = dir.join("data");
        save(&data, "/old/bin");
        let sh = shell(&dir, "sleep 1; PATH=/new/bin; eval \"$2\"");
        let start = Instant::now();
        assert!(resolve(&data, &sh, Duration::from_secs(30)).unwrap().starts_with("/old/bin:"));
        assert!(start.elapsed() < Duration::from_millis(500), "waited for the shell: {:?}", start.elapsed());
        until("the new PATH to be saved", || saved(&data).as_deref() == Some("/new/bin"));
    }

    #[test]
    fn a_shell_that_fails_keeps_the_saved_path() {
        let dir = room("fails");
        let data = dir.join("data");
        save(&data, "/kept/bin");
        let sh = shell(&dir, "exit 1");
        assert!(resolve(&data, &sh, Duration::from_secs(30)).unwrap().starts_with("/kept/bin:"));
        thread::sleep(Duration::from_millis(300));
        assert_eq!(saved(&data).as_deref(), Some("/kept/bin"));
    }
}
