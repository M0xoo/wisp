//! ADR-0042's edge cases for wisp.history, on a kernel with stand-ins for wisp.runtime and wisp.share.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::assert_is_empty)]

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use wisp_history_api::{BLAME, BlameSource, HistoryStore, STORE};
use wisp_kernel::{BoxFuture, Caller, Command, Kernel, Manifest, Plugin, Result, Setup};
use wisp_store::{Location, Store, SystemClock};
use wisp_testkit::TestApp;

macro_rules! fake_cmd {
    ($ty:ident, $id:literal) => {
        struct $ty;
        impl Command for $ty {
            const ID: &'static str = $id;
            type Args = Value;
            type Out = Value;
        }
    };
}
fake_cmd!(Get, "runtime.get");
fake_cmd!(SetExt, "runtime.setExt");
fake_cmd!(Turns, "runtime.turns");
/// `share.preview`, under the real one's permission.
struct Preview;
impl Command for Preview {
    const ID: &'static str = "share.preview";
    const PERMISSION: Option<&'static str> = Some("share:make");
    type Args = Value;
    type Out = Value;
}

/// The fake task's `wisp.history` slot, and a write to land just before the next offer does (another write that
/// lands between the offer's read and its write).
#[derive(Default)]
struct Slot {
    value: Value,
    before_offer: Option<Value>,
}

/// wisp.runtime with one task, `t1`, in `dir`; its title can change; its history slot is kept and `runtime.setExt`
/// honours `expect` as the real one does (refused with `conflict` unless the slot still holds it).
struct Runtime(PathBuf, Arc<Mutex<String>>, Arc<Mutex<Slot>>);
impl Plugin for Runtime {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.runtime", "version": "2.0.0", "api": "^1", "activation": ["onStartup"] }))
            .unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let (dir, title, slot) = (self.0.display().to_string(), self.1.clone(), self.2.clone());
        let read = slot.clone();
        s.command::<Get, _, _>(move |_c, _call, _a| {
            let (dir, title) = (dir.clone(), title.lock().unwrap().clone());
            let ext = read.lock().unwrap().value.clone();
            // the real runtime.get's shape (a whole Session), so a wrong-shape read fails here
            let mut t = wisp_runtime_api::model::Session {
                id: "01a1bc12ab34cdef0123456789abcdef".into(),
                title,
                cwd: dir,
                agent: "claude".into(),
                state: wisp_runtime_api::model::SessionState::Done,
                ..Default::default()
            };
            if !ext.is_null() {
                t.ext.insert(wisp_history_api::EXT.into(), ext);
            }
            async move { Ok(serde_json::to_value(t).unwrap()) }
        });
        s.command::<SetExt, _, _>(move |_c, _call, a| {
            let mut s = slot.lock().unwrap();
            if a["value"]["offer"] == true
                && let Some(v) = s.before_offer.take()
            {
                s.value = v;
            }
            let r = match a.get("expect") {
                Some(e) if e["value"] != s.value => Err(wisp_kernel::WireError::conflict("changed meanwhile")),
                _ => {
                    s.value = a["value"].clone();
                    Ok(json!({}))
                }
            };
            async move { r }
        });
        s.command::<Turns, _, _>(|_c, _call, _a| async { Ok(json!([])) });
        Ok(())
    }
}

/// wisp.share: a full bundle for the task.
struct Share(Arc<Mutex<String>>);
impl Plugin for Share {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.share", "version": "2.0.0", "api": "^1", "activation": ["onStartup"] }))
            .unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let title = self.0.clone();
        s.command::<Preview, _, _>(move |_c, _call, _a| {
            let title = title.lock().unwrap().clone();
            async move { Ok(json!({ "bundle": { "wispTask": 1, "id": "share-x", "level": "full", "title": title, "createdAt": 1_794_181_336_230_i64, "version": "2", "needs": [], "spec": { "prompt": "fix it", "agent": "claude" }, "formula": {}, "report": { "answers": [], "files": ["math.js"] }, "history": [{ "turn": { "prompt": "fix it" } }] }, "redactions": [] })) }
        });
        Ok(())
    }
}

