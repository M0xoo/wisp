//! git.service@1 and the git.* commands on real repos (v1 test/stage.test.js, test/hunks.test.js,
//! test/overlaps.test.js, test/clone.test.js, and docs/v1-edge-cases.md → Git).
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::assert_is_empty,
    clippy::cast_possible_truncation,
    clippy::cast_possible_wrap,
    clippy::cast_sign_loss,
    clippy::many_single_char_names,
    clippy::range_plus_one,
    clippy::format_push_string,
    clippy::needless_pass_by_value,
    clippy::needless_lifetimes,
    clippy::elidable_lifetime_names,
    clippy::option_option,
    clippy::doc_markdown,
    clippy::map_unwrap_or,
    clippy::format_collect
)]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use common::*;
use wisp_git_api::commands::{ChangesArgs, CommitArgs, RevertArgs, StageArgs};
use wisp_git_api::{Body, Changes, CloneRequest, GitService, MergeTree, WorktreeAdd};
use wisp_git_core::hunks::{hunk_key, hunks_of};

fn files(c: &Changes) -> &[wisp_git_api::FileDiff] {
    match &c.body {
        Body::Inline { files } => files,
        Body::Blob { .. } => panic!("inline expected"),
    }
}

fn edit(dir: &std::path::Path) {
    let mut lines: Vec<String> = (1..=30).map(|i| format!("line {i}")).collect();
    lines[1] = "LINE 2".into();
    lines[24] = "LINE 25".into();
    write(dir, "a.txt", &format!("{}\n", lines.join("\n")));
    write(dir, "new.txt", "hi\n");
}

#[tokio::test]
async fn every_method_checks_its_permission_first() {
    let t = tmp("perm");
    let dir = repo(&t);
    let (_, s) = service();
    let o = owner();
    assert!(s.repo(&stranger(), &o, dir.to_str().unwrap()).await.is_err(), "git:repo refused");
    let r = s.repo(&user(), &o, dir.to_str().unwrap()).await.unwrap();
    let st = stranger();
    assert_eq!(r.status(&st).await.unwrap_err().code, wisp_kernel::Code::Forbidden);
    assert!(r.commit(&st, wisp_git_api::CommitRequest { message: "x".into(), all: true, ..Default::default() }).await.is_err());
    assert!(r.worktree_add(&st, WorktreeAdd::default()).await.is_err());
    assert!(r.on_change(&st, &o, Arc::new(|_| {})).is_err());
    // every trait method is in the permission table
    for m in ["status", "changes", "diff", "worktree_add", "worktree_remove", "commit", "push", "sync_base", "on_change", "touch"] {
        assert!(wisp_git_api::permission(m).is_some(), "{m}");
    }
}

#[tokio::test]
async fn a_handle_is_cached_per_path_and_released_with_its_owner_scope() {
    let t = tmp("cache");
    let dir = repo(&t);
    let (svc, s) = service();
    let (a, b) = (owner(), owner());
    let r1 = s.repo(&user(), &a, dir.to_str().unwrap()).await.unwrap();
    let r2 = s.repo(&user(), &b, dir.join(".").to_str().unwrap()).await.unwrap();
    assert_eq!(r1.info(), r2.info());
    assert_eq!(svc.cached(), 1);
    a.cancel();
    tokio::task::yield_now().await;
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(svc.cached(), 1, "b still holds it");
    b.cancel();
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    assert_eq!(svc.cached(), 0);
    let o = owner();
    assert!(s.repo(&user(), &o, t.0.to_str().unwrap()).await.is_err(), "outside a repo: not found");
}

#[tokio::test]
async fn status_and_info_from_a_subfolder() {
    let t = tmp("status");
    let dir = repo(&t);
    write(&dir, "sub/x.txt", "x\n");
    write(&dir, "a.txt", "changed\n");
    let (_, s) = service();
    let o = owner();
    let r = s.repo(&user(), &o, dir.join("sub").to_str().unwrap()).await.unwrap();
    assert_eq!(r.info().sub, "sub", "a launch from a subfolder keeps it (edge case Git 5)");
    assert_eq!(r.info().root, dir.display().to_string());
    let st = r.status(&user()).await.unwrap();
    assert_eq!((st.branch.as_str(), st.dirty()), ("main", 2));
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    assert!(st.head.len() >= 40);
}

