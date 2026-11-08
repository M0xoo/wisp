//! wisp.accounts' commands (ids as plugins/accounts/ui/src/commands.ts binds them).

use std::sync::Arc;

use serde_json::json;
use wisp_accounts_api::commands as c;
use wisp_accounts_api::{AccountsOut, AddOut};
use wisp_accounts_core::accounts::{self, Refused};
use wisp_accounts_core::watch;
use wisp_kernel::{Ctx, Setup, WireError};
use wisp_runtime_api::HARNESS;

use crate::{Slot, State, folders, harness, lock, now, run, signin, state, store};

fn refused(r: Refused) -> WireError {
    match r {
        Refused::Invalid(m) => WireError::invalid(m),
        Refused::NotFound => WireError::not_found("No such account."),
    }
}

fn many(ctx: &Ctx, agent: &str) -> Result<Arc<dyn wisp_runtime_api::Harness>, WireError> {
    let h = harness(ctx, agent).ok_or_else(|| WireError::not_found("No such harness."))?;
    if h.accounts().is_none() {
        return Err(WireError::invalid(format!("{} can’t have more than one account in wisp yet.", h.info().name)));
    }
    Ok(h)
}

/// A harness that signs in with a key, and where it keeps them.
fn keyed(ctx: &Ctx, agent: &str) -> Result<(Arc<dyn wisp_runtime_api::Harness>, wisp_runtime_api::harness::HarnessKeys), WireError> {
    let h = harness(ctx, agent).ok_or_else(|| WireError::not_found("No such harness."))?;
    let k = h.keys().cloned().ok_or_else(|| WireError::invalid(format!("{} doesn’t sign in with a key.", h.info().name)))?;
    Ok((h, k))
}

/// A usage event this plugin owns (wisp.telemetry's catalogue: v1's names and keys).
async fn track(ctx: &Ctx, event: &str, props: serde_json::Value) {
    let _ = ctx.run_json(&ctx.root_call(), "telemetry.track", json!({ "event": event, "props": props })).await;
}

fn out(ctx: &Ctx, st: &State, agent: &str) -> AccountsOut {
    let list = lock(&st.accounts).get(agent).cloned().unwrap_or_default();
    AccountsOut { accounts: accounts::view(&list, now(ctx)) }
}

async fn save(st: &State, agent: &str, list: Vec<accounts::Stored>) -> Result<(), WireError> {
    let keep = if accounts::multi(&list) { list } else { Vec::new() };
    lock(&st.accounts).insert(agent.to_owned(), keep.clone());
    let a = agent.to_owned();
    st.store.write(move |w| store::put_accounts(w, &a, &keep)).await.map_err(crate::store_err)
}

macro_rules! on {
    ($s:ident, $slot:ident, $C:ty, |$st:ident, $ctx:ident, $a:ident| $body:expr) => {{
        let slot = $slot.clone();
        $s.command::<$C, _, _>(move |$ctx, _call, $a| {
            let slot = slot.clone();
            async move {
                let $st = state(&slot)?;
                $body
            }
        });
    }};
}

