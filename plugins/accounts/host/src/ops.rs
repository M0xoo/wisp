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

pub(crate) fn register(s: &mut Setup, slot: &Slot) {
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
        Ok(out(&ctx, &st, &a.agent))
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