/// Edge case Git 4: origin/HEAD, origin/main, origin/master, else HEAD with no remote; no commits: None.
#[tokio::test]
async fn base_order() {
    let t = tmp("base");
    let dir = repo(&t);
    let (_, s) = service();
    let o = owner();
    let r = s.repo(&user(), &o, dir.to_str().unwrap()).await.unwrap();
    let b = r.base(&user(), true).await.unwrap().unwrap();
    assert_eq!((b.reference.as_str(), b.branch.as_str(), b.remote.as_deref()), ("origin/main", "main", Some("origin")));
    let lone = t.0.join("lone");
    std::fs::create_dir_all(&lone).unwrap();
    git(&lone, &["init", "-q", "-b", "trunk"]);
    let r = s.repo(&user(), &o, lone.to_str().unwrap()).await.unwrap();
    assert_eq!(r.base(&user(), false).await.unwrap(), None, "a repo with no commits gets no worktree");
    write(&lone, "f", "1");
    git(&lone, &["add", "-A"]);
    git(&lone, &["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "-m", "x"]);
    let b = r.base(&user(), false).await.unwrap().unwrap();
    assert_eq!((b.branch.as_str(), b.remote), ("trunk", None));
}

/// Edge case Git 10: from the merge-base, untracked whole, generated flagged; a later base commit is
/// never the work's.
#[tokio::test]
async fn changes_from_the_merge_base_with_untracked_and_stage_state() {
    let t = tmp("changes");
    let dir = repo(&t);
    git(&dir, &["checkout", "-q", "-b", "wisp/x"]);
    edit(&dir);
    write(&dir, "Cargo.lock", "lock\n");
    let (svc, _) = service();
    let args = ChangesArgs {
        path: dir.display().to_string(),
        base: "origin/main".into(),
        reveal: vec![],
        mask: true,
        stage_state: true,
        inline: true,
    };
    let c = wisp_git::commands::changes(&svc, args.clone()).await.unwrap().unwrap();
    let paths: Vec<&str> = files(&c).iter().map(|f| f.path.as_str()).collect();
    assert_eq!(paths, ["Cargo.lock", "a.txt", "new.txt"]);
    let a = &files(&c)[1];
    assert_eq!((a.add, a.del, hunks_of(&a.rows).len()), (2, 2, 2));
    assert_eq!(a.hunk_stage.as_ref().map(Vec::len), Some(2));
    assert!(files(&c)[0].generated);
    assert_eq!(files(&c)[2].unstaged, Some(true), "untracked counts as unstaged");
    assert_eq!(c.base, "origin/main");
}

#[tokio::test]
#[allow(clippy::too_many_lines)] // v1's stage round trip, step by step
async fn stage_a_hunk_unstage_it_commit_and_refuse_a_stale_key() {
    let t = tmp("stage");
    let dir = repo(&t);
    edit(&dir);
    let (svc, _) = service();
    let d = dir.display().to_string();
    let a = ChangesArgs { path: d.clone(), base: "HEAD".into(), reveal: vec![], mask: false, stage_state: true, inline: true };
    let c = wisp_git::commands::changes(&svc, a).await.unwrap().unwrap();
    let a = files(&c).iter().find(|f| f.path == "a.txt").unwrap().clone();
    let key1 = hunk_key(&hunks_of(&a.rows)[1].rows);
    let stale = wisp_git::commands::stage(
        &svc,
        StageArgs { dir: d.clone(), base: "HEAD".into(), path: "a.txt".into(), hunk: Some(0), key: Some(key1.clone()), unstage: false },
    )
    .await;
    assert!(stale.unwrap_err().to_string().contains("changed since you looked"));
    wisp_git::commands::stage(
        &svc,
        StageArgs { dir: d.clone(), base: "HEAD".into(), path: "a.txt".into(), hunk: Some(1), key: Some(key1), unstage: false },
    )
    .await
    .unwrap();
    let cached = git(&dir, &["diff", "--cached"]);
    assert!(cached.contains("+LINE 25") && !cached.contains("+LINE 2\n"));
    let again = wisp_git::commands::stage(
        &svc,
        StageArgs { dir: d.clone(), base: "HEAD".into(), path: "a.txt".into(), hunk: Some(1), key: None, unstage: false },
    )
    .await;
    assert!(again.unwrap_err().to_string().contains("nothing left to stage"));
    wisp_git::commands::stage(
        &svc,
        StageArgs { dir: d.clone(), base: "HEAD".into(), path: "a.txt".into(), hunk: Some(1), key: None, unstage: true },
    )
    .await
    .unwrap();
    assert_eq!(git(&dir, &["diff", "--cached"]), "");
    let nothing = wisp_git::commands::commit(&svc, CommitArgs { dir: d.clone(), message: "x".into(), all: false }).await;
    assert!(nothing.unwrap_err().to_string().contains("Nothing is staged"));
    wisp_git::commands::stage(
        &svc,
        StageArgs { dir: d.clone(), base: "HEAD".into(), path: "new.txt".into(), hunk: None, key: None, unstage: false },
    )
    .await
    .unwrap();
    let done = wisp_git::commands::commit(&svc, CommitArgs { dir: d.clone(), message: "Add new.txt".into(), all: false }).await.unwrap();
    assert!(done.sha.len() >= 7);
    assert_eq!(git(&dir, &["log", "-1", "--format=%s"]), "Add new.txt");
}

#[tokio::test]
async fn revert_a_hunk_then_undo_it_and_revert_a_new_file() {
    let t = tmp("revert");
    let dir = repo(&t);
    edit(&dir);
    let (svc, _) = service();
    let d = dir.display().to_string();
    let r = wisp_git::commands::revert(
        &svc,
        RevertArgs { dir: d.clone(), base: "HEAD".into(), path: "a.txt".into(), hunk: Some(0), ..Default::default() },
    )
    .await
    .unwrap();
    let text = std::fs::read_to_string(dir.join("a.txt")).unwrap();
    assert!(text.contains("\nline 2\n") && text.contains("LINE 25"));
    let mut lines: Vec<String> = (1..=30).map(|i| format!("line {i}")).collect();
    lines[1] = "LINE 2".into();
    lines[24] = "LINE 25".into();
    let before = format!("{}\n", lines.join("\n"));
    let undo = RevertArgs {
        dir: d.clone(),
        base: "HEAD".into(),
        path: "a.txt".into(),
        restore: Some(Some(before.clone())),
        hash: r.hash,
        ..Default::default()
    };
    wisp_git::commands::revert(&svc, undo).await.unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), before);
    wisp_git::commands::revert(&svc, RevertArgs { dir: d.clone(), base: "HEAD".into(), path: "new.txt".into(), ..Default::default() })
        .await
        .unwrap();
    assert!(!dir.join("new.txt").exists(), "an added file goes");
    let out = wisp_git::commands::revert(
        &svc,
        RevertArgs { dir: d.clone(), base: "HEAD".into(), path: "../escape".into(), ..Default::default() },
    )
    .await;
    assert!(out.is_err(), "nothing outside the folder");
}