#[allow(clippy::many_single_char_names)] // s, a, st: the same names in every handler
pub(crate) fn register(s: &mut Setup, slot: &Slot) {
    keyed_and_more(s, slot);
    on!(s, slot, c::List, |st, ctx, a| Ok(out(&ctx, &st, &a.agent)));
    on!(s, slot, c::Harnesses, |st, ctx, _a| {
        let mut v = Vec::new();
        for h in ctx.contributions(&HARNESS).into_iter().filter(|h| h.accounts().is_some()) {
            let agent = h.info().id.clone();
            let w = lock(&st.watch).get(&agent).cloned().unwrap_or_default();
            v.push(c::HarnessAccounts { accounts: out(&ctx, &st, &agent).accounts, watch: watch::view(&w), agent });
        }
        Ok(v)
    });
    on!(s, slot, c::Add, |st, ctx, a| {
        let h = many(&ctx, &a.agent)?;
        let list = lock(&st.accounts).get(&a.agent).cloned().unwrap_or_default();
        let next = accounts::add(&list, &a.id, &a.label, &a.kind, now(&ctx), &h.info().name).map_err(refused)?;
        let id = next.last().map(|x| x.id.clone()).unwrap_or_default();
        save(&st, &a.agent, next).await?;
        let login = signin::start(&ctx, &st, h, &id).await.unwrap_or_else(|_| signin::view(&st, &a.agent, &id));
        let list = out(&ctx, &st, &a.agent).accounts;
        track(&ctx, "account", json!({ "agent": a.agent, "step": "added", "count": list.len() })).await;
        let account = list.iter().find(|x| x.id == id).cloned().ok_or_else(|| WireError::not_found("No such account."))?;
        Ok(AddOut { account, accounts: list, login })
    });
    on!(s, slot, c::Update, |st, ctx, a| {
        many(&ctx, &a.agent)?;
        let list = lock(&st.accounts).get(&a.agent).cloned().unwrap_or_default();
        let next = accounts::update(&list, &a.account, a.label.as_deref(), a.kind.as_deref(), a.mv.as_deref()).map_err(refused)?;
        save(&st, &a.agent, next).await?;
        Ok(out(&ctx, &st, &a.agent))
    });
    on!(s, slot, c::Remove, |st, ctx, a| {
        let h = many(&ctx, &a.agent)?;
        let list = lock(&st.accounts).get(&a.agent).cloned().unwrap_or_default();
        let next = accounts::remove(&list, &a.account).map_err(refused)?;
        signin::cancel(&ctx, &st, &a.agent, &a.account).await;
        // its login goes with it
        let _ = signin::logout(&ctx, &st, h.as_ref(), &a.account).await;
        save(&st, &a.agent, next).await?;
        if let Some(spec) = h.accounts() {
            folders::remove(&st.home, &a.agent, spec, &a.account).await;
        }
        let o = out(&ctx, &st, &a.agent);
        track(&ctx, "account", json!({ "agent": a.agent, "step": "removed", "count": o.accounts.len() })).await;
        Ok(o)
    });
    on!(s, slot, c::Watch, |st, ctx, a| {
        if let Some(bin) = harness(&ctx, &a.agent).and_then(|h| h.program()) {
            run::observe(&ctx, &st, &a.agent, &bin).await;
        }
        Ok(watch::view(&lock(&st.watch).get(&a.agent).cloned().unwrap_or_default()))
    });
    on!(s, slot, c::Trust, |st, ctx, a| {
        let w = lock(&st.watch).get(&a.agent).cloned().unwrap_or_default();
        if let Some(next) = watch::trust(&w, now(&ctx)) {
            lock(&st.watch).insert(a.agent.clone(), next.clone());
            let ag = a.agent.clone();
            st.store.write(move |w| store::put_watch(w, &ag, &next)).await.map_err(crate::store_err)?;
        }
        // the turns it held run now
        let held = lock(&st.held).remove(&a.agent).unwrap_or_default();
        for (id, turn) in held {
            let _ = ctx.run_json(&ctx.root_call(), "runtime.release", json!({ "id": id, "turnId": turn, "action": "start" })).await;
        }
        Ok(watch::view(&lock(&st.watch).get(&a.agent).cloned().unwrap_or_default()))
    });
    on!(s, slot, c::SetAsk, |st, _ctx, a| {
        let v = json!({ "harnessAsk": if a.on { "on" } else { "off" } });
        *lock(&st.settings) = v.clone();
        st.store.write(move |w| store::put_meta(w, "settings", &v)).await.map_err(crate::store_err)?;
        Ok(a)
    });
    on!(s, slot, c::Login, |st, _ctx, a| Ok(signin::view(&st, &a.agent, &a.account)));
    signing_in(s, slot);
}

