//! An archived task's worktree, end to end (ADR-0053): archiving removes a clean one, a follow-up brings it
//! back on its branch and runs there; one that can't come back is refused with why and runs nowhere; Keep
//! worktree on means archiving leaves it (v1 removed it anyway).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::too_many_lines)]

mod common;

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use common::{Api, ended, records, start_with, temp};
use serde_json::{Value, json};

fn git(dir: &Path, args: &[&str]) -> String {
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
    String::from_utf8_lossy(&o.stdout).trim().to_owned()
}

/// `proj` as a repo with one commit.
fn repo(dir: &Path) -> PathBuf {
    let repo = std::fs::canonicalize(dir.join("proj")).unwrap();
    git(&repo, &["init", "-q", "-b", "main"]);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "init"]);
    repo
}

async fn until_gone(path: &str, what: &str) {
    let at = Instant::now();
    while Path::new(path).exists() {
        assert!(at.elapsed() < Duration::from_secs(30), "{what}: {path} is still there");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// A task in a worktree whose first turn has ended: (id, the worktree's slot).
async fn task_in_a_worktree(api: &Api, repo: &Path) -> (String, Value) {
    let made = api.cmd("runtime.create", json!({ "prompt": "fix it", "cwd": repo, "agent": "claude", "worktree": true })).await;
    let id = made["id"].as_str().unwrap().to_owned();
    api.until(&id, "the first turn ends", |t| t.last().is_some_and(ended)).await;
    let s = api.cmd("runtime.get", json!({ "id": id })).await;
    let wt = s["ext"]["wisp.worktrees"].clone();
    let path = wt["path"].as_str().unwrap();
    assert_ne!(path, repo.display().to_string(), "it ran in a worktree: {s}");
    // the fake's edit, committed on the task's branch: clean, nothing only the folder holds
    git(Path::new(path), &["commit", "-qam", "the fix"]);
    (id, wt)
}

/// The fake agent's recorded runs, by folder.
fn run_folders(rec: &Path) -> Vec<String> {
    records(&rec.join("claude.jsonl")).iter().filter_map(|r| r["cwd"].as_str().map(str::to_owned)).collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn a_follow_up_on_an_archived_task_runs_in_its_worktree_brought_back_on_its_branch() {
    let dir = temp("serve-wt-back");
    let rec = dir.join("rec");
    let repo = repo(&dir);
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let (id, wt) = task_in_a_worktree(&api, &repo).await;
    let (path, branch, cwd) = (wt["path"].as_str().unwrap(), wt["branch"].as_str().unwrap(), wt["cwd"].as_str().unwrap());
    api.cmd("runtime.archive", json!({ "id": id, "archived": true })).await;
    until_gone(path, "archiving removes the clean worktree").await;
    assert_eq!(git(&repo, &["branch", "--list", branch]).trim_start_matches(['*', '+', ' ']), branch, "its branch stays");

    api.cmd("runtime.followUp", json!({ "id": id, "text": "one more" })).await;
    let turns = api.until(&id, "the follow-up ends", |t| t.len() == 2 && t.last().is_some_and(ended)).await;
    assert_ne!(turns[1]["presentation"]["blocks"][0]["title"], "Not started", "{:?}", turns[1]);
    assert!(Path::new(path).is_dir(), "brought back");
    assert_eq!(git(Path::new(path), &["branch", "--show-current"]), branch, "on its own branch");
    let ran = run_folders(&rec);
    assert_eq!(ran.len(), 2, "{ran:?}");
    let same = |a: &str, b: &str| std::fs::canonicalize(a).ok() == std::fs::canonicalize(b).ok();
    assert!(same(&ran[1], cwd), "the follow-up ran in the worktree: {ran:?}, {cwd}");
    drop(serve);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_task_whose_worktree_cant_come_back_is_refused_with_why_and_runs_nowhere() {
    let dir = temp("serve-wt-refused");
    let rec = dir.join("rec");
    let repo = repo(&dir);
    let (serve, port) = start_with(&dir, &[("FAKE_RECORD", rec.to_str().unwrap())]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let (id, wt) = task_in_a_worktree(&api, &repo).await;
    let (path, branch) = (wt["path"].as_str().unwrap(), wt["branch"].as_str().unwrap());
    api.cmd("runtime.archive", json!({ "id": id, "archived": true })).await;
    until_gone(path, "archiving removes the clean worktree").await;
    git(&repo, &["branch", "-D", branch]); // nothing left to bring it back from

    api.cmd("runtime.followUp", json!({ "id": id, "text": "one more" })).await;
    let turns = api.until(&id, "the follow-up is refused", |t| t.len() == 2 && t.last().is_some_and(ended)).await;
    let hero = &turns[1]["presentation"]["blocks"][0];
    assert_eq!(hero["title"], "Not started", "{:?}", turns[1]);
    let why = hero["summary"].as_str().unwrap();
    assert!(why.contains("couldn't come back") && why.contains(branch), "{why}");
    assert!(!Path::new(path).exists(), "no folder made at its path");
    assert_eq!(run_folders(&rec).len(), 1, "nothing ran for the refused turn, here or anywhere else");
    let task = api.cmd("runtime.get", json!({ "id": id })).await;
    assert_eq!(task["archived"], false, "out of Archived, where the refusal would go unseen: {task}");
    drop(serve);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test(flavor = "multi_thread")]
async fn archiving_a_task_with_keep_worktree_on_leaves_its_worktree() {
    let dir = temp("serve-wt-kept");
    let repo = repo(&dir);
    let (serve, port) = start_with(&dir, &[]);
    let api = Api { http: reqwest::Client::new(), port, n: 0.into() };
    let (kept, kept_wt) = task_in_a_worktree(&api, &repo).await;
    let (other, other_wt) = task_in_a_worktree(&api, &repo).await;
    api.cmd("worktrees.keep", json!({ "id": kept, "keep": true })).await;
    // the kept one first: archive changes are looked at in order, so once the other's folder is gone the
    // kept one's change has been looked at too
    api.cmd("runtime.archive", json!({ "id": kept, "archived": true })).await;
    api.cmd("runtime.archive", json!({ "id": other, "archived": true })).await;
    until_gone(other_wt["path"].as_str().unwrap(), "the other task's clean worktree goes").await;
    assert!(Path::new(kept_wt["path"].as_str().unwrap()).is_dir(), "Keep worktree on: archiving leaves it");
    drop(serve);
    let _ = std::fs::remove_dir_all(&dir);
}