/// Edge case Git 3: adds into one repo take turns, so five at once all land.
#[tokio::test]
async fn worktree_adds_take_turns_and_remove_cleans_up() {
    let t = tmp("wt");
    let dir = repo(&t);
    let (_, s) = service();
    let o = owner();
    let r = s.repo(&user(), &o, dir.to_str().unwrap()).await.unwrap();
    let mut jobs = Vec::new();
    for i in 0..5 {
        let (r, at) = (r.clone(), t.0.join(format!("wts/w{i}")).display().to_string());
        jobs.push(tokio::spawn(async move {
            r.worktree_add(&user(), WorktreeAdd { path: at, branch: format!("wisp/t-{i}"), start: Some("origin/main".into()) }).await
        }));
    }
    for j in jobs {
        let w = j.await.unwrap().unwrap();
        assert!(w.head.len() >= 40);
    }
    assert_eq!(r.worktrees(&user()).await.unwrap().len(), 6);
    let gone = t.0.join("wts/w0").display().to_string();
    r.worktree_remove(&user(), &gone).await.unwrap();
    assert!(!std::path::Path::new(&gone).exists());
    assert_eq!(r.worktrees(&user()).await.unwrap().len(), 5);
    assert!(r.branch_delete(&user(), "wisp/t-0").await.unwrap());
}

