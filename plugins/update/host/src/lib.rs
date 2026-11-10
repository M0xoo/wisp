//! wisp.update (v1 server/update.js): is there a newer wisp, and install it. The decisions are
//! `wisp_update_core::updater::Updater`'s (sans-IO); this runs them:
//!
//! - **check:** five seconds after start, then whenever a day has passed (checked every 30 minutes, so a computer
//!   that slept checks when it wakes), and on `update.check`. The npm registry's dist-tags (or GitHub Releases for
//!   the desktop app) through the net service; offline is "next round", never an error.
//! - **install** (`update.install`): npm (`npm install -g wisp-agents@<tag>`) or Homebrew, run through the proc
//!   service; then the updated copy's `package.json` must say a newer version, or it says what went wrong. npx has
//!   nothing to install.
//! - **state:** one row (`update.state`, id `update`) on topic `plugin:wisp.update:state`: `Updater::view` plus
//!   `checked_at`, `checking` and `running` (tasks an install stops), which Settings → Updates reads.
//!
//! resources: data-only (its row is what the last check found; the channel is a setting, `update.updateChannel`).

use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::{Command, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_store::{Col, EntityDef, Migration, Row, Store};
use wisp_update_core::install::{self, Platform};
use wisp_update_core::updater::{self as up, InstallStep, Refusal, Updater};

pub const OWNER: &str = "update";
pub const CHANNEL: &str = "update.updateChannel";
const ROW: &str = "update";

const MIGRATIONS: &[Migration] = &[Migration::sql(1, "CREATE TABLE update_state (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT;")];

fn topics(_: &Row) -> Vec<String> {
    vec!["plugin:wisp.update:state".into()]
}

const STATE: EntityDef = EntityDef { kind: "update.state", table: "update_state", key: "id", columns: &[("id", Col::Text), ("body", Col::Text)], json_columns: &["body"], parent: None, seq: None, topics };

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PeerArgs {
    #[serde(default)]
    pub peer: Option<String>,
}

macro_rules! command {
    ($name:ident = $id:literal, $ro:expr) => {
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            const PERMISSION: Option<&'static str> = Some(if $ro { "update:read" } else { "update:install" });
            const READ_ONLY: bool = $ro;
            type Args = PeerArgs;
            type Out = Value;
        }
    };
}

command!(Check = "update.check", false);
command!(Install = "update.install", false);
command!(View = "update.view", true);

