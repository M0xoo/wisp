//! The work-in-progress pin over a real git: it never writes the user's index, so their `git commit`
//! never meets wisp's `index.lock` (CI flake `serve_code` 4dfb2791: `git stash create` refreshed and
//! rewrote `.git/index` under the lock while the test committed).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll, Waker};

use wisp_harness_kit::wip::work_in_progress;
use wisp_harness_kit::{Disk, DiskFuture};

/// Git as the proc service runs it (`GIT_OPTIONAL_LOCKS=0`), synchronously: the futures are ready at once.
struct RealDisk;

impl Disk for RealDisk {
    fn read(&self, abs: &str) -> DiskFuture<'_, Option<String>> {
        let v = std::fs::read_to_string(abs).ok();
        Box::pin(async move { v })
    }
    fn git_env<'a>(&'a self, cwd: &'a str, args: &'a [&'a str], env: &'a [(&'a str, &'a str)]) -> DiskFuture<'a, Option<String>> {
        let o = Command::new("git").args(args).current_dir(cwd).env("GIT_OPTIONAL_LOCKS", "0").envs(env.iter().copied()).output().unwrap();
        let v = o.status.success().then(|| String::from_utf8_lossy(&o.stdout).into_owned());
        Box::pin(async move { v })
    }
    fn remove<'a>(&'a self, abs: &'a str) -> DiskFuture<'a, ()> {
        let _ = std::fs::remove_file(abs);
        Box::pin(async {})
    }
}

fn now<T>(f: impl Future<Output = T>) -> T {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("RealDisk is synchronous"),
    }
}

fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let o = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    if o.status.success() { Ok(String::from_utf8_lossy(&o.stdout).trim().to_owned()) } else { Err(String::from_utf8_lossy(&o.stderr).into_owned()) }
}

fn repo(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("wisp-wip-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(d.join("sub")).unwrap();
    std::fs::write(d.join("a.txt"), "a\n").unwrap();
    std::fs::write(d.join("sub/b.txt"), "b\n").unwrap();
    git(&d, &["init", "-q", "-b", "main"]).unwrap();
    git(&d, &["add", "."]).unwrap();
    git(&d, &["commit", "-qm", "init"]).unwrap();
    d
}

#[test]
fn the_users_commits_never_fail_while_wisp_pins_the_work_in_progress() {
    let d = repo("commits");
    std::fs::write(d.join("sub/b.txt"), "b, edited\n").unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let pins = {
        let (d, stop) = (d.clone(), stop.clone());
        std::thread::spawn(move || {
            let mut n = 0;
            while !stop.load(Ordering::Relaxed) {
                // a pin may lose a race with the user's commit (then it pins HEAD); theirs never may
                n += usize::from(now(work_in_progress(&RealDisk, d.to_str().unwrap())).is_some());
            }
            n
        })
    };
    let mut failed = Vec::new();
    for i in 0..150 {
        std::fs::write(d.join("a.txt"), format!("a {i}\n")).unwrap();
        if let Err(e) = git(&d, &["commit", "-qm", &format!("c{i}"), "--", "a.txt"]) {
            failed.push(e);
        }
    }
    stop.store(true, Ordering::Relaxed);
    let pinned = pins.join().unwrap();
    assert!(pinned > 0, "the pin ran alongside and pinned the edit");
    assert!(failed.is_empty(), "{} of 150 commits failed while {pinned} pins ran: {:?}", failed.len(), failed.first());
    // nothing of wisp's is left in the git dir
    let left: Vec<_> = std::fs::read_dir(d.join(".git")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.starts_with("wisp-")).collect();
    assert!(left.is_empty(), "{left:?}");
    let _ = std::fs::remove_dir_all(&d);
}

#[test]
fn the_pin_holds_what_stash_create_held_and_leaves_the_index_alone() {
    let d = repo("content");
    let cwd = d.join("sub");
    let cwd = cwd.to_str().unwrap();
    assert_eq!(now(work_in_progress(&RealDisk, cwd)), None, "a clean checkout pins HEAD");
    std::fs::write(d.join("a.txt"), "a, edited\n").unwrap();
    std::fs::write(d.join("new.txt"), "staged new\n").unwrap();
    git(&d, &["add", "new.txt"]).unwrap();
    git(&d, &["rm", "-q", "--cached", "sub/b.txt"]).unwrap();
    std::fs::write(d.join("loose.txt"), "untracked\n").unwrap();
    let index = std::fs::read(d.join(".git/index")).unwrap();
    let sha = now(work_in_progress(&RealDisk, cwd)).expect("edits pin a commit");
    assert_eq!(std::fs::read(d.join(".git/index")).unwrap(), index, "the user's index is byte for byte the same");
    let files = git(&d, &["ls-tree", "-r", "--name-only", &sha]).unwrap();
    assert_eq!(files.lines().collect::<Vec<_>>(), ["a.txt", "new.txt"], "staged new in, staged removal out, untracked out");
    assert_eq!(git(&d, &["show", &format!("{sha}:a.txt")]).unwrap(), "a, edited");
    assert_eq!(git(&d, &["rev-parse", &format!("{sha}^")]).unwrap(), git(&d, &["rev-parse", "HEAD"]).unwrap());
    let _ = std::fs::remove_dir_all(&d);
}
