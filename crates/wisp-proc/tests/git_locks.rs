//! wisp's git reads never take `index.lock` (edge case Git 1, #756 CI: `serve_code.rs:33` saw the user's
//! `git commit` fail with `index.lock: File exists` while wisp refreshed the same repo).
#![cfg(unix)]
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::assert_is_empty,
    reason = "a test: failing loudly is the point"
)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use wisp_proc::{Env, ExecOpts};

fn temp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("wisp-proc-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn git(dir: &Path, args: &[&str]) -> std::process::Output {
    Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap()
}

#[test]
fn a_git_program_gets_no_optional_locks_unless_the_caller_says() {
    for bin in ["git", "/usr/bin/git", "C:\\Program Files\\Git\\cmd\\git.exe", "GIT.EXE"] {
        assert_eq!(Env::default().for_program(bin).set, [("GIT_OPTIONAL_LOCKS".to_owned(), "0".to_owned())], "{bin}");
    }
    assert!(Env::default().for_program("gitk").set.is_empty());
    assert!(Env::default().for_program("/bin/sh").set.is_empty());
    let mine = Env::default().with("GIT_OPTIONAL_LOCKS", "1").for_program("git");
    assert_eq!(mine.set.len(), 1, "the caller's value wins");
}

#[tokio::test]
async fn a_git_child_sees_git_optional_locks_0() {
    let d = temp("env");
    let fake = d.join("git");
    std::fs::write(&fake, "#!/bin/sh\necho \"locks=$GIT_OPTIONAL_LOCKS\"\n").unwrap();
    Command::new("chmod").args(["755"]).arg(&fake).status().unwrap();
    let r = wisp_proc::local().exec(&fake.to_string_lossy(), &[], ExecOpts::default()).await.unwrap();
    assert_eq!(r.stdout_text().trim(), "locks=0");
    let _ = std::fs::remove_dir_all(&d);
}

/// The user commits 40 times while wisp runs `git status` (which refreshes the index) in a loop through
/// the proc service: every commit lands.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_commit_lands_while_wisp_refreshes_status_in_a_loop() {
    let repo = temp("race");
    assert!(git(&repo, &["init", "-q"]).status.success());
    std::fs::write(repo.join("a.txt"), "0").unwrap();
    git(&repo, &["add", "."]);
    assert!(git(&repo, &["commit", "-qm", "init"]).status.success());
    let stop = Arc::new(AtomicBool::new(false));
    let proc = wisp_proc::local();
    let (stopped, dir) = (stop.clone(), repo.clone());
    let refresher = tokio::spawn(async move {
        let mut n = 0u32;
        while !stopped.load(Ordering::Relaxed) {
            let o = ExecOpts { cwd: Some(dir.clone()), ..ExecOpts::default() };
            let r = proc.exec("git", &["status".to_owned(), "--porcelain".to_owned()], o).await.unwrap();
            assert!(r.exit.success(), "status: {}", r.stderr_text());
            n += 1;
        }
        n
    });
    let dir = repo.clone();
    let commits = tokio::task::spawn_blocking(move || {
        for i in 1..=40 {
            std::fs::write(dir.join("a.txt"), i.to_string()).unwrap();
            let o = git(&dir, &["commit", "-qam", &format!("c{i}")]);
            assert!(o.status.success(), "commit {i}: {}", String::from_utf8_lossy(&o.stderr));
        }
    });
    commits.await.unwrap();
    stop.store(true, Ordering::Relaxed);
    let refreshes = refresher.await.unwrap();
    assert!(refreshes > 0, "wisp refreshed while the user committed");
    let _ = std::fs::remove_dir_all(&repo);
}