#[derive(Default, Clone)]
struct Kept(Arc<Mutex<Vec<String>>>);

/// A user's store, `db`: it keeps the paths it's handed.
struct Db(Kept);
impl HistoryStore for Db {
    fn id(&self) -> &'static str {
        "db"
    }
    fn write(&self, _root: PathBuf, files: Vec<(String, Vec<u8>)>) -> BoxFuture<'static, Result<Vec<String>>> {
        let names: Vec<String> = files.into_iter().map(|(r, _)| r).collect();
        self.0.0.lock().unwrap().extend(names.clone());
        Box::pin(async move { Ok(names) })
    }
    fn remove(&self, _root: PathBuf, _rels: Vec<String>) -> BoxFuture<'static, Result<Vec<String>>> {
        Box::pin(async { Ok(Vec::new()) })
    }
    fn read(&self, _root: PathBuf, _rel: String) -> BoxFuture<'static, Option<Vec<u8>>> {
        Box::pin(async { None })
    }
}

/// A user's blame source, `jj`: every line of every file is one commit that names t1.
struct Jj;
impl BlameSource for Jj {
    fn id(&self) -> &'static str {
        "jj"
    }
    fn blame(&self, _r: PathBuf, _f: String, _g: Option<(u32, u32)>) -> BoxFuture<'static, Vec<(String, u32)>> {
        Box::pin(async { vec![("c0ffee".to_owned(), 7)] })
    }
    fn message(&self, _r: PathBuf, _s: String) -> BoxFuture<'static, String> {
        Box::pin(async { "x\n\nWisp-Task: 01a1bc12ab34".to_owned() })
    }
    fn commits(&self, _r: PathBuf, _s: String, _p: String) -> BoxFuture<'static, Vec<String>> {
        Box::pin(async { vec!["c0ffee".to_owned()] })
    }
    fn grep(&self, _r: PathBuf, _n: String) -> BoxFuture<'static, Vec<String>> {
        Box::pin(async { Vec::new() })
    }
    fn added(&self, _r: PathBuf, _s: String) -> BoxFuture<'static, Vec<(String, u32)>> {
        Box::pin(async { Vec::new() })
    }
    fn knows(&self, _r: PathBuf) -> BoxFuture<'static, bool> {
        Box::pin(async { true })
    }
}

struct Acme(Kept);
impl Plugin for Acme {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "acme.db", "version": "1.0.0", "api": "^1", "activation": ["onStartup"] }))
            .unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.contribute(&STORE, Arc::new(Db(self.0.clone())) as Arc<dyn HistoryStore>);
        s.contribute(&BLAME, Arc::new(Jj) as Arc<dyn BlameSource>);
        Ok(())
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let o = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@t")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@t")
        .output()
        .unwrap();
    assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
    String::from_utf8_lossy(&o.stdout).into_owned()
}

fn dir(name: &str, yml: &str, repo: bool) -> PathBuf {
    let d = std::env::temp_dir().join(format!("wisp-history-{name}-{}", wisp_kernel::ids::uuid7()));
    std::fs::create_dir_all(d.join(".wisp")).unwrap();
    std::fs::write(d.join(".wisp/wisp.yml"), format!("wisp: 1\n{yml}\n")).unwrap();
    std::fs::write(d.join("math.js"), "a + b\n").unwrap();
    if repo {
        git(&d, &["init", "-q", "-b", "main"]);
        git(&d, &["add", "."]);
        git(&d, &["commit", "-qm", "init"]);
    }
    d
}

async fn kernel(d: &Path, title: &Arc<Mutex<String>>, with_history: bool, kept: &Kept) -> Kernel {
    kernel_with(d, title, with_history, kept, Arc::default()).await
}

