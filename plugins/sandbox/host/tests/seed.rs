//! ADR-0047: a sandbox's wisp takes a project in (a bundle of every ref, the uncommitted changes, the branch, origin
//! and author) into `~/code/<name>`, and runs its `.wisp/sandbox.sh` once; anywhere else the seed is refused.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::process::Command;

use base64::Engine as _;
use serde_json::json;
use wisp_kernel::Caller;
use wisp_sandbox::SandboxPlugin;
use wisp_testkit::TestApp;

fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("wisp-sbx-{name}-{}", wisp_kernel::ids::uuid7()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn git(at: &Path, args: &[&str]) -> String {
    let o = Command::new("git").current_dir(at).args(args).output().unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).into_owned()
}

/// A repo on branch `fix` with a commit, a setup script, and an uncommitted change; its seed args.
fn project() -> (PathBuf, serde_json::Value) {
    let p = dir("proj");
    git(&p, &["init", "-q", "-b", "main"]);
    std::fs::write(p.join("app.js"), "one\n").unwrap();
    std::fs::create_dir_all(p.join(".wisp")).unwrap();
    std::fs::write(p.join(".wisp/sandbox.sh"), "echo set up\n").unwrap();
    git(&p, &["add", "."]);
    git(&p, &["-c", "user.name=T", "-c", "user.email=t@e", "commit", "-qm", "first"]);
    git(&p, &["checkout", "-qb", "fix"]);
    std::fs::write(p.join("app.js"), "one\ntwo, not committed\n").unwrap();
    let bundle = dir("bundle").join("b.bundle");
    git(&p, &["bundle", "create", bundle.to_str().unwrap(), "--all"]);
    let b = base64::engine::general_purpose::STANDARD.encode(std::fs::read(&bundle).unwrap());
    let patch = git(&p, &["diff", "HEAD", "--binary"]);
    (p, json!({ "name": "my app", "bundle": b, "patch": patch, "branch": "fix", "origin": "git@github.com:me/app.git", "authorName": "Ada", "authorEmail": "ada@example.com" }))
}

#[tokio::test(flavor = "multi_thread")]
async fn only_a_sandbox_takes_a_seed_and_its_setup_runs_once() {
    let home = dir("home");
    let (_p, args) = project();
    // a computer refuses: a seed would write into its ~/code
    let here = TestApp::new().with(SandboxPlugin { inside: Some(false), home: Some(home.clone()) }).service(wisp_proc::local()).start().await;
    let no = here.call(Caller::user(), "sandbox.seed", args.clone()).await.unwrap_err();
    assert!(no.message.contains("Only a sandbox"), "{no:?}");
    let sb = TestApp::new().with(SandboxPlugin { inside: Some(true), home: Some(home.clone()) }).service(wisp_proc::local()).start().await;
    let out = sb.call(Caller::user(), "sandbox.seed", args.clone()).await.unwrap();
    let cwd = PathBuf::from(out["cwd"].as_str().unwrap());
    assert_eq!(cwd, home.join("code/my-app"));
    assert_eq!(std::fs::read_to_string(cwd.join("app.js")).unwrap(), "one\ntwo, not committed\n", "the uncommitted change came along");
    assert_eq!(git(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "fix");
    assert_eq!(git(&cwd, &["remote", "get-url", "origin"]).trim(), "git@github.com:me/app.git");
    assert_eq!(git(&cwd, &["config", "user.email"]).trim(), "ada@example.com");
    assert_eq!(out["setup"].as_str().map(str::trim), Some("set up"), "{out}");
    // the same project again: a fresh copy, and the setup doesn't run twice
    let again = sb.call(Caller::user(), "sandbox.seed", args).await.unwrap();
    assert!(again.get("setup").is_none_or(serde_json::Value::is_null), "{again}");
    assert!(home.join(".sandbox/setup-my-app").is_file());
}

/// A delegate's work comes back as the difference from what came in: an edit and a new file, and nothing of the lead's
/// own uncommitted change (it came in with the seed), so the patch applies to the lead's folder as it is.
#[tokio::test(flavor = "multi_thread")]
async fn a_delegates_changes_come_back_as_the_difference_from_what_came_in() {
    let home = dir("home2");
    let (lead, args) = project();
    let sb = TestApp::new().with(SandboxPlugin { inside: Some(true), home: Some(home.clone()) }).service(wisp_proc::local()).start().await;
    let out = sb.call(Caller::user(), "sandbox.seed", args).await.unwrap();
    let cwd = PathBuf::from(out["cwd"].as_str().unwrap());
    std::fs::write(cwd.join("app.js"), "one\ntwo, not committed\nthree, by the delegate\n").unwrap();
    std::fs::write(cwd.join("new.txt"), "made there\n").unwrap();
    let p = sb.call(Caller::user(), "sandbox.patch", serde_json::json!({ "cwd": cwd })).await.unwrap();
    let patch = p["patch"].as_str().unwrap().to_owned();
    assert_eq!(patch.matches("diff --git ").count(), 2, "{patch}");
    assert!(!patch.contains("+two, not committed"), "the lead's own change isn't sent back: {patch}");
    let o = Command::new("git").current_dir(&lead).args(["apply", "-"]).stdin(std::process::Stdio::piped()).spawn().unwrap();
    o.stdin.as_ref().unwrap().write_all(patch.as_bytes()).unwrap();
    assert!(o.wait_with_output().unwrap().status.success());
    assert_eq!(std::fs::read_to_string(lead.join("app.js")).unwrap(), "one\ntwo, not committed\nthree, by the delegate\n");
    assert_eq!(std::fs::read_to_string(lead.join("new.txt")).unwrap(), "made there\n");
    // outside ~/code: nothing to give back
    assert!(sb.call(Caller::user(), "sandbox.patch", serde_json::json!({ "cwd": "/etc" })).await.is_err());
}
