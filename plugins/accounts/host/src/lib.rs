//! wisp.accounts: several accounts per harness, signing in from wisp, the harness watch.
//!
//! - accounts (v1 accounts.js): a harness whose `Harness::accounts()` names the folder its CLI keeps
//!   its login in can have up to 8; each extra one is a folder under `~/.wisp/accounts/<agent>/<id>`
//!   linked to everything in the CLI's own folder except the login. `before:run` picks the account a
//!   run gets and hands its folder in the env (`account_env`).
//! - the harness watch (v1 harness-watch.js): `before:run` pins the program a harness runs
//!   (`Harness::program()`) and, with Ask before running a changed harness on, holds the turn until
//!   `accounts.watch.trust` (which starts the held turns).
//! - signing in (v1 agent-login.js): the CLI's own login (`Harness::login()`), run through the proc
//!   service; its link, code and paste box as `accounts_login` rows.
//!
//! Rows live in the store (store.rs); clients watch `plugin:wisp.accounts:harnesses`.

mod kinds;
mod folders;
mod keys;
mod ops;
mod run;
mod signin;
mod store;
mod sys;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

use serde_json::Value;
use wisp_accounts_core::accounts::Stored;
use wisp_accounts_core::watch::Watched;
use wisp_kernel::services::Paths;
use wisp_kernel::{Ctx, Failure, InterceptOpts, Manifest, Plugin, Result, Setup, WireError};
use wisp_proc::Proc;
use wisp_runtime_api::hooks::BeforeRun;
use wisp_runtime_api::{HARNESS, Harness};
use wisp_store::Store;

/// What the handlers share, built once the store is there.
pub(crate) struct State {
    pub store: Store,
    pub proc: Proc,
    /// wisp's home (`~/.wisp`): extra accounts' folders live under it
    pub home: std::path::PathBuf,
    pub accounts: Mutex<HashMap<String, Vec<Stored>>>,
    pub watch: Mutex<HashMap<String, Watched>>,
    pub settings: Mutex<Value>,
    /// turns the watch holds, per harness: (task, turn)
    pub held: Mutex<HashMap<String, Vec<(String, String)>>>,
    /// a hash per (real path, size, mtime), so a program that didn't move is hashed once
    pub hashes: Mutex<HashMap<String, (u64, f64, String)>>,
    pub flows: signin::Flows,
}

pub(crate) fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

pub(crate) type Slot = Arc<OnceLock<Arc<State>>>;

pub(crate) fn state(slot: &Slot) -> Result<Arc<State>> {
    slot.get().cloned().ok_or_else(|| WireError::unavailable("wisp.accounts is starting"))
}

pub(crate) fn harness(ctx: &Ctx, agent: &str) -> Option<Arc<dyn Harness>> {
    ctx.contributions(&HARNESS).into_iter().find(|h| h.info().id == agent)
}

pub(crate) fn now(ctx: &Ctx) -> i64 {
    ctx.clock().map_or(0, |c| c.now_ms())
}

pub(crate) fn store_err(e: wisp_store::StoreError) -> WireError {
    WireError::from(e)
}

impl State {
    pub fn ask(&self) -> bool {
        lock(&self.settings).get("harnessAsk").and_then(Value::as_str) == Some("on")
    }
}

#[derive(Debug, Default)]
pub struct AccountsPlugin;

impl Plugin for AccountsPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        crate::kinds::register(s);
        let slot: Slot = Arc::new(OnceLock::new());
        ops::register(s, &slot);
        let hook = slot.clone();
        // before trust (50) and the budget guard: the account and the watch decide first
        s.intercept::<BeforeRun, _, _>(InterceptOpts { priority: 20, failure: Failure::Open, timeout_ms: 2000 }, move |ctx, call, c| {
            let slot = hook.clone();
            async move {
                let Ok(st) = state(&slot) else { return wisp_kernel::Verdict::Continue };
                run::before_run(&ctx, &call, &st, c).await
            }
        });
        let start = slot;
        s.on_start(move |ctx| async move {
            let store = ctx.service::<Store>()?.as_ref().clone();
            let proc = ctx.service::<Proc>()?.as_ref().clone();
            let home = ctx.service::<Paths>().ok().map(|p| p.home().to_owned());
            store::install(&store).map_err(store_err)?;
            if let Some(h) = &home {
                store::import_v1(&store, h).await.map_err(store_err)?;
            }
            let (accounts, watch, settings) = store::load(&store).await.map_err(store_err)?;
            let st = State {
                store,
                proc,
                home: home.unwrap_or_else(std::env::temp_dir),
                accounts: Mutex::new(accounts.into_iter().collect()),
                watch: Mutex::new(watch.into_iter().collect()),
                settings: Mutex::new(settings),
                held: Mutex::new(HashMap::new()),
                hashes: Mutex::new(HashMap::new()),
                flows: signin::Flows::default(),
            };
            let _ = start.set(Arc::new(st));
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(AccountsPlugin.manifest().id, "wisp.accounts");
    }
}
