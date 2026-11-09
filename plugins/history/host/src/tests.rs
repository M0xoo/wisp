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

/// wisp.runtime with one task, `t1`, in `dir`; its title can change.
struct Runtime(PathBuf, Arc<Mutex<String>>);
impl Plugin for Runtime {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.runtime", "version": "2.0.0", "api": "^1", "activation": ["onStartup"] })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        let (dir, title) = (self.0.display().to_string(), self.1.clone());
        s.command::<Get, _, _>(move |_c, _call, _a| {
            let (dir, title) = (dir.clone(), title.lock().unwrap().clone());
            async move { Ok(json!({ "id": "01a1bc12ab34cdef0123456789abcdef", "title": title, "cwd": dir, "agent": "claude", "state": "done" })) }
        });
        s.command::<SetExt, _, _>(|_c, _call, _a| async { Ok(json!({})) });
        s.command::<Turns, _, _>(|_c, _call, _a| async { Ok(json!([])) });
        Ok(())
    }
}

/// wisp.share: a full bundle for the task.
struct Share(Arc<Mutex<String>>);
impl Plugin for Share {
    fn manifest(&self) -> Manifest {
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.share", "version": "2.0.0", "api": "^1", "activation": ["onStartup"] })).unwrap()
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
        Manifest::from_value(json!({ "wispPlugin": 1, "id": "acme.db", "version": "1.0.0", "api": "^1", "activation": ["onStartup"] })).unwrap()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.contribute(&STORE, Arc::new(Db(self.0.clone())) as Arc<dyn HistoryStore>);
        s.contribute(&BLAME, Arc::new(Jj) as Arc<dyn BlameSource>);
        Ok(())
    }
}

fn git(dir: &Path, args: &[&str]) -> String {
    let o = std::process::Command::new("git").args(args).current_dir(dir).env("GIT_AUTHOR_NAME", "t").env("GIT_AUTHOR_EMAIL", "t@t").env("GIT_COMMITTER_NAME", "t").env("GIT_COMMITTER_EMAIL", "t@t").output().unwrap();
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
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    let mut app = TestApp::new().with(Runtime(d.to_owned(), title.clone())).with(Share(title.clone())).with(Acme(kept.clone())).service(store).service::<wisp_proc::Proc>(wisp_proc::local());
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
    let b = k.call(Caller::user(), "history.blame", json!({ "target": "code.txt", "repo": d.display().to_string(), "byLine": true })).await.unwrap();
    let lines = b["byLine"].as_array().unwrap();
    assert_eq!(lines.len(), 3, "{b}");
    assert_eq!((lines[0]["n"].clone(), lines[0]["text"].clone()), (json!(1), json!("one")));
    assert!(lines[0]["task"].as_str().unwrap().starts_with("01a1bc12ab34"), "{b}");
    assert!(lines[0]["title"].is_string(), "the task's title for the gutter: {b}");
    assert_eq!((lines[1]["text"].clone(), lines[1]["task"].clone()), (json!("TWO"), Value::Null), "by hand: no task");
    let plain = k.call(Caller::user(), "history.blame", json!({ "target": "code.txt", "repo": d.display().to_string() })).await.unwrap();
    assert!(plain.get("byLine").is_none(), "only when asked");
}