async fn kernel_with(d: &Path, title: &Arc<Mutex<String>>, with_history: bool, kept: &Kept, slot: Arc<Mutex<Slot>>) -> Kernel {
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let mut app = TestApp::new()
        .with(Runtime(d.to_owned(), title.clone(), slot))
        .with(Share(title.clone()))
        .with(Acme(kept.clone()))
        .service(store)
        .service::<wisp_proc::Proc>(wisp_proc::local());
    if with_history {
        app = app.with(super::HistoryPlugin);
    }
    app.start().await
}

fn files_under(d: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![d.join(".wisp")];
    while let Some(x) = stack.pop() {
        for e in std::fs::read_dir(&x).into_iter().flatten().flatten() {
            if e.path().is_dir() {
                stack.push(e.path());
            } else {
                out.push(e.path().strip_prefix(d).unwrap().display().to_string());
            }
        }
    }
    out.sort();
    out
}

fn track() -> Value {
    json!({ "id": "t1" })
}

#[tokio::test(flavor = "multi_thread")]
async fn history_off_leaves_share_working() {
    let d = dir("off", "", true);
    let k = kernel(&d, &Arc::new(Mutex::new("Fix".into())), false, &Kept::default()).await;
    assert!(k.call(Caller::user(), "share.preview", json!({ "id": "t1" })).await.is_ok());
    let e = k.call(Caller::user(), "history.track", track()).await.unwrap_err();
    assert!(e.message.contains("history.track"), "{e:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_user_store_receives_the_writes() {
    let d = dir("db", "history: { transcripts: db }", true);
    let kept = Kept::default();
    let k = kernel(&d, &Arc::new(Mutex::new("Fix".into())), true, &kept).await;
    let t = k.call(Caller::user(), "history.track", track()).await.unwrap();
    assert_eq!(t["store"], "db");
    assert_eq!(kept.0.lock().unwrap().len(), 3, "task, report, transcript: {:?}", kept.0.lock().unwrap());
    assert_eq!(files_under(&d), [".wisp/wisp.yml"], "nothing in the tree");
}

#[tokio::test(flavor = "multi_thread")]
async fn notes_keep_the_tree_clean() {
    let d = dir("notes", "history: { transcripts: notes }", true);
    let k = kernel(&d, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default()).await;
    let t = k.call(Caller::user(), "history.track", track()).await.unwrap();
    let files = files_under(&d);
    assert!(files.iter().any(|f| f.ends_with(".task.yml")) && files.iter().any(|f| f.ends_with(".report.md")), "{files:?}");
    assert!(!files.iter().any(|f| f.contains("history/")), "the transcript isn't in the tree: {files:?}");
    assert!(t["files"].to_string().contains("refs/notes/wisp:history/01a1bc12ab34cdef0123456789abcdef.jsonl.zst"), "{t}");
    assert!(!git(&d, &["notes", "--ref=wisp", "list"]).trim().is_empty());
    // the note reads back exactly
    let st = super::stores::Notes(Arc::new(wisp_proc::local()));
    let z = st.read(d.clone(), "history/01a1bc12ab34cdef0123456789abcdef.jsonl.zst".into()).await.unwrap();
    assert_eq!(wisp_history_core::repo::read_transcript(&z), vec![json!({ "turn": { "prompt": "fix it" } })]);
    // and untracking takes it out of the notes
    k.call(Caller::user(), "history.untrack", json!({ "id": "01a1bc12ab34", "repo": d.display().to_string() })).await.unwrap();
    assert!(git(&d, &["notes", "--ref=wisp", "list"]).trim().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn notes_work_where_git_has_no_identity() {
    // CI and fresh boxes: no user.name/email and none to guess (`useConfigOnly` makes git refuse to guess)
    let d = dir("notes-noid", "history: { transcripts: notes }", true);
    git(&d, &["config", "user.useConfigOnly", "true"]);
    let k = kernel(&d, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default()).await;
    let t = k.call(Caller::user(), "history.track", track()).await.unwrap();
    assert!(t["files"].to_string().contains("refs/notes/wisp:"), "{t}");
    let who = std::process::Command::new("git")
        .args(["log", "-1", "--format=%an <%ae> / %cn <%ce>", "refs/notes/wisp"])
        .current_dir(&d)
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8_lossy(&who.stdout).trim(),
        "wisp <wisp@localhost> / wisp <wisp@localhost>",
        "the notes commit is wisp's, not a guess"
    );
    let cfg = std::fs::read_to_string(d.join(".git/config")).unwrap();
    assert!(!cfg.contains("[user]\n\tname") && !cfg.contains("email"), "wisp never writes the user's git config: {cfg}");
    k.call(Caller::user(), "history.untrack", json!({ "id": "01a1bc12ab34", "repo": d.display().to_string() })).await.unwrap();
    assert!(git(&d, &["notes", "--ref=wisp", "list"]).trim().is_empty(), "removing works without an identity too");
}

#[tokio::test(flavor = "multi_thread")]
async fn lfs_marks_transcripts() {
    let d = dir("lfs", "history: { transcripts: lfs }", true);
    let k = kernel(&d, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default()).await;
    k.call(Caller::user(), "history.track", track()).await.unwrap();
    k.call(Caller::user(), "history.track", track()).await.unwrap();
    let attrs = std::fs::read_to_string(d.join(".gitattributes")).unwrap();
    assert_eq!(attrs.matches(super::stores::LFS_LINE).count(), 1, "{attrs}");
    assert!(files_under(&d).iter().any(|f| f.ends_with(".jsonl.zst")));
}

#[tokio::test(flavor = "multi_thread")]
async fn tracking_twice_rewrites_in_place() {
    let d = dir("twice", "", true);
    let title = Arc::new(Mutex::new("Fix the login".to_owned()));
    let k = kernel(&d, &title, true, &Kept::default()).await;
    k.call(Caller::user(), "history.track", track()).await.unwrap();
    *title.lock().unwrap() = "Fix the login for good".into();
    k.call(Caller::user(), "history.track", track()).await.unwrap();
    let files = files_under(&d);
    assert_eq!(files.iter().filter(|f| f.ends_with(".task.yml")).count(), 1, "{files:?}");
    assert_eq!(files.iter().filter(|f| f.ends_with(".report.md")).count(), 1, "{files:?}");
    assert!(files.iter().any(|f| f.contains("fix-the-login-for-good")), "the new title's name: {files:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_folder_without_git_still_tracks() {
    let d = dir("nogit", "", false);
    let k = kernel(&d, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default()).await;
    let t = k.call(Caller::user(), "history.track", track()).await.unwrap();
    assert_eq!((t["store"].clone(), t["commits"].clone(), t["pr"].clone()), (json!("files"), json!([]), Value::Null));
    let b = k.call(Caller::user(), "history.blame", json!({ "target": "math.js:1", "repo": d.display().to_string() })).await.unwrap();
    assert_eq!(b["kind"], "unknown");
    assert!(b["note"].as_str().unwrap().contains("isn't under git"), "{b}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_user_blame_source_answers() {
    let d = dir("jj", "history: { blame: jj }", false);
    let k = kernel(&d, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default()).await;
    k.call(Caller::user(), "history.track", track()).await.unwrap();
    let b = k.call(Caller::user(), "history.blame", json!({ "target": "math.js", "repo": d.display().to_string() })).await.unwrap();
    assert_eq!((b["lines"].clone(), b["tasks"][0]["task"].clone()), (json!(7), json!("01a1bc12ab34cdef0123456789abcdef")), "{b}");
}

#[tokio::test(flavor = "multi_thread")]
async fn still_there_counts_the_lines_left() {
    let d = dir("still", "", true);
    let k = kernel(&d, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default()).await;
    std::fs::write(d.join("code.txt"), "one\ntwo\nthree\nfour\n").unwrap();
    git(&d, &["add", "code.txt"]);
    git(&d, &["commit", "-qm", "the task's code\n\nWisp-Task: 01a1bc12ab34"]);
    k.call(Caller::user(), "history.track", track()).await.unwrap();
    std::fs::write(d.join("code.txt"), "one\nTWO\nthree\nfour\n").unwrap();
    git(&d, &["commit", "-qam", "by hand"]);
    let b = k.call(Caller::user(), "history.blame", json!({ "target": "01a1bc12ab34", "repo": d.display().to_string() })).await.unwrap();
    assert_eq!((b["tasks"][0]["what"]["added"].clone(), b["tasks"][0]["what"]["stillThere"].clone()), (json!(4), json!(0.75)), "{b}");
    std::fs::remove_file(d.join("code.txt")).unwrap();
    git(&d, &["commit", "-qam", "all gone"]);
    let b = k.call(Caller::user(), "history.blame", json!({ "target": "01a1bc12ab34", "repo": d.display().to_string() })).await.unwrap();
    assert_eq!(b["tasks"][0]["what"]["stillThere"], json!(0.0), "{b}");
    // a task with no commits shows nothing, not 0%
    let e = dir("still-none", "", true);
    let k = kernel(&e, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default()).await;
    k.call(Caller::user(), "history.track", track()).await.unwrap();
    let b = k.call(Caller::user(), "history.blame", json!({ "target": "01a1bc12ab34", "repo": e.display().to_string() })).await.unwrap();
    assert_eq!(b["tasks"][0]["what"]["stillThere"], Value::Null, "{b}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_can_ask_but_not_answer() {
    let d = dir("agent", "", true);
    let k = kernel(&d, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default()).await;
    let agent = Caller { set: "agent:session".into(), session: Some("01a1bc12ab34cdef0123456789abcdef".into()), plugin: None };
    let r = k.call(agent.clone(), "history.resumeRequest", json!({ "id": "t1", "why": "the login broke again" })).await.unwrap();
    assert_eq!(r["state"], "pending");
    let e = k.call(agent, "history.resumeAnswer", json!({ "request": r["id"], "approve": true })).await.unwrap_err();
    assert_eq!(e.code, wisp_kernel::Code::Forbidden, "{e:?}");
}

/// The TUI's why-gutter: a file's blame with `byLine` lists every line with the task that wrote it (its title and
/// prompt), and a line written by hand with none.
#[tokio::test(flavor = "multi_thread")]
async fn blame_by_line_names_each_lines_task() {
    let d = dir("byline", "", true);
    let k = kernel(&d, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default()).await;
    std::fs::write(d.join("code.txt"), "one\ntwo\nthree\n").unwrap();
    git(&d, &["add", "code.txt"]);
    git(&d, &["commit", "-qm", "the task's code\n\nWisp-Task: 01a1bc12ab34"]);
    k.call(Caller::user(), "history.track", track()).await.unwrap();
    std::fs::write(d.join("code.txt"), "one\nTWO\nthree\n").unwrap();
    git(&d, &["commit", "-qam", "by hand"]);
    let b = k
        .call(Caller::user(), "history.blame", json!({ "target": "code.txt", "repo": d.display().to_string(), "byLine": true }))
        .await
        .unwrap();
    let lines = b["byLine"].as_array().unwrap();
    assert_eq!(lines.len(), 3, "{b}");
    assert_eq!((lines[0]["n"].clone(), lines[0]["text"].clone()), (json!(1), json!("one")));
    assert!(lines[0]["task"].as_str().unwrap().starts_with("01a1bc12ab34"), "{b}");
    assert!(lines[0]["title"].is_string(), "the task's title for the gutter: {b}");
    assert_eq!((lines[1]["text"].clone(), lines[1]["task"].clone()), (json!("TWO"), Value::Null), "by hand: no task");
    let plain = k.call(Caller::user(), "history.blame", json!({ "target": "code.txt", "repo": d.display().to_string() })).await.unwrap();
    assert!(plain.get("byLine").is_none(), "only when asked");
}

/// A task with no folder has no repo: track and untrack without `repo` refuse it, and never fall back to the
/// server's own folder (`Path::new("")` would read and remove the server cwd's `.wisp/`).
#[tokio::test(flavor = "multi_thread")]
async fn a_task_with_no_folder_is_never_tracked_in_the_servers_folder() {
    let k = kernel(Path::new(""), &Arc::new(Mutex::new("Fix".into())), true, &Kept::default()).await;
    for cmd in ["history.track", "history.untrack"] {
        let e = k.call(Caller::user(), cmd, track()).await.unwrap_err();
        assert_eq!(e.code, wisp_kernel::Code::Invalid, "{cmd}: {e:?}");
        assert!(e.message.contains("no folder"), "{cmd}: {e:?}");
    }
}

/// A `repo` that's empty or relative names the server's own folder (`Path::new("")` reads, writes and removes its
/// `.wisp/`): every command that takes one refuses it.
#[tokio::test(flavor = "multi_thread")]
async fn a_named_repo_that_is_empty_or_relative_is_refused_by_every_command() {
    let d = dir("named", "", true);
    let k = kernel(&d, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default()).await;
    for repo in ["", " ", ".", "relative/repo"] {
        let calls = [
            ("history.track", json!({ "id": "t1", "repo": repo })),
            ("history.save", json!({ "id": "t1", "repo": repo })),
            ("history.untrack", json!({ "id": "t1", "repo": repo })),
            ("history.list", json!({ "repo": repo })),
            ("history.report", json!({ "id": "t1", "repo": repo })),
            ("history.blame", json!({ "target": "code.txt", "repo": repo })),
            ("history.resumeRequest", json!({ "id": "t1", "repo": repo })),
        ];
        for (cmd, args) in calls {
            let e = k.call(Caller::user(), cmd, args).await.unwrap_err();
            assert_eq!(e.code, wisp_kernel::Code::Invalid, "{cmd} {repo:?}: {e:?}");
            assert!(e.message.contains("repo"), "{cmd} {repo:?}: {e:?}");
        }
    }
}

/// The change a save's own write makes runs the done check again: the save counted the turns as seen, so no offer
/// comes back over `tracked` (`serve_history.rs`'s `offers_the_mark_resume_requests_and_injection` failed on CI this way).
#[tokio::test(flavor = "multi_thread")]
async fn a_saved_task_is_not_offered_again() {
    let d = dir("saved", "history: { track: ask }", true);
    let slot = Arc::new(Mutex::new(Slot::default()));
    let k = kernel_with(&d, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default(), slot.clone()).await;
    let ctx = k.ctx("wisp.history").unwrap();
    super::on_done(&ctx, "t1").await;
    assert_eq!(slot.lock().unwrap().value["offer"], true, "offered first: {}", slot.lock().unwrap().value);
    k.call(Caller::user(), "history.save", track()).await.unwrap();
    super::on_done(&ctx, "t1").await;
    let v = slot.lock().unwrap().value.clone();
    assert_eq!((v["offer"].clone(), v["tracked"]["store"].clone()), (json!(false), json!("files")), "{v}");
}

/// A save that lands between the done check's read of the slot and its write: the offer, computed from the copy
/// before the save, never lands over it (it reads again, sees the turns saved, and writes nothing).
#[tokio::test(flavor = "multi_thread")]
async fn a_save_between_the_offers_read_and_write_wins() {
    let d = dir("race", "history: { track: ask }", true);
    let saved = json!({ "tracked": { "repo": d.display().to_string(), "files": [".wisp/x.task.yml"], "store": "files" }, "offer": false, "seenTurns": 0 });
    let slot = Arc::new(Mutex::new(Slot { value: Value::Null, before_offer: Some(saved.clone()) }));
    let k = kernel_with(&d, &Arc::new(Mutex::new("Fix".into())), true, &Kept::default(), slot.clone()).await;
    super::on_done(&k.ctx("wisp.history").unwrap(), "t1").await;
    let s = slot.lock().unwrap();
    assert!(s.before_offer.is_none(), "the save landed mid-offer");
    assert_eq!(s.value, saved, "the save wins");
}
