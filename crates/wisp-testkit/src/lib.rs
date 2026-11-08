//! wisp-testkit (plan §6.10): what every plugin's tests get for free. A `FakeClock` the test moves, a
//! `TestApp` that starts a plugin with stubs for what it requires, the free tests
//! (`assert_deactivate_leaks_nothing`, `assert_missing_permission_refused`), golden files, and the fake
//! harness and `gh` binaries (`fake_agent_bin`, `fake_gh_bin`).
//!
//! An assertion library: its helpers panic with a message on purpose, like `assert!`.
#![allow(clippy::panic, clippy::expect_used, clippy::missing_panics_doc)]

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use tokio::sync::oneshot;
use wisp_kernel::{
    App, BoxFuture, Caller, Clock, Code, Declarative, Kernel, Manifest, Plugin, PluginGroup,
};

/// A clock that moves only when the test says so. `sleep` resolves once `advance` passes its deadline.
#[derive(Debug, Clone, Default)]
pub struct FakeClock {
    inner: Arc<Mutex<ClockState>>,
}

#[derive(Debug, Default)]
struct ClockState {
    now: i64,
    sleepers: Vec<(i64, oneshot::Sender<()>)>,
}

impl FakeClock {
    pub fn at(ms: i64) -> Self {
        let c = Self::default();
        c.lock().now = ms;
        c
    }
    fn lock(&self) -> std::sync::MutexGuard<'_, ClockState> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    /// Moves time forward and wakes every sleeper whose deadline passed, in deadline order.
    pub fn advance(&self, ms: u64) {
        let due = {
            let mut s = self.lock();
            s.now += i64::try_from(ms).unwrap_or(i64::MAX);
            let now = s.now;
            let (mut due, keep): (Vec<_>, Vec<_>) = s.sleepers.drain(..).partition(|x| x.0 <= now);
            s.sleepers = keep;
            due.sort_by_key(|x| x.0);
            due
        };
        for (_, tx) in due {
            let _ = tx.send(());
        }
    }
    /// Sleepers waiting right now (a test waits for a timer to be armed before advancing).
    pub fn sleepers(&self) -> usize {
        self.lock().sleepers.len()
    }
    /// The clock as the kernel service plugins read (`ctx.clock()`).
    pub fn service(&self) -> Arc<dyn Clock> {
        Arc::new(self.clone())
    }
}

impl Clock for FakeClock {
    fn now_ms(&self) -> i64 {
        self.lock().now
    }
    fn sleep(&self, ms: u64) -> BoxFuture<'static, ()> {
        if ms == 0 {
            return Box::pin(async {});
        }
        let (tx, rx) = oneshot::channel();
        {
            let mut s = self.lock();
            let at = s.now + i64::try_from(ms).unwrap_or(i64::MAX);
            s.sleepers.push((at, tx));
        }
        Box::pin(async move {
            let _ = rx.await;
        })
    }
}

/// Builds a kernel around the plugins under test. Every plugin they hard-require that isn't in the
/// set is stubbed by a declarative plugin of that id, so a plugin's tests don't need the real ones.
/// Service contracts can't be stubbed (they need code): add a provider with `with`.
pub struct TestApp {
    app: App,
    group: PluginGroup,
    manifests: Vec<Manifest>,
}

impl std::fmt::Debug for TestApp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TestApp")
            .field("plugins", &self.manifests.len())
            .finish_non_exhaustive()
    }
}

impl Default for TestApp {
    fn default() -> Self {
        Self::new()
    }
}

impl TestApp {
    pub fn new() -> Self {
        Self {
            app: App::new(),
            group: PluginGroup::new(),
            manifests: Vec::new(),
        }
    }
    #[must_use]
    pub fn with(mut self, p: impl Plugin) -> Self {
        self.manifests.push(p.manifest());
        self.group = std::mem::take(&mut self.group).add(p);
        self
    }
    /// Uses `clock` as the kernel's clock (interceptor budgets, schedules, exec backoff).
    #[must_use]
    pub fn clock(mut self, clock: &FakeClock) -> Self {
        self.app = self.app.service(clock.service());
        self
    }
    /// Provides a kernel service (store, proc, paths, …).
    #[must_use]
    pub fn service<T: wisp_kernel::KernelService>(mut self, v: T) -> Self {
        self.app = self.app.service(v);
        self
    }
    pub async fn start(self) -> Kernel {
        let have: BTreeSet<String> = self.manifests.iter().map(|m| m.id.clone()).collect();
        let provided: BTreeSet<String> = self
            .manifests
            .iter()
            .flat_map(|m| m.provides.keys().cloned())
            .collect();
        let mut group = self.group;
        let mut stubbed = BTreeSet::new();
        for m in &self.manifests {
            let mut wanted: Vec<(String, String)> = m
                .requirements()
                .into_iter()
                .filter(|r| !r.optional)
                .map(|r| (r.id, r.version))
                .collect();
            wanted.extend(m.extends.clone().map(|e| (e, "*".to_owned())));
            for (id, range) in wanted {
                if !have.contains(&id)
                    && !provided.contains(&id)
                    && !id.ends_with(".service")
                    && stubbed.insert(id.clone())
                {
                    group = group.add(Declarative(stub_manifest(&id, &range)));
                }
            }
        }
        self.app
            .plugins(group)
            .start()
            .await
            .expect("the test kernel starts")
    }
}

