//! The work-in-progress pin's cost on a big checkout (spikes/wip-index): an ignored test, run by hand.
//! A repo of `WISP_WIP_FILES` (50,000) tracked files under /tmp, made once and reused, with 20 edits,
//! a staged new file and a staged removal; the pin is timed `WISP_WIP_RUNS` (9) times.
//!
//!     CARGO_TARGET_DIR=/tmp/wisp-target-coder cargo test -p wisp-harness-kit --release --test wip_bench -- --ignored --nocapture
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::print_stdout)]

use std::future::Future;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::task::{Context, Poll, Waker};
use std::time::Instant;

use wisp_harness_kit::wip::work_in_progress;
use wisp_harness_kit::{Disk, DiskFuture};

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
    fn copy<'a>(&'a self, from: &'a str, to: &'a str) -> DiskFuture<'a, bool> {
        let v = copy_keeping_mtime(Path::new(from), Path::new(to)).is_ok();
        Box::pin(async move { v })
    }
}

/// As `ProcSys::copy_file` (plugins/runtime/host/src/sys.rs): one open handle, the mtime kept.
fn copy_keeping_mtime(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut src = std::fs::File::open(from)?;
    let mtime = src.metadata()?.modified()?;
    let mut dst = std::fs::File::create(to)?;
    std::io::copy(&mut src, &mut dst)?;
    dst.set_modified(mtime)
}

fn now<T>(f: impl Future<Output = T>) -> T {
    let mut f = std::pin::pin!(f);
    match f.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(v) => v,
        Poll::Pending => panic!("RealDisk is synchronous"),
    }
}

fn git(dir: &Path, args: &[&str]) {
    let o = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
}

fn env_n(name: &str, default: usize) -> usize {
    std::env::var(name).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn big_repo(files: usize) -> PathBuf {
    let d = std::env::temp_dir().join(format!("wisp-wip-bench-{files}"));
    if d.join(".git/wisp-bench-ready").exists() {
        return d;
    }
    let _ = std::fs::remove_dir_all(&d);
    for i in 0..files {
        let dir = d.join(format!("d{:03}/e{:02}", i / 500, (i / 25) % 20));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("f{i}.txt")), format!("file {i}\nline two\n")).unwrap();
    }
    git(&d, &["init", "-q", "-b", "main"]);
    git(&d, &["add", "."]);
    git(&d, &["commit", "-qm", "init"]);
    for i in (0..files).step_by(files / 20) {
        let f = d.join(format!("d{:03}/e{:02}/f{i}.txt", i / 500, (i / 25) % 20));
        std::fs::write(f, format!("file {i}, edited\n")).unwrap();
    }
    std::fs::write(d.join("staged-new.txt"), "new\n").unwrap();
    git(&d, &["add", "staged-new.txt"]);
    git(&d, &["rm", "-q", "--cached", "d000/e00/f1.txt"]);
    git(&d, &["status", "--porcelain"]); // the user's index has a fresh stat cache, as after their own git status
    std::fs::write(d.join(".git/wisp-bench-ready"), "").unwrap();
    d
}

#[test]
#[ignore = "a bench: run by hand"]
fn bench_the_pin_on_a_big_checkout() {
    let files = env_n("WISP_WIP_FILES", 50_000);
    let runs = env_n("WISP_WIP_RUNS", 9);
    let d = big_repo(files);
    let cwd = d.to_str().unwrap();
    let mut ms: Vec<f64> = (0..runs)
        .map(|_| {
            let t = Instant::now();
            let sha = now(work_in_progress(&RealDisk, cwd));
            assert!(sha.is_some(), "the edits pin a commit");
            t.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    ms.sort_by(f64::total_cmp);
    println!("pin on {files} tracked files, {runs} runs: min {:.0} ms, median {:.0} ms, max {:.0} ms", ms[0], ms[runs / 2], ms[runs - 1]);
}
