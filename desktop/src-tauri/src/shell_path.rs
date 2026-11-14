// The PATH of the user's login shell, for an app started from Finder or the Dock: launchd hands it
// /usr/bin:/bin:/usr/sbin:/sbin, where `wisp serve` finds no agent CLI (v1 desktop/shell-path.js). The server starts at
// once, on the PATH read last time (`<data>/shell-path`), or the inherited one on the very first open; the login
// shell is asked behind it, and its PATH is handed to the running server when it lands (`wisp:path`, src/server.rs)
// and saved for the next start. Nothing the first window waits on waits for the shell: a slow ~/.zshrc must not keep
// it from showing (F-desk-5). Not on Windows, whose apps get the user's PATH.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// How long the login shell may take, behind the server's start.
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

/// The server's PATH: `now` to start on, at once (the saved one; None keeps the inherited one), and `later`, the login
/// shell's once it answers, when that differs from `now`.
pub struct Start {
    pub now: Option<String>,
    pub later: Option<mpsc::Receiver<String>>,
}

/// Started from a terminal, or on Windows, the inherited PATH is the user's already: nothing to ask.
pub fn for_server(data: &Path, shell: &Path) -> Start {
    if cfg!(windows) || has_terminal() {
        return Start { now: None, later: None };
    }
    plan(data, shell, LIMIT)
}

// Never waits: the shell runs on a thread of its own, saves a new answer for the next start and sends it on.
fn plan(data: &Path, shell: &Path, limit: Duration) -> Start {
    let inherited = std::env::var("PATH").unwrap_or_default();
    let known = saved(data);
    let now = known.as_deref().map(|login| merge(login, &inherited));
    let (tx, rx) = mpsc::channel();
    let (dir, sh, started) = (data.to_path_buf(), shell.to_path_buf(), now.clone());
    thread::spawn(move || {
        let Some(fresh) = read(&sh, limit) else { return };
        if known.as_deref() != Some(fresh.as_str()) {
            save(&dir, &fresh);
        }
        let merged = merge(&fresh, &inherited);
        if started.as_deref() != Some(merged.as_str()) {
            let _ = tx.send(merged);
        }
    });
    Start { now, later: Some(rx) }
}

/// Starts the server (`begin`) on `start.now` straight away, and hands it the login shell's PATH (`hand`, on a thread
/// of its own) whenever that lands. The first window waits on `begin` only, never on the shell.
pub fn start_then_hand<T>(start: Start, begin: impl FnOnce(Option<&str>) -> T, hand: impl FnOnce(String) + Send + 'static) -> T {
    let began = begin(start.now.as_deref());
    if let Some(later) = start.later {
        thread::spawn(move || {
            if let Ok(path) = later.recv() {
                hand(path);
            }
        });
    }
    began
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

    // F-desk-5: nothing saved and a ~/.zshrc that takes 30 s: the server starts at once, on the inherited PATH.
    #[test]
    fn a_slow_zshrc_never_holds_the_first_open() {
        let dir = room("first-slow");
        let sh = shell(&dir, "sleep 30; eval \"$2\"");
        let start = Instant::now();
        let plan = plan(&dir.join("data"), &sh, Duration::from_secs(60));
        assert_eq!(plan.now, None);
        assert!(start.elapsed() < Duration::from_millis(500), "waited for the shell: {:?}", start.elapsed());
        assert!(plan.later.unwrap().try_recv().is_err(), "nothing yet");
    }

    // the start order: the server starts before the shell answers, and gets its PATH after, never the other way
    #[test]
    fn the_server_starts_before_the_shell_answers_and_gets_its_path_after() {
        let dir = room("order");
        let sh = shell(&dir, "sleep 1; PATH=/login/bin:/usr/bin; eval \"$2\"");
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let (began, handed) = (seen.clone(), seen.clone());
        let start = Instant::now();
        let at = shell_path_start(&dir, &sh, &began, tx, &handed);
        assert!(at < Duration::from_millis(500), "the start waited on the shell: {at:?}");
        let path = rx.recv_timeout(Duration::from_secs(30)).unwrap();
        assert!(path.starts_with("/login/bin:/usr/bin"), "{path}");
        assert!(start.elapsed() >= Duration::from_secs(1));
        assert_eq!(*seen.lock().unwrap(), vec!["start on the inherited PATH".to_owned(), format!("hand {path}")]);
        until("the PATH to be saved", || saved(&dir.join("data")).as_deref() == Some("/login/bin:/usr/bin"));
    }

    fn shell_path_start(
        dir: &Path,
        sh: &Path,
        began: &std::sync::Arc<std::sync::Mutex<Vec<String>>>,
        tx: mpsc::Sender<String>,
        handed: &std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) -> Duration {
        let start = Instant::now();
        let handed = handed.clone();
        start_then_hand(
            plan(&dir.join("data"), sh, Duration::from_secs(30)),
            |now| began.lock().unwrap().push(now.map_or_else(|| "start on the inherited PATH".to_owned(), |p| format!("start on {p}"))),
            move |path| {
                handed.lock().unwrap().push(format!("hand {path}"));
                let _ = tx.send(path);
            },
        );
        start.elapsed()
    }

    // A saved PATH starts the server at once; a CLI installed since (a new PATH) is handed over and saved for the next.
    #[test]
    fn a_saved_path_starts_at_once_and_a_new_one_is_handed_over_and_saved() {
        let dir = room("saved");
        let data = dir.join("data");
        save(&data, "/old/bin");
        let sh = shell(&dir, "sleep 1; PATH=/new/bin; eval \"$2\"");
        let start = Instant::now();
        let plan = plan(&data, &sh, Duration::from_secs(30));
        assert!(plan.now.unwrap().starts_with("/old/bin:"));
        assert!(start.elapsed() < Duration::from_millis(500), "waited for the shell: {:?}", start.elapsed());
        assert!(plan.later.unwrap().recv_timeout(Duration::from_secs(30)).unwrap().starts_with("/new/bin:"));
        assert_eq!(saved(&data).as_deref(), Some("/new/bin"));
    }

    // the same PATH as last time: nothing to hand over
    #[test]
    fn the_same_path_as_last_time_is_not_handed_over() {
        let dir = room("same");
        let data = dir.join("data");
        save(&data, "/same/bin");
        let sh = shell(&dir, "PATH=/same/bin; eval \"$2\"");
        let plan = plan(&data, &sh, Duration::from_secs(30));
        assert!(plan.now.unwrap().starts_with("/same/bin:"));
        assert!(plan.later.unwrap().recv_timeout(Duration::from_secs(30)).is_err(), "the thread ends without a word");
    }

    #[test]
    fn a_shell_that_fails_keeps_the_saved_path() {
        let dir = room("fails");
        let data = dir.join("data");
        save(&data, "/kept/bin");
        let sh = shell(&dir, "exit 1");
        let plan = plan(&data, &sh, Duration::from_secs(30));
        assert!(plan.now.unwrap().starts_with("/kept/bin:"));
        assert!(plan.later.unwrap().recv_timeout(Duration::from_secs(30)).is_err(), "nothing handed over");
        assert_eq!(saved(&data).as_deref(), Some("/kept/bin"));
    }
}