/// A declarative stand-in whose version satisfies `range` (the lowest x.y.0 that does).
fn stub_manifest(id: &str, range: &str) -> Manifest {
    let version = (0..50).flat_map(|x| (0..50).map(move |y| format!("{x}.{y}.0"))).find(|v| wisp_kernel::semver::satisfies(v, range)).unwrap_or_else(|| "1.0.0".into());
    Manifest::from_value(json!({ "wispPlugin": 1, "id": id, "version": version, "api": "^1", "description": "a testkit stub" })).expect("stub manifest")
}

fn state(k: &Kernel, id: &str) -> (String, Option<String>) {
    k.status()
        .into_iter()
        .find(|s| s.id == id).map_or_else(|| panic!("{id} isn't in the kernel"), |s| (s.state, s.reason))
}

/// Free test (plan §6.10): start the plugin, switch it off, and nothing it registered is left:
/// commands, interceptors, subscriptions, contributions, services, routes, setting watchers.
pub async fn assert_deactivate_leaks_nothing(p: impl Plugin) {
    let m = p.manifest();
    let k = TestApp::new().with(p).start().await;
    if state(&k, &m.id).0 == "resolved" {
        // a lazy plugin: wake it the way its manifest says
        for a in &m.activation {
            k.wake(a, None).await;
        }
    }
    let (s, why) = state(&k, &m.id);
    assert_eq!(
        s, "active",
        "{} should be active before the leak check: {why:?}",
        m.id
    );
    k.set_enabled(&m.id, false).await.expect("switch off");
    k.idle().await;
    assert_eq!(state(&k, &m.id).0, "off");
    assert_eq!(
        k.registrations(&m.id),
        0,
        "{} left registrations behind after it was switched off",
        m.id
    );
    assert!(k.ctx(&m.id).is_none(), "{} still has a context", m.id);
}

/// Free test (plan §6.10): `cmd` is unreachable for a caller whose set doesn't name its permission
/// (default deny), and reachable past the permission check for the local user.
pub async fn assert_missing_permission_refused(p: impl Plugin, cmd: &str, args: Value) {
    let k = TestApp::new().with(p).start().await;
    let nobody = Caller::set("pane:wisp-testkit-nobody");
    let e = k
        .call(nobody, cmd, args.clone())
        .await
        .expect_err("a caller without the permission must be refused");
    if let Err(u) = k.call(Caller::user(), cmd, args).await {
        assert_ne!(
            u.code,
            Code::NotFound,
            "{cmd} isn't registered: {}",
            u.message
        );
        assert_ne!(
            u.code,
            Code::Forbidden,
            "{cmd} refused the user too: {}",
            u.message
        );
    }
    assert_eq!(e.code, Code::Forbidden, "{cmd}: {}", e.message);
}

/// The workspace root: the nearest ancestor of this crate whose Cargo.toml has `[workspace]`.
pub fn workspace_root() -> PathBuf {
    let mut at = Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf();
    loop {
        if std::fs::read_to_string(at.join("Cargo.toml")).is_ok_and(|s| s.contains("[workspace]")) {
            return at;
        }
        if !at.pop() {
            return PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        }
    }
}

/// Compares `actual` with `test/goldens/<name>.json`. `UPDATE_GOLDENS=1` writes the file instead:
/// changing a golden is a deliberate act in the PR.
pub fn assert_golden(name: &str, actual: &Value) {
    assert_golden_at(&workspace_root().join("test/goldens"), name, actual);
}

pub fn assert_golden_at(dir: &Path, name: &str, actual: &Value) {
    let path = dir.join(format!("{name}.json"));
    let text = format!("{}\n", serde_json::to_string_pretty(actual).expect("JSON"));
    if std::env::var("UPDATE_GOLDENS").is_ok_and(|v| v == "1") {
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).expect("golden dir");
        }
        std::fs::write(&path, text).expect("write golden");
        return;
    }
    let Ok(want) = std::fs::read_to_string(&path) else {
        panic!(
            "no golden at {}: run with UPDATE_GOLDENS=1 to write it",
            path.display()
        );
    };
    let want_v: Value =
        serde_json::from_str(&want).unwrap_or_else(|e| panic!("{}: not JSON: {e}", path.display()));
    assert!(
        want_v == *actual,
        "{} differs from the golden (UPDATE_GOLDENS=1 rewrites it)\n--- golden\n{want}\n--- actual\n{text}",
        path.display()
    );
}

/// The fake harness binary: link or copy it as `claude`, `codex`, … (the file name picks the CLI).
pub fn fake_agent_bin() -> PathBuf {
    sibling("wisp-fake-agent")
}

/// The fake GitHub CLI binary: link or copy it as `gh`.
pub fn fake_gh_bin() -> PathBuf {
    sibling("wisp-fake-gh")
}

/// A bin of this crate, next to the running test's executable (`target/<profile>/`).
fn sibling(name: &str) -> PathBuf {
    let exe = std::env::current_exe().unwrap_or_default();
    let dir = exe.parent().map_or(Path::new("."), |d| {
        if d.ends_with("deps") {
            d.parent().unwrap_or(d)
        } else {
            d
        }
    });
    dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX))
}

/// Puts the fake harnesses and gh in `dir` under the CLIs' names (symlinks; copies off Unix), for a
/// PATH a test controls.
pub fn install_fakes(dir: &Path, names: &[&str]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    for n in names {
        let src = if *n == "gh" {
            fake_gh_bin()
        } else {
            fake_agent_bin()
        };
        let dst = dir.join(format!("{n}{}", std::env::consts::EXE_SUFFIX));
        let _ = std::fs::remove_file(&dst);
        #[cfg(unix)]
        std::os::unix::fs::symlink(&src, &dst)?;
        #[cfg(not(unix))]
        std::fs::copy(&src, &dst).map(|_| ())?;
    }
    Ok(())
}