struct St {
    up: Mutex<Updater>,
    checked_at: Mutex<Option<i64>>,
    checking: Mutex<bool>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

impl St {
    fn new() -> Self {
        let platform = Platform::from_rust(std::env::consts::OS, std::env::consts::ARCH);
        let exe = std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
        let env = up::Env { update_check: std::env::var("WISP_UPDATE_CHECK").ok(), ci: std::env::var("CI").ok(), desktop: std::env::var("WISP_DESKTOP").ok(), appimage: std::env::var("APPIMAGE").ok(), node: std::env::var("WISP_NODE").ok(), ppid: 0 };
        // a build in a clone: its target/ in the clone, or (a shared CARGO_TARGET_DIR) a debug build of one
        let clone = install::cargo_clone(&exe).or_else(|| cfg!(debug_assertions).then(|| std::path::Path::new(env!("CARGO_MANIFEST_DIR")).ancestors().find(|d| d.join(".git").exists()).map(|d| d.to_string_lossy().into_owned())).flatten());
        let inst = install::detect(&exe, &platform, env.appimage.as_deref(), env.desktop.as_deref() == Some("tauri"), clone.as_deref());
        let port = std::env::var("WISP_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(4477);
        Self { up: Mutex::new(Updater::new(inst, platform, env!("CARGO_PKG_VERSION"), port, env)), checked_at: Mutex::new(None), checking: Mutex::new(false) }
    }
}

fn pref(ctx: &Ctx) -> String {
    ctx.setting(CHANNEL).and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| "stable".into())
}

/// The row Settings → Updates reads.
async fn row(ctx: &Ctx, st: &St) -> Value {
    let mut v = serde_json::to_value(lock(&st.up).view(&pref(ctx))).unwrap_or_default();
    v["checked_at"] = json!(*lock(&st.checked_at));
    v["checking"] = json!(*lock(&st.checking));
    let list = ctx.run_json(&ctx.root_call(), "runtime.list", json!({})).await.unwrap_or_default();
    let running = list.as_array().into_iter().flatten().filter(|s| matches!(s.get("state").and_then(Value::as_str), Some("running" | "queued"))).count();
    v["running"] = json!(running);
    v
}

async fn publish(ctx: &Ctx, st: &St) -> Value {
    let v = row(ctx, st).await;
    if let Ok(store) = ctx.service::<Store>() {
        let body = v.clone();
        let _ = store
            .write(move |w| {
                let mut r = Row::new();
                r.insert("id".into(), json!(ROW));
                r.insert("body".into(), body);
                w.upsert(STATE.kind, r).map(|_| ())
            })
            .await;
    }
    v
}

async fn check(ctx: &Ctx, st: &St) -> Value {
    let now = ctx.clock().map_or(0, |c| c.now_ms());
    let p = pref(ctx);
    let req = {
        let mut u = lock(&st.up);
        u.enabled.then(|| u.begin_check(now, &p))
    };
    let Some(req) = req else { return publish(ctx, st).await };
    *lock(&st.checking) = true;
    publish(ctx, st).await;
    let body = match wisp_kernel::services::net(ctx) {
        Ok(net) => net
            .fetch(wisp_kernel::services::NetRequest { method: "GET".into(), url: req.url.clone(), headers: vec![("accept".into(), req.accept.into()), ("user-agent".into(), "wisp".into())], body: Vec::new(), timeout_ms: up::CHECK_TIMEOUT_MS })
            .await
            .ok()
            .filter(|r| (200..300).contains(&r.status))
            .and_then(|r| serde_json::from_slice::<Value>(&r.body).ok()),
        Err(_) => None,
    };
    lock(&st.up).end_check(&req, body.as_ref());
    *lock(&st.checking) = false;
    *lock(&st.checked_at) = Some(now);
    publish(ctx, st).await
}

/// `sh -c` (or `cmd /C`) through the proc service.
async fn shell(ctx: &Ctx, cmd: &str, env: &[(String, String)]) -> std::result::Result<(), String> {
    let proc = ctx.service::<wisp_proc::Proc>().map_err(|e| e.message)?;
    let (bin, args) = if cfg!(windows) { ("cmd", vec!["/C".to_owned(), cmd.to_owned()]) } else { ("sh", vec!["-c".to_owned(), cmd.to_owned()]) };
    let mut e = wisp_proc::Env::default();
    for (k, v) in env {
        e.set.push((k.clone(), v.clone()));
    }
    let r = proc.exec(bin, &args, wisp_proc::ExecOpts { env: e, timeout: Some(Duration::from_secs(600)), ..wisp_proc::ExecOpts::default() }).await.map_err(|e| up::run_failed(cmd, &e.to_string()))?;
    if r.timed_out {
        return Err(up::run_failed(cmd, "it didn't finish in 10 minutes"));
    }
    if !r.exit.success() {
        return Err(up::run_failed(cmd, &r.stderr_text()));
    }
    Ok(())
}

/// Hands off to the detached waiter that stops this wisp and starts the new one (`Updater::hand_off`), through
/// the proc service. False: it can't here (Windows, the desktop app's own swap), and the user restarts it.
fn relaunch(ctx: &Ctx, st: &St) -> bool {
    let Some(args) = lock(&st.up).hand_off(std::process::id()) else { return false };
    let Ok(proc) = ctx.service::<wisp_proc::Proc>() else { return false };
    // Err: the user restarts it by hand, as `next` says
    proc.spawn_detached("sh", &args, wisp_proc::SpawnOpts { no_stdin: true, ..wisp_proc::SpawnOpts::default() }).is_ok()
}

async fn install(ctx: &Ctx, st: &St) -> Result<Value> {
    let step = lock(&st.up).begin_install().map_err(|r| match r {
        Refusal::Invalid(m) => WireError::invalid(m),
        Refusal::Conflict(m) => WireError::conflict(m),
    })?;
    publish(ctx, st).await;
    let done = match step {
        InstallStep::Nothing => Ok(()),
        InstallStep::Run { cmd, env } => match shell(ctx, &cmd, &env).await {
            Ok(()) => {
                let home = lock(&st.up).home();
                let pkg = std::path::Path::new(&home).join("package.json");
                let got = tokio::fs::read_to_string(&pkg).await.ok().and_then(|t| install::installed_version(&t));
                lock(&st.up).check_installed(got.as_deref())
            }
            Err(e) => Err(e),
        },
        // the desktop app's download and swap need the app's own relaunch (apps/desktop)
        InstallStep::DownloadApp { .. } => Err(format!("The desktop app updates itself when it restarts. {}", lock(&st.up).later())),
    };
    let ok = done.is_ok();
    match done {
        Ok(()) => lock(&st.up).install_done(),
        Err(m) => lock(&st.up).install_failed(&m),
    }
    if ok {
        let (from, to, method) = { let u = lock(&st.up); (u.current.clone(), u.latest.clone(), u.method().name()) };
        let c = ctx.clone();
        ctx.spawn(async move {
            let _ = c.run_json(&c.root_call(), "telemetry.track", json!({ "event": "update", "props": { "from": from, "to": to, "method": method } })).await;
        });
    }
    let mut v = publish(ctx, st).await;
    if v["status"] == "restarting" {
        let latest = v["latest"].as_str().unwrap_or("the new version").to_owned();
        v["next"] = json!(if relaunch(ctx, st) { format!("wisp restarts on {latest} now.") } else { format!("Restart wisp to use {latest} (quit it and run `wisp` again).") });
    }
    Ok(v)
}

#[derive(Debug, Default)]
pub struct UpdatePlugin;

impl Plugin for UpdatePlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let st = Arc::new(St::new());
        let a = st.clone();
        s.command::<Check, _, _>(move |ctx, _, _| {
            let st = a.clone();
            async move { Ok(check(&ctx, &st).await) }
        });
        let b = st.clone();
        s.command::<Install, _, _>(move |ctx, _, _| {
            let st = b.clone();
            async move { install(&ctx, &st).await }
        });
        let c = st.clone();
        s.command::<View, _, _>(move |ctx, _, _| {
            let st = c.clone();
            async move { Ok(row(&ctx, &st).await) }
        });
        s.on_start(move |ctx| async move {
            let store = ctx.service::<Store>()?;
            store.migrate(OWNER, MIGRATIONS).map_err(|e| WireError::internal(e.to_string()))?;
            store.define_entity(STATE).map_err(|e| WireError::internal(e.to_string()))?;
            let clock = ctx.clock()?;
            let c2 = ctx.clone();
            ctx.spawn(async move {
                clock.sleep(up::FIRST_CHECK_MS).await;
                loop {
                    if lock(&st.up).due(clock.now_ms()) {
                        check(&c2, &st).await;
                    }
                    clock.sleep(up::TICK_MS).await;
                }
            });
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        if let Err(e) = Manifest::parse(include_str!("../wisp-plugin.json")) {
            panic!("{}", e.message);
        }
        assert_eq!(UpdatePlugin.manifest().id, "wisp.update");
    }

    #[test]
    fn a_build_of_this_clone_never_offers_an_update() {
        // the test binary is a cargo build in this clone: a git copy, which never updates itself
        let st = St::new();
        let v = lock(&st.up).view("stable");
        assert_eq!((v.method, v.enabled, v.command), ("git", false, None));
        assert!(lock(&st.up).begin_install().is_err());
    }
}
