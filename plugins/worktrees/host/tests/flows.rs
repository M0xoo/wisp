//! Worktree flows over real repos in temp folders and the real git service (wisp-git over the local proc
//! service): Bring in's offer for a Conductor worktree (F-wt-3), Done's list with a delegate's folder
//! (F-wt-4), and an archived task's clean folder going (F-wt-7). Setup uses `std::process` (test-only).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use wisp_kernel::{Call, Caller, CancellationToken};
use wisp_store::{Location, Store, SystemClock};
use wisp_worktrees::{Engine, MemPort, TaskInfo, TaskTree, WtSettings, archived, done, pane};
use wisp_worktrees_api::{PrRef, Worktree};

static N: AtomicU32 = AtomicU32::new(0);

struct Tmp(PathBuf);
impl Drop for Tmp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn tmp(name: &str) -> Tmp {
    let d = std::env::temp_dir().join(format!("wisp-wt-{name}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    Tmp(std::fs::canonicalize(&d).unwrap())
}

fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).env("GIT_CONFIG_NOSYSTEM", "1").output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// `<t>/src/app` on `main`, one commit, pushed to a bare origin.
fn repo(t: &Tmp) -> PathBuf {
    let origin = t.0.join("origin.git");
    std::fs::create_dir_all(&origin).unwrap();
    git(&origin, &["init", "-q", "--bare", "-b", "main"]);
    let dir = t.0.join("src/app");
    std::fs::create_dir_all(&dir).unwrap();
    git(&dir, &["init", "-q", "-b", "main"]);
    for (k, v) in [("user.email", "qa@wisp.test"), ("user.name", "QA"), ("commit.gpgsign", "false")] {
        git(&dir, &["config", k, v]);
    }
    std::fs::write(dir.join("a.txt"), "one\n").unwrap();
    git(&dir, &["add", "-A"]);
    git(&dir, &["commit", "-q", "-m", "base"]);
    git(&dir, &["remote", "add", "origin", origin.to_str().unwrap()]);
    git(&dir, &["push", "-q", "-u", "origin", "main"]);
    dir
}

/// A worktree on a new branch at `path`, as wisp records it.
fn add_tree(root: &Path, path: &Path, branch: &str) -> Worktree {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    git(root, &["worktree", "add", "-q", "-b", branch, path.to_str().unwrap()]);
    let p = path.to_string_lossy().into_owned();
    Worktree {
        path: p.clone(),
        cwd: p,
        branch: branch.into(),
        base: "main".into(),
        base_ref: "origin/main".into(),
        remote: Some("origin".into()),
        root: root.to_string_lossy().into_owned(),
        ..Worktree::default()
    }
}

/// The engine over the real git service; wisp's home `<t>/h`, the user's `<t>/u`.
fn engine(t: &Tmp) -> Engine {
    let git = wisp_git::service(wisp_proc::local(), None, Arc::new(|| 1_000_000), None);
    Engine::new(
        Arc::new(wisp_git::Service(git)),
        wisp_proc::local(),
        wisp_testkit::FakeClock::at(1_000_000).service(),
        t.0.join("h").to_string_lossy().into_owned(),
        t.0.join("u").to_string_lossy().into_owned(),
        "macos",
        Vec::new(),
        CancellationToken::new(),
    )
}

fn user() -> Call {
    Call::new_root(Caller::user())
}

fn task(id: &str, wt: Option<&Worktree>) -> TaskInfo {
    TaskInfo {
        id: id.into(),
        title: id.into(),
        project: "app".into(),
        done: true,
        trees: wt.map(|w| TaskTree { worktree: w.clone(), pr: None }).into_iter().collect(),
        ..TaskInfo::default()
    }
}

/// F-wt-3: a project with a worktree Conductor left under ~/conductor/workspaces: the offer lists it (from
/// "Conductor"), wisp's own worktree and the main checkout are left out, and the pane's topic carries the row.
#[tokio::test]
async fn a_projects_conductor_worktree_is_offered_and_published_on_the_panes_topic() {
    let t = tmp("bring");
    let root = repo(&t);
    let e = engine(&t);
    let oslo = t.0.join("u/conductor/workspaces/app/oslo");
    add_tree(&root, &oslo, "oslo");
    std::fs::write(oslo.join("wip.txt"), "draft\n").unwrap();
    let mine = add_tree(&root, &t.0.join("h/worktrees/app-fix"), "wisp/fix");
    let port = MemPort::new(vec![task("t1", Some(&mine))], WtSettings::default());
    *port.projects.lock().unwrap() = vec![("app".into(), root.to_string_lossy().into_owned())];

    let offers = pane::offers(&e, port.as_ref(), &user()).await;
    assert_eq!(offers.len(), 1, "{offers:?}");
    let o = &offers[0];
    assert_eq!((o.project.as_str(), o.from.as_str()), ("app", "Conductor"));
    let paths: Vec<&str> = o.items.iter().map(|i| i.path.as_str()).collect();
    assert_eq!(paths, [oslo.to_str().unwrap()]);
    assert_eq!((o.items[0].branch.as_str(), o.items[0].name.as_str(), o.items[0].dirty), ("oslo", "oslo", 1));

    let db = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    pane::install(&db).unwrap();
    let view = wisp_worktrees_api::WorktreesView {
        cleanup: "7".into(),
        max: "40".into(),
        items: Vec::new(),
        leftovers: Vec::new(),
        size: None,
        disk: None,
        ready: 0,
        looking: false,
        cleaning: None,
        last: None,
    };
    pane::publish(&db, &view, &offers).await.unwrap();
    let row = db.read(|r| r.get("worktrees.offer", "app")).unwrap().unwrap();
    assert_eq!(row["items"][0]["path"], oslo.to_str().unwrap());
    assert_eq!((pane::OFFER.topics)(&row), vec![pane::TOPIC.to_owned()]);

    // Not now: the project's offer isn't made again
    port.settings.lock().unwrap().dismissed = vec!["app".into()];
    assert_eq!(pane::offers(&e, port.as_ref(), &user()).await, Vec::new());
}

/// F-wt-4: Done's list for a lead holds its own folder and its delegate's (a session whose parent is the
/// lead), each with how it stands; a merged PR reads from the task; apply removes the ticked clean one.
#[tokio::test]
async fn dones_list_holds_the_tasks_folder_and_its_delegates_and_apply_removes_the_ticked_one() {
    let t = tmp("done");
    let root = repo(&t);
    let e = engine(&t);
    let lead_wt = add_tree(&root, &t.0.join("h/worktrees/app-lead"), "wisp/lead");
    let job_wt = add_tree(&root, &t.0.join("h/worktrees/app-job"), "wisp/job");
    std::fs::write(Path::new(&job_wt.path).join("wip.txt"), "half done\n").unwrap();
    let mut lead = task("lead", Some(&lead_wt));
    lead.trees[0].pr = Some(PrRef { number: 7, url: "https://x/7".into(), state: "MERGED".into() });
    lead.kids = vec!["job".into()];
    let job = TaskInfo { parent_id: Some("lead".into()), ..task("job", Some(&job_wt)) };
    let other = task("other", Some(&add_tree(&root, &t.0.join("h/worktrees/app-other"), "wisp/other")));
    let port = MemPort::new(vec![lead, job, other], WtSettings::default());

    let list = done::list(&e, port.as_ref(), &user(), "lead", false).await;
    let rows: Vec<(&str, &str, bool)> = list.folders.iter().map(|f| (f.path.as_str(), f.task.as_str(), f.own)).collect();
    assert_eq!(rows, [(lead_wt.path.as_str(), "lead", true), (job_wt.path.as_str(), "job", false)], "not another task's");
    assert_eq!(list.folders[0].only, Some(0));
    assert_eq!(list.folders[0].pr.as_ref().map(|p| p.state.as_str()), Some("MERGED"));
    assert_eq!(list.folders[1].only, Some(1), "the delegate's folder holds work");
    assert_eq!(list.on_done, wisp_worktrees_api::OnDone::Ask);

    let args = wisp_worktrees_api::DoneApplyArgs {
        session_id: "lead".into(),
        remove: vec![lead_wt.path.clone()],
        keep: vec![job_wt.path.clone()],
        force: Vec::new(),
    };
    let out = done::apply(&e, port.as_ref(), &user(), &args).await.unwrap();
    assert_eq!(out.removed, std::slice::from_ref(&lead_wt.path));
    assert!(!Path::new(&lead_wt.path).exists());
    assert!(Path::new(&job_wt.path).exists());
    assert!(port.tasks.lock().unwrap().iter().any(|x| x.id == "job" && x.kept), "Keep pins it");
    assert_eq!(git(&root, &["branch", "--list", "wisp/lead"]), "wisp/lead", "the branch stays");
}

/// F-wt-7: an archived task's clean folder goes (its branch stays); one holding work stays, and so does one
/// Conductor made.
#[tokio::test]
async fn an_archived_tasks_clean_worktree_is_removed_and_one_with_work_stays() {
    let t = tmp("archive");
    let root = repo(&t);
    let e = engine(&t);
    let clean = add_tree(&root, &t.0.join("h/worktrees/app-clean"), "wisp/clean");
    let r = archived::tidy(&e, &user(), &clean).await.unwrap();
    assert!(r.removed);
    assert!(!Path::new(&clean.path).exists());
    assert_eq!(git(&root, &["branch", "--list", "wisp/clean"]), "wisp/clean", "a follow-up brings it back from its branch");
    assert!(archived::tidy(&e, &user(), &clean).await.is_none(), "gone already: nothing to do");

    let dirty = add_tree(&root, &t.0.join("h/worktrees/app-dirty"), "wisp/dirty");
    std::fs::write(Path::new(&dirty.path).join("wip.txt"), "x\n").unwrap();
    let r = archived::tidy(&e, &user(), &dirty).await.unwrap();
    assert!(!r.removed && r.dirty == Some(1), "{r:?}");
    assert!(Path::new(&dirty.path).exists());

    let theirs = add_tree(&root, &t.0.join("u/conductor/workspaces/app/rome"), "rome");
    assert!(archived::tidy(&e, &user(), &theirs).await.is_none());
    assert!(Path::new(&theirs.path).exists(), "never wisp's to remove");

    let slot = serde_json::to_value(&clean).unwrap();
    assert_eq!(archived::tree_of(Some(&slot)).map(|w| w.path), Some(clean.path.clone()));
    assert!(archived::tree_of(Some(&serde_json::json!({ "kept": true }))).is_none());
}