/// Keys, install, re-check and live limits.
#[allow(clippy::many_single_char_names)]
fn keyed_and_more(s: &mut Setup, slot: &Slot) {
    on!(s, slot, c::Keys, |_st, ctx, a| {
        let (h, k) = keyed(&ctx, &a.agent)?;
        let _ = h;
        crate::keys::view(&a.agent, &k).await
    });
    on!(s, slot, c::KeySet, |_st, ctx, a| {
        let (_, k) = keyed(&ctx, &a.agent)?;
        let v = crate::keys::set(&a.agent, &k, &a.provider, &a.key).await?;
        // its models are looked up again, and a sign-in card's turn runs again
        let _ = ctx.run_json(&ctx.root_call(), "runtime.signInDone", json!({ "agent": a.agent, "account": "" })).await;
        Ok(v)
    });
    on!(s, slot, c::KeyRemove, |_st, ctx, a| {
        let (_, k) = keyed(&ctx, &a.agent)?;
        crate::keys::remove(&a.agent, &k, &a.provider).await
    });
    on!(s, slot, c::KeyTest, |st, ctx, a| {
        let (h, k) = keyed(&ctx, &a.agent)?;
        let set = crate::keys::view(&a.agent, &k).await?.providers.iter().any(|p| p.id == a.provider && p.set);
        if !set {
            return Ok(c::KeyTested { ok: false, message: "No key saved for it.".into() });
        }
        // one model list on that provider: it answers with its models only when it took the key
        let bin = h.program().unwrap_or_else(|| a.agent.clone());
        let r = st.proc.exec(&bin, &["models".to_owned(), a.provider.clone()], wisp_proc::ExecOpts { timeout: Some(std::time::Duration::from_secs(20)), ..wisp_proc::ExecOpts::default() }).await;
        Ok(match r {
            Ok(r) if r.exit.code == Some(0) && !r.stdout_text().trim().is_empty() => c::KeyTested { ok: true, message: "The provider took the key.".into() },
            Ok(r) => c::KeyTested { ok: false, message: wisp_accounts_core::login::last_line(&format!("{}{}", r.stdout_text(), r.stderr_text())).unwrap_or_else(|| "The provider didn’t take the key.".into()) },
            Err(e) => c::KeyTested { ok: false, message: e.to_string() },
        })
    });
    on!(s, slot, c::Install, |st, ctx, a| {
        let h = harness(&ctx, &a.agent).ok_or_else(|| WireError::not_found("No such harness."))?;
        let pkg = h.npm_package().ok_or_else(|| WireError::invalid(format!("wisp can’t install {}. Install it yourself, then re-check.", h.info().name)))?;
        let dir = st.home.join("tools");
        tokio::fs::create_dir_all(&dir).await.map_err(|e| WireError::invalid(e.to_string()))?;
        let npm = std::env::var("WISP_NPM").ok().filter(|n| !n.is_empty()).unwrap_or_else(|| "npm".into());
        let args: Vec<String> = ["install", "--prefix", &dir.to_string_lossy(), "--no-audit", "--no-fund", "--loglevel=error", &format!("{pkg}@latest")].map(str::to_owned).to_vec();
        let r = st.proc.exec(&npm, &args, wisp_proc::ExecOpts { env: wisp_proc::Env { remove: vec!["ELECTRON_RUN_AS_NODE".into()], ..wisp_proc::Env::default() }, timeout: Some(std::time::Duration::from_secs(300)), ..wisp_proc::ExecOpts::default() }).await;
        match r {
            Ok(r) if r.exit.code == Some(0) => {}
            Ok(r) => {
                let tail = format!("{}{}", r.stdout_text(), r.stderr_text()).trim().lines().filter(|l| !l.is_empty()).rev().take(3).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join(" ");
                return Err(WireError::invalid(format!("npm install {pkg} {}{}", if r.timed_out { "timed out" } else { "failed" }, if tail.is_empty() { String::new() } else { format!(": {tail}") })));
            }
            Err(_) => return Err(WireError::invalid("npm isn’t on PATH, so wisp can’t install it. Install Node.js (it comes with npm), then try again.")),
        }
        let agents = ctx.run_json(&ctx.root_call(), "runtime.agents", json!({ "fresh": "all" })).await?;
        let ok = agents.as_array().and_then(|l| l.iter().find(|x| x["id"] == a.agent.as_str())).is_some_and(|x| x["available"] == true);
        track(&ctx, "harness_install", json!({ "agent": a.agent, "ok": ok })).await;
        if !ok {
            return Err(WireError::internal(format!("{} was installed but doesn’t start.", h.info().name)));
        }
        Ok(agents)
    });
    on!(s, slot, c::Recheck, |_st, ctx, _a| ctx.run_json(&ctx.root_call(), "runtime.agents", json!({ "fresh": "all" })).await);
    on!(s, slot, c::Limits, |st, ctx, a| {
        let h = harness(&ctx, &a.agent).ok_or_else(|| WireError::not_found("No such harness."))?;
        let mut env = std::collections::BTreeMap::new();
        if let Some(spec) = h.accounts() {
            let id = wisp_accounts_core::login::account_key(&a.account);
            if !id.is_empty() {
                let dir = folders::prepare(&st.home, &a.agent, spec, id).await.map_err(|e| WireError::invalid(e.to_string()))?;
                env.insert(spec.env.clone(), dir.to_string_lossy().into_owned());
            }
        }
        Ok(h.live_limits(&crate::sys::Sys(st.proc.clone()), &env).await.unwrap_or(serde_json::Value::Null))
    });
}

/// The CLI's own sign-in and sign-out.
#[allow(clippy::many_single_char_names)]
fn signing_in(s: &mut Setup, slot: &Slot) {
    on!(s, slot, c::LoginStart, |st, ctx, a| {
        let h = harness(&ctx, &a.agent).ok_or_else(|| WireError::not_found("No such harness."))?;
        signin::start(&ctx, &st, h, &a.account).await
    });
    on!(s, slot, c::LoginInput, |st, _ctx, a| signin::input(&st, &a.agent, &a.account, &a.code).await);
    on!(s, slot, c::LoginCancel, |st, ctx, a| Ok(signin::cancel(&ctx, &st, &a.agent, &a.account).await));
    on!(s, slot, c::Status, |st, ctx, a| {
        let h = harness(&ctx, &a.agent).ok_or_else(|| WireError::not_found("No such harness."))?;
        signin::status(&ctx, &st, h.as_ref(), &a.account).await
    });
    on!(s, slot, c::Logout, |st, ctx, a| {
        let h = harness(&ctx, &a.agent).ok_or_else(|| WireError::not_found("No such harness."))?;
        signin::logout(&ctx, &st, h.as_ref(), &a.account).await
    });
}