/// Edge case Git 9 and v1 overlaps: merge-tree's exit codes, touched files, base_merged's checks.
#[tokio::test]
async fn merge_tree_touched_and_base_merged() {
    let t = tmp("mt");
    let dir = repo(&t);
    let (_, s) = service();
    let o = owner();
    let r = s.repo(&user(), &o, dir.to_str().unwrap()).await.unwrap();
    git(&dir, &["checkout", "-q", "-b", "a"]);
    write(&dir, "a.txt", "mine\n");
    git(&dir, &["commit", "-qam", "a"]);
    git(&dir, &["checkout", "-q", "-b", "b", "main"]);
    write(&dir, "a.txt", "theirs\n");
    git(&dir, &["commit", "-qam", "b"]);
    assert_eq!(r.merge_tree(&user(), "a", "b").await.unwrap(), MergeTree::Conflict { files: vec!["a.txt".into()] });
    assert_eq!(r.merge_tree(&user(), "a", "main").await.unwrap(), MergeTree::Clean);
    write(&dir, "u.txt", "new\n");
    let touched = r.touched(&user(), "main").await.unwrap().unwrap();
    assert_eq!(touched.files, ["a.txt", "u.txt"]);
    assert!(r.base_merged(&user(), "a").await.unwrap().why.unwrap().contains("not merged"));
    assert!(r.base_merged(&user(), "main").await.unwrap().ok);
}

#[tokio::test]
async fn on_change_hears_writes_until_disposed() {
    let t = tmp("watch");
    let dir = repo(&t);
    let (_, s) = service();
    let o = owner();
    let r = s.repo(&user(), &o, dir.to_str().unwrap()).await.unwrap();
    let n = Arc::new(AtomicUsize::new(0));
    let m = n.clone();
    let sub = r
        .on_change(
            &user(),
            &o,
            Arc::new(move |c| {
                assert_eq!(c.kind, "head");
                m.fetch_add(1, Ordering::SeqCst);
            }),
        )
        .unwrap();
    write(&dir, "z", "z");
    r.commit(&user(), wisp_git_api::CommitRequest { message: "z".into(), all: true, ..Default::default() }).await.unwrap().unwrap();
    assert_eq!(n.load(Ordering::SeqCst), 1);
    sub.dispose();
    r.touch(&user(), "head").unwrap();
    assert_eq!(n.load(Ordering::SeqCst), 1, "disposed");
}

#[tokio::test]
async fn clone_reuses_the_same_repo_and_suffixes_another() {
    let t = tmp("clone");
    let dir = repo(&t);
    let (_, s) = service();
    let url = format!("file://{}", t.0.join("origin.git").display());
    let parent = t.0.join("clones").display().to_string();
    let a = s.clone_repo(&user(), CloneRequest { url: url.clone(), parent: parent.clone() }).await.unwrap();
    assert!(!a.existed && std::path::Path::new(&a.dir).join("a.txt").exists());
    let b = s.clone_repo(&user(), CloneRequest { url: url.clone(), parent: parent.clone() }).await.unwrap();
    assert_eq!((b.dir.as_str(), b.existed), (a.dir.as_str(), true));
    let bad = s.clone_repo(&user(), CloneRequest { url: format!("file://{}/missing.git", t.0.display()), parent: parent.clone() }).await;
    assert!(bad.unwrap_err().message.contains("Couldn’t clone"));
    drop(dir);
}

