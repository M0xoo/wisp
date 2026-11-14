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
use wisp_worktrees::{Claimant, Engine, MemPort, TaskInfo, TaskTree, WtSettings, archived, done, pane};
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
    engine_on(t, &wisp_testkit::FakeClock::at(1_000_000))
}

fn engine_on(t: &Tmp, clock: &wisp_testkit::FakeClock) -> Engine {
    let git = wisp_git::service(wisp_proc::local(), None, Arc::new(|| 1_000_000), None);
    Engine::new(
        Arc::new(wisp_git::Service(git)),
        wisp_proc::local(),
        clock.service(),
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
    let r = archived::tidy(&e, &user(), &clean, e.mark()).await.unwrap();
    assert!(r.removed);
    assert!(!Path::new(&clean.path).exists());
    assert_eq!(git(&root, &["branch", "--list", "wisp/clean"]), "wisp/clean", "a follow-up brings it back from its branch");
    assert!(archived::tidy(&e, &user(), &clean, e.mark()).await.is_none(), "gone already: nothing to do");

    let dirty = add_tree(&root, &t.0.join("h/worktrees/app-dirty"), "wisp/dirty");
    std::fs::write(Path::new(&dirty.path).join("wip.txt"), "x\n").unwrap();
    let r = archived::tidy(&e, &user(), &dirty, e.mark()).await.unwrap();
    assert!(!r.removed && r.dirty == Some(1), "{r:?}");
    assert!(Path::new(&dirty.path).exists());

    let theirs = add_tree(&root, &t.0.join("u/conductor/workspaces/app/rome"), "rome");
    assert!(archived::tidy(&e, &user(), &theirs, e.mark()).await.is_none());
    assert!(Path::new(&theirs.path).exists(), "never wisp's to remove");

    let slot = serde_json::to_value(&clean).unwrap();
    assert_eq!(archived::tree_of(Some(&slot)).map(|w| w.path), Some(clean.path.clone()));
    assert!(archived::tree_of(Some(&serde_json::json!({ "kept": true }))).is_none());
}

/// ADR-0053: before a follow-up runs, an archived task's removed worktree comes back on its branch (its ignored
/// files copied again); a brought-in folder that's gone, or a branch that's gone, is a reason, never a new folder.
#[tokio::test]
async fn bring_back_restores_a_removed_worktree_on_its_branch_and_refuses_what_cant_come_back() {
    let t = tmp("back");
    let root = repo(&t);
    std::fs::write(root.join(".env"), "KEY=1\n").unwrap();
    std::fs::write(root.join(".gitignore"), ".env\n").unwrap();
    let e = engine(&t);
    let wt = add_tree(&root, &t.0.join("h/worktrees/app-back"), "wisp/back");
    assert!(archived::tidy(&e, &user(), &wt, e.mark()).await.unwrap().removed);
    archived::bring_back(&e, &user(), Claimant::turn("t1", "turn-1"), &wt).await.unwrap();
    assert_eq!(git(Path::new(&wt.path), &["branch", "--show-current"]), "wisp/back");
    assert!(Path::new(&wt.path).join(".env").is_file(), "its ignored files again");
    archived::bring_back(&e, &user(), Claimant::turn("t1", "turn-1"), &wt).await.unwrap(); // there already: nothing to do

    let gone = add_tree(&root, &t.0.join("h/worktrees/app-gone"), "wisp/gone");
    assert!(archived::tidy(&e, &user(), &gone, e.mark()).await.unwrap().removed);
    git(&root, &["branch", "-D", "wisp/gone"]);
    let why = archived::bring_back(&e, &user(), Claimant::turn("t2", "turn-1"), &gone).await.unwrap_err();
    assert!(why.contains("couldn't come back") && why.contains("wisp/gone"), "{why}");
    assert!(!Path::new(&gone.path).exists());

    let theirs = add_tree(&root, &t.0.join("u/conductor/workspaces/app/oslo"), "oslo");
    std::fs::remove_dir_all(&theirs.path).unwrap();
    let why = archived::bring_back(&e, &user(), Claimant::turn("t3", "turn-1"), &theirs).await.unwrap_err();
    assert!(why.contains("gone"), "{why}");
    assert!(!Path::new(&theirs.path).exists(), "never made again at their path");
}

/// A removal stands down while a turn is starting in the folder: one decided before the turn claimed it, and one
/// decided after (the task still reads archived and idle until its turn is saved running). Once runtime says the
/// turn started the claim lets go (the task's state guards it); one runtime never confirms lapses.
#[tokio::test]
async fn an_archived_tasks_removal_stands_down_when_a_turn_starts_in_the_folder() {
    let t = tmp("claim");
    let root = repo(&t);
    let clock = wisp_testkit::FakeClock::at(1_000_000);
    let e = engine_on(&t, &clock);
    let wt = add_tree(&root, &t.0.join("h/worktrees/app-claim"), "wisp/claim");
    let before = e.mark();
    archived::bring_back(&e, &user(), Claimant::turn("t1", "turn-1"), &wt).await.unwrap(); // the follow-up's turn starts
    assert!(!archived::tidy(&e, &user(), &wt, before).await.unwrap().removed, "decided before the claim");
    assert!(!archived::tidy(&e, &user(), &wt, e.mark()).await.unwrap().removed, "decided after it, while the turn starts");
    assert!(!archived::tidy(&e, &user(), &wt, before).await.unwrap().removed, "released or not, an older look stays stale");
    e.release("t1", "turn-1");
    assert!(!archived::tidy(&e, &user(), &wt, before).await.unwrap().removed, "a look from before the claim is still stale");
    assert!(archived::tidy(&e, &user(), &wt, e.mark()).await.unwrap().removed, "released: a fresh look decides");

    let other = add_tree(&root, &t.0.join("h/worktrees/app-lapse"), "wisp/lapse");
    archived::bring_back(&e, &user(), Claimant::turn("t2", "turn-1"), &other).await.unwrap();
    assert!(!archived::tidy(&e, &user(), &other, e.mark()).await.unwrap().removed);
    clock.advance(u64::try_from(wisp_worktrees::engine::CLAIM_MS).unwrap());
    assert!(archived::tidy(&e, &user(), &other, e.mark()).await.unwrap().removed, "never confirmed: the claim lapsed");
}

/// ADR-0053, extra folders (`dirs`, v1's `also`): a task's extra folder that's another task's worktree
/// archiving removed comes back on its branch before the turn; it's claimed while the turn starts, then the task
/// working with it in its `dirs` keeps it (that other task reads archived and idle the whole time); one that can't
/// come back says which folder; one that was never a worktree is left to runtime's check (refused with its name),
/// never made.
#[tokio::test]
async fn an_extra_folder_thats_a_removed_worktree_comes_back_and_stays_while_its_task_works() {
    let t = tmp("extra");
    let root = repo(&t);
    let e = engine(&t);
    let theirs = add_tree(&root, &t.0.join("h/worktrees/app-theirs"), "wisp/theirs");
    std::fs::create_dir_all(Path::new(&theirs.path).join("web")).unwrap();
    std::fs::write(Path::new(&theirs.path).join("web/x.txt"), "x\n").unwrap();
    git(Path::new(&theirs.path), &["add", "-A"]);
    git(Path::new(&theirs.path), &["commit", "-qm", "web"]);
    let port = MemPort::new(vec![task("t1", Some(&theirs))], WtSettings::default());
    assert!(archived::tidy(&e, &user(), &theirs, e.mark()).await.unwrap().removed);

    let sub = format!("{}/web", theirs.path);
    archived::extras_ready(&e, port.as_ref(), &user(), Claimant::turn("t2", "turn-1"), std::slice::from_ref(&sub)).await.unwrap();
    assert!(Path::new(&sub).is_dir(), "its subfolder, back with the worktree");
    assert_eq!(git(Path::new(&theirs.path), &["branch", "--show-current"]), "wisp/theirs");
    assert!(!archived::tidy(&e, &user(), &theirs, e.mark()).await.unwrap().removed, "while t2's turn starts");
    e.release("t2", "turn-1"); // t2's turn is saved running, with the folder in its `dirs`
    port.extras.lock().unwrap().push(sub.clone());
    let look = |port: Arc<MemPort>| {
        let (e, wt) = (&e, theirs.clone());
        async move {
            let used = wisp_worktrees::Port::extra_in_use(port.as_ref(), wt.path.clone()).await;
            archived::tidy_unless(e, &user(), &wt, e.mark(), used).await.is_some_and(|r| r.removed)
        }
    };
    assert!(!look(port.clone()).await, "while t2 works with it: t1's state says nothing about that");
    port.extras.lock().unwrap().clear();
    assert!(look(port.clone()).await, "t2 is done: it may go");

    git(&root, &["branch", "-D", "wisp/theirs"]);
    let why = archived::extras_ready(&e, port.as_ref(), &user(), Claimant::turn("t3", "turn-1"), std::slice::from_ref(&theirs.path))
        .await
        .unwrap_err();
    assert!(why.contains(&theirs.path) && why.contains("wisp/theirs"), "{why}");

    let never = t.0.join("nowhere").to_string_lossy().into_owned();
    archived::extras_ready(&e, port.as_ref(), &user(), Claimant::turn("t4", "turn-1"), std::slice::from_ref(&never)).await.unwrap();
    assert!(!Path::new(&never).exists(), "not a worktree: left to runtime, never made");
}

/// ADR-0053, the race: task t1's turn A failed at once, and its `turn.started` is handled late, after the next
/// queued turn B claimed the folder (B still reads archived and idle: it's in its `before:run`). A's event lets go
/// of A's claim only: a removal decided after B's claim stands down until B's own `turn.started`. (With claims per
/// task, A's late event released B's claim and the folder went under B.) A side run's claim (a /btw: no turn, no
/// event) is let go by no turn's event; it lapses.
#[tokio::test]
async fn a_late_turn_started_of_a_turn_that_failed_at_once_keeps_the_next_turns_claim() {
    let t = tmp("race");
    let root = repo(&t);
    let clock = wisp_testkit::FakeClock::at(1_000_000);
    let e = engine_on(&t, &clock);
    let wt = add_tree(&root, &t.0.join("h/worktrees/app-race"), "wisp/race");
    archived::bring_back(&e, &user(), Claimant::turn("t1", "turn-a"), &wt).await.unwrap(); // A starts, fails at once
    archived::bring_back(&e, &user(), Claimant::turn("t1", "turn-b"), &wt).await.unwrap(); // B, next in the queue
    let mark = e.mark(); // the task changed (A ended): a removal looks, after B's claim
    e.release("t1", "turn-a"); // A's turn.started, handled late
    assert!(!archived::tidy(&e, &user(), &wt, mark).await.unwrap().removed, "B is still starting in it");
    assert!(Path::new(&wt.path).is_dir());
    e.release("t1", "turn-b"); // B saved running: its state guards the folder from here
    assert!(archived::tidy(&e, &user(), &wt, e.mark()).await.unwrap().removed, "released: a fresh look decides");

    let side = add_tree(&root, &t.0.join("h/worktrees/app-side"), "wisp/side");
    archived::bring_back(&e, &user(), Claimant::side("t2"), &side).await.unwrap(); // a /btw
    e.release("t2", ""); // no turn's event matches a side run's claim, not even an empty id
    assert!(!archived::tidy(&e, &user(), &side, e.mark()).await.unwrap().removed, "the /btw's claim holds");
    clock.advance(u64::try_from(wisp_worktrees::engine::CLAIM_MS).unwrap());
    assert!(archived::tidy(&e, &user(), &side, e.mark()).await.unwrap().removed, "and lapses");
}

/// A claim made through a symlink or with `..` covers the folder as the disk sees it (`fsx::norm`), so a removal
/// asking by the worktree's own path stands down.
#[cfg(unix)]
#[tokio::test]
async fn a_claim_through_a_symlink_or_dotdot_holds_the_real_folder() {
    let t = tmp("alias");
    let root = repo(&t);
    let e = engine(&t);
    let wt = add_tree(&root, &t.0.join("h/worktrees/app-alias"), "wisp/alias");
    let link = t.0.join("link");
    std::os::unix::fs::symlink(&wt.path, &link).unwrap();
    e.claim(&link.join("src").to_string_lossy(), Claimant::turn("t1", "x")).await;
    assert!(!archived::tidy(&e, &user(), &wt, e.mark()).await.unwrap().removed, "claimed through the link");
    e.release("t1", "x");
    // by text these start with the worktree's path, but `..` takes them out of it: no claim on it
    let out = format!("{}/../app-other", wt.path);
    e.claim(&out, Claimant::turn("t2", "y")).await;
    // and these don't start with it, but `..` brings them in: a claim on it
    let odd = format!("{}/x/../app-alias", fsx_parent(&wt.path));
    e.claim(&odd, Claimant::turn("t3", "z")).await;
    assert!(!archived::tidy(&e, &user(), &wt, e.mark()).await.unwrap().removed, "claimed with `..`");
    e.release("t3", "z");
    assert!(archived::tidy(&e, &user(), &wt, e.mark()).await.unwrap().removed, "t2's claim, `..` out of it, never held it");
}

fn fsx_parent(p: &str) -> String {
    Path::new(p).parent().unwrap().to_string_lossy().into_owned()
}
