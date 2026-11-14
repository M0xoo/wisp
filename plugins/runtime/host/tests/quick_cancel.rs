//! `runtime.quickCancel`: a named quick run (a goal's judge) stops when its caller lets it go, and its process is
//! gone, not left to run to its end spending tokens. A real process (the fake agent, hanging) through the local
//! proc service, as the server runs a judge.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use common::until;
use serde_json::Value;
use wisp_kernel::BoxFuture;
use wisp_runtime::{Recorder, Runtime, repo::Repo, schema};
use wisp_runtime_api::Harness;
use wisp_runtime_api::commands::QuickArgs;
use wisp_runtime_api::harness::{
    HarnessFound, HarnessInfo, HarnessModel, HarnessParser, HarnessRun, HarnessSys, Launch, ParserInput, ParserOutput, RunDriver, Stdin,
    pure,
};
use wisp_store::{Location, Store, SystemClock};

/// The fake agent as `claude`, told to hang after its first events: it runs until it's killed.
struct Hangs {
    info: HarnessInfo,
    bin: PathBuf,
    record: PathBuf,
}

struct Nothing;
impl HarnessParser for Nothing {
    fn on(&mut self, _input: ParserInput<'_>, _now: i64, _out: &mut ParserOutput) {}
}

impl Harness for Hangs {
    fn info(&self) -> &HarnessInfo {
        &self.info
    }
    fn detect<'a>(&'a self, _sys: &'a dyn HarnessSys) -> BoxFuture<'a, HarnessFound> {
        Box::pin(async { HarnessFound { available: true, ..HarnessFound::default() } })
    }
    fn launch(&self, run: &HarnessRun) -> wisp_kernel::Result<Launch> {
        let env = [("FAKE_HANG", "1".to_owned()), ("FAKE_RECORD", self.record.display().to_string())];
        Ok(Launch {
            program: self.bin.display().to_string(),
            env: env.into_iter().map(|(k, v)| (k.to_owned(), v)).collect(),
            stdin: Stdin::Bytes(run.prompt.clone().into_bytes()),
            ..Launch::default()
        })
    }
    fn driver(&self, _run: &HarnessRun) -> Box<dyn RunDriver> {
        pure(Nothing)
    }
}

/// The fake agent (`cargo build -p wisp-testkit --bins`), in the profile folder above this test's executable.
fn fake_agent() -> PathBuf {
    let name = format!("wisp-fake-agent{}", std::env::consts::EXE_SUFFIX);
    let exe = std::env::current_exe().unwrap();
    exe.ancestors()
        .map(|d| d.join(&name))
        .find(|p| p.is_file())
        .unwrap_or_else(|| panic!("no {name} above {}: run `cargo build -p wisp-testkit --bins` first", exe.display()))
}

fn pid_of(record: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(record.join("claude.jsonl")).ok()?;
    let line: Value = serde_json::from_str(text.lines().next()?).ok()?;
    line["pid"].as_u64().and_then(|p| u32::try_from(p).ok())
}

#[tokio::test(flavor = "multi_thread")]
async fn a_cancelled_quick_runs_process_is_gone() {
    let dir = std::env::temp_dir().join(format!("wisp-quick-cancel-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let (bins, record, cwd) = (dir.join("bin"), dir.join("record"), dir.join("cwd"));
    std::fs::create_dir_all(&cwd).unwrap();
    let agent = fake_agent();
    wisp_testkit::install_fakes_from(&bins, &["claude"], &agent, &agent).unwrap();
    let hangs = Hangs {
        info: HarnessInfo {
            id: "claude".into(),
            name: "Hangs".into(),
            models: vec![HarnessModel { id: "m1".into(), label: "M1".into(), hint: None, efforts: vec![] }],
            ..HarnessInfo::default()
        },
        bin: bins.join(format!("claude{}", std::env::consts::EXE_SUFFIX)),
        record: record.clone(),
    };
    let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
    schema::install(&store).unwrap();
    let host = Arc::new(Recorder { harnesses: vec![Arc::new(hangs)], ..Recorder::default() });
    let rt = Runtime::new(Repo::new(store), host, wisp_proc::local(), Arc::new(SystemClock));
    rt.start().await.unwrap();

    let q = QuickArgs {
        prompt: "is it met?".into(),
        cwd: cwd.display().to_string(),
        pick: None,
        timeout_ms: Some(60_000),
        json: false,
        run_id: Some("judge-1".into()),
    };
    let r = rt.clone();
    let run = tokio::spawn(async move { r.quick(q).await });
    until("the judge's process to start", || {
        let record = record.clone();
        async move { pid_of(&record).is_some() }
    })
    .await;
    let pid = pid_of(&record).unwrap();
    assert!(wisp_proc::pid_alive(pid), "it hangs until it's stopped");

    assert!(rt.quick_cancel("judge-1"), "a run under way is stopped");
    let out = tokio::time::timeout(std::time::Duration::from_secs(10), run).await.expect("the run ends at once").unwrap();
    let err = wisp_kernel::WireError::from(out.expect_err("a cancelled run gives no answer"));
    assert_eq!(err.details.as_ref().and_then(|d| d["cancelled"].as_bool()), Some(true), "{err:?}");
    assert!(!wisp_proc::pid_alive(pid), "its process is gone");
    assert!(!rt.quick_cancel("judge-1"), "nothing left to stop");

    // a cancel that lands before its run starts (a goal dropped as its judge was sent): the run never spawns
    assert!(!rt.quick_cancel("judge-2"));
    let early = QuickArgs {
        prompt: "x".into(),
        cwd: cwd.display().to_string(),
        pick: None,
        timeout_ms: None,
        json: false,
        run_id: Some("judge-2".into()),
    };
    assert!(rt.quick(early).await.is_err());
    let runs = std::fs::read_to_string(record.join("claude.jsonl")).unwrap();
    assert_eq!(runs.lines().count(), 1, "no second process: {runs}");
    std::fs::remove_dir_all(&dir).ok();
}
