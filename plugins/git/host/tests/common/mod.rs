//! Real repos in temp folders, and the service over the real proc service. Setup uses std::process
//! (test-only): the code under test runs every git call through wisp-proc.
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use wisp_git::{GitServiceImpl, Service};
use wisp_kernel::{Call, Caller, CancellationToken};

static N: AtomicU32 = AtomicU32::new(0);

pub struct Tmp(pub PathBuf);

impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn tmp(name: &str) -> Tmp {
    let d = std::env::temp_dir().join(format!("wisp-git-{name}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    Tmp(std::fs::canonicalize(&d).unwrap())
}

pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

pub fn write(dir: &Path, f: &str, text: &str) {
    let p = dir.join(f);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(p, text).unwrap();
}

/// A repo on `main` with one commit of `a.txt` (30 lines), cloned from a bare origin.
pub fn repo(t: &Tmp) -> PathBuf {
    let origin = t.0.join("origin.git");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "--bare", "-b", "main"]);
    let dir = t.0.join("repo");
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.email", "qa@wisp.test"), ("user.name", "QA"), ("commit.gpgsign", "false")] {
        git(&dir, &["config", k, v]);
    }
    let lines: Vec<String> = (1..=30).map(|i| format!("line {i}")).collect();
    write(&dir, "a.txt", &format!("{}\n", lines.join("\n")));
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "base"]);
    git(&dir, &["remote", "add", "origin", origin.to_str().unwrap()]);
    git(&dir, &["push", "-q", "-u", "origin", "main"]);
    git(&dir, &["remote", "set-head", "origin", "main"]);
    dir
}

pub fn svc() -> Arc<GitServiceImpl> {
    wisp_git::service(wisp_proc::local(), None, Arc::new(|| 1_000_000), None)
}

pub fn service() -> (Arc<GitServiceImpl>, Service) {
    let s = svc();
    (s.clone(), Service(s))
}

pub fn user() -> Call {
    Call::new_root(Caller::user())
}

pub fn stranger() -> Call {
    Call::new_root(Caller { set: "preview".into(), session: None, plugin: None })
}

pub fn owner() -> CancellationToken {
    CancellationToken::new()
}
