//! v1 test/ship.test.js and test/workspace.test.js's PR panel, ported onto a fake git.service and a
//! fake gh behind the proc service. Each test names the v1 case (or edge case) it ports.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod fake_gh;
mod fake_git;
mod flows;
mod follows;

use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use wisp_kernel::{BoxFuture, Call, Caller, CancellationToken, Clock};
use wisp_ship_api::{PrSummary, ShipRepo, ShipTask, Worktree};

use crate::gh::Gh;
use crate::ops::Shipper;
use crate::ship::{Out, Ship};
use crate::tasks::Tasks;
use fake_gh::FakeGh;
use fake_git::FakeGit;

#[derive(Debug, Default)]
pub struct FakeClock {
    pub now: AtomicI64,
}

impl Clock for FakeClock {
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()> {
        Box::pin(tokio::time::sleep(std::time::Duration::from_millis(ms)))
    }
}

pub struct H {
    pub ship: Arc<Ship>,
    pub git: FakeGit,
    pub gh: FakeGh,
    pub outs: Arc<Mutex<Vec<Out>>>,
    #[allow(dead_code)] // tests move time with it
    pub clock: Arc<FakeClock>,
    pub dir: PathBuf,
    pub call: Call,
}

static N: AtomicU32 = AtomicU32::new(0);

pub fn h() -> H {
    let gh = FakeGh::default();
    let git = FakeGit { gh: gh.clone(), ..FakeGit::default() };
    let clock = Arc::new(FakeClock { now: AtomicI64::new(1_000_000) });
    let outs: Arc<Mutex<Vec<Out>>> = Arc::default();
    let o = outs.clone();
    let shipper = Shipper {
        git: Arc::new(git.clone()),
        gh: Gh::new(Arc::new(gh.clone()), "gh"),
        owner: CancellationToken::new(),
        clock: clock.clone(),
    };
    let ship = Arc::new(Ship::new(
        shipper,
        Arc::new(Tasks::default()),
        Arc::new(move |out| o.lock().unwrap_or_else(PoisonError::into_inner).push(out)),
    ));
    let dir = std::env::temp_dir().join(format!("wisp-ship-test-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    let _ = std::fs::remove_dir_all(&dir);
    H { ship, git, gh, outs, clock, dir, call: Call::new_root(Caller::user()) }
}

impl H {
    /// A worktree folder that exists, branch `wisp/<name>`, based on origin/main.
    pub fn wt(&self, name: &str) -> Worktree {
        let path = self.dir.join(name);
        let _ = std::fs::create_dir_all(&path);
        let root = self.dir.join(format!("{name}-main"));
        let _ = std::fs::create_dir_all(&root);
        Worktree {
            path: path.display().to_string(),
            root: root.display().to_string(),
            branch: format!("wisp/{name}"),
            base: "main".into(),
            base_ref: "origin/main".into(),
            remote: Some("origin".into()),
            head: None,
            foreign: false,
        }
    }

    pub fn track(&self, id: &str, repos: &[(&str, Option<PrSummary>)]) -> Vec<Worktree> {
        let repos: Vec<ShipRepo> =
            repos.iter().map(|(n, pr)| ShipRepo { name: (*n).into(), worktree: self.wt(n), pr: pr.clone() }).collect();
        let wts = repos.iter().map(|r| r.worktree.clone()).collect();
        self.ship.tasks.put(ShipTask { session: id.into(), cwd: self.dir.display().to_string(), repos, ..ShipTask::default() });
        wts
    }

    pub fn dirty(&self, wt: &Worktree, n: u32) {
        self.git.lock().dirty.insert(wt.path.clone(), n);
    }

    pub fn outs(&self) -> Vec<Out> {
        self.outs.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }

    /// The stages the card saw, as v1's test read them off the summary stream.
    pub fn steps(&self, id: &str) -> Vec<Option<String>> {
        let mut seen: Vec<Option<String>> = Vec::new();
        for o in self.outs() {
            if let Out::Step { session, shipping } = o
                && session == id
            {
                let s = shipping.map(|s| s.step);
                if seen.last() != Some(&s) {
                    seen.push(s);
                }
            }
        }
        seen
    }

    pub fn follow_ups(&self, id: &str) -> Vec<String> {
        self.outs()
            .into_iter()
            .filter_map(|o| if let Out::FollowUp { session, prompt } = o { (session == id).then_some(prompt) } else { None })
            .collect()
    }

    pub fn task(&self, id: &str) -> ShipTask {
        self.ship.tasks.get(id).unwrap_or_default()
    }
}

impl Drop for H {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[test]
fn the_manifest_is_valid_and_names_every_command() {
    use wisp_kernel::Plugin;
    let m = crate::ShipPlugin::new().manifest();
    assert_eq!(m.id, "wisp.ship");
    assert!(m.requires.contains_key("git.service"));
    let cmds = m.contributes.get("commands").and_then(|v| v.as_array()).map_or(0, Vec::len);
    assert_eq!(cmds, 11, "ship.agent.pr (wisp_pr) is the 11th");
    for p in ["git:repo", "git:commit", "git:push", "git:merge.ff", "git:worktree.remove", "git:branch.delete", "proc:exec{bin:gh}"] {
        assert!(m.permissions.iter().any(|x| x == p), "{p}");
    }
}

#[test]
fn fix_conflicts_is_off_unless_switched_on() {
    assert!(!crate::fix_conflicts(None));
    assert!(!crate::fix_conflicts(Some(&serde_json::json!(false))));
    assert!(crate::fix_conflicts(Some(&serde_json::json!(true))));
    assert!(crate::fix_conflicts(Some(&serde_json::json!("on"))), "v1's value");
}