/// A turn's rollback: the folder comes back as the checkpoint had it (a changed file restored, a new file
/// gone, an untracked file then untracked again) and a commit made since leaves the branch.
#[tokio::test]
async fn restore_puts_the_folder_and_the_branch_back_at_a_checkpoint() {
    let t = tmp("restore");
    let dir = repo(&t);
    let (_, s) = service();
    let o = owner();
    let r = s.repo(&user(), &o, dir.to_str().unwrap()).await.unwrap();
    write(&dir, "notes.txt", "mine, untracked\n");
    let head = r.rev_parse(&user(), "HEAD").await.unwrap().unwrap();
    let snap = r.snapshot(&user()).await.unwrap().expect("untracked notes: a snapshot");
    // the turn: edits a tracked file, adds one, commits, and leaves another untracked
    edit(&dir);
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-qm", "agent work"]);
    write(&dir, "later.txt", "made after\n");
    r.restore(&user(), &snap, &head).await.unwrap();
    assert_eq!(r.rev_parse(&user(), "HEAD").await.unwrap().unwrap(), head, "the commit left the branch");
    assert!(!dir.join("new.txt").exists() && !dir.join("later.txt").exists(), "files made since are gone");
    assert_eq!(std::fs::read_to_string(dir.join("notes.txt")).unwrap(), "mine, untracked\n");
    let st = git(&dir, &["status", "--porcelain"]);
    assert_eq!(st.trim(), "?? notes.txt", "untracked again, nothing else changed: {st}");
    assert!(r.restore(&stranger(), &snap, &head).await.is_err(), "git:restore is checked");
}

/// v1 services/places.js: a task's folder on another computer is that computer's checkout of the same repo, found
/// (a project's folder, else the usual repo folders) or cloned.
#[tokio::test]
async fn a_folders_repo_and_the_other_computers_checkout_of_it_found_or_cloned_v1_run_on_checkout() {
    let t = tmp("place");
    let dir = repo(&t);
    let origin = t.0.join("origin.git");
    let s = svc();
    std::fs::create_dir_all(dir.join("web/src")).unwrap();
    // here: the task's folder (a subfolder) names its repo and its checkout's top
    let o = s.origin_at(&dir.join("web/src").to_string_lossy()).await;
    assert_eq!((o.origin.as_str(), o.root.as_str()), (origin.to_str().unwrap(), dir.to_str().unwrap()));
    assert_eq!(s.origin_at(&t.0.to_string_lossy()).await, wisp_git_api::Origin::default(), "not a repo: nothing");
    // there: a project folder with that origin is used as it is
    let url = format!("file://{}", origin.to_string_lossy());
    let home = t.0.join("home");
    std::fs::create_dir_all(&home).unwrap();
    let parent = home.join("code").to_string_lossy().into_owned();
    let known = s
        .checkout(
            wisp_git_api::CheckoutArgs { url: url.clone(), known: vec![dir.to_string_lossy().into_owned()] },
            &home.to_string_lossy(),
            parent.clone(),
        )
        .await
        .unwrap();
    assert_eq!((known.dir.as_str(), known.existed), (dir.to_str().unwrap(), true));
    // none known, none in the usual folders: a fresh clone where clones go
    let fresh =
        s.checkout(wisp_git_api::CheckoutArgs { url: url.clone(), known: vec![] }, &home.to_string_lossy(), parent.clone()).await.unwrap();
    assert!(!fresh.existed && fresh.dir.starts_with(&parent), "{fresh:?}");
    // asked again: the clone it made is found in the usual folders, not cloned twice
    let again = s.checkout(wisp_git_api::CheckoutArgs { url, known: vec![] }, &home.to_string_lossy(), parent).await.unwrap();
    assert_eq!((again.dir.as_str(), again.existed), (fresh.dir.as_str(), true));
}

/// A task with no folder (or a relative one) opens no repo: `canonicalize("src")` would be the server's own
/// folder's `src`, and every checkpoint, restore and commit would act on the server's repo.
#[tokio::test]
async fn a_repo_is_never_opened_in_the_servers_own_folder() {
    let (_, s) = service();
    let o = owner();
    // the test's own folder is in a git repo with a `src`: each of these would open it
    for path in ["", " ", ".", "src", "./src"] {
        let Err(e) = s.repo(&user(), &o, path).await else { panic!("{path:?} opened the server's own repo") };
        assert!(e.message.contains("no such folder"), "{path:?}: {e:?}");
    }
}
