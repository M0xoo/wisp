//! Plan budget past the windows (v1 budget.js `where`, `compareAccounts`): the tasks' names on *Where the … window
//! went* (a subagent's share goes on its lead, a task since deleted counts as untraced, as v1's did), and every
//! finished turn's tokens for tokens per turn by account.

use wisp_budget_api::{AccountView, WhereView};
use wisp_kernel::Ctx;
use wisp_runtime_api::commands::{Get, IdArgs};
use wisp_runtime_api::events::TurnEnded;
use wisp_runtime_api::model::TurnStatus;

use crate::{State, account_of, lock, now};

/// The tasks a *Where it went* names (v1 `limit = 3`).
const SHOWN: usize = 3;
/// Tasks looked up by name, most first: the rest are counted in "N other tasks".
const NAMED: usize = 12;

/// A finished turn on its account: its tokens join the account's last 7 days.
pub(crate) fn note_turn(ctx: &Ctx, st: &State, e: &TurnEnded) {
    if e.status != TurnStatus::Done || e.agent.is_empty() {
        return;
    }
    let sample = wisp_budget_core::traced::TurnSample {
        at: now(ctx),
        model: e.model.clone(),
        // everything it read (the cache's reads and writes in), and of that what came from the cache
        input: e.input_tokens.unwrap_or(0) + e.cache_tokens.unwrap_or(0),
        output: e.output_tokens.unwrap_or(0),
        cache: e.cache_read_tokens.or(e.cache_tokens),
    };
    if sample.output == 0 {
        return;
    }
    // written with the drain sample this same turn end saves (`State::ended`): one write, not two
    lock(&st.budget).note_turn(&e.agent, &account_of(e.account.as_deref().unwrap_or_default()), sample, now(ctx));
}

async fn session(ctx: &Ctx, id: &str) -> Option<wisp_runtime_api::model::Session> {
    ctx.run::<Get>(&ctx.root_call(), IdArgs { id: id.into() }).await.ok()
}

/// Names the tasks, folds a subagent's share onto its lead, and keeps the top ones. A task since deleted counts as
/// untraced (v1 traced only the tasks it still had); at most `NAMED` are looked up, the rest are "N other tasks".
async fn name(ctx: &Ctx, mut w: WhereView) -> Option<WhereView> {
    let all = std::mem::take(&mut w.tasks);
    let mut named: Vec<wisp_budget_api::TaskUse> = Vec::new();
    let (mut gone, mut looked) = (0.0, 0);
    for t in &all {
        if named.len() >= NAMED {
            break;
        }
        looked += 1;
        let Some(s) = session(ctx, &t.id).await else {
            gone += t.used;
            continue;
        };
        let lead = match s.parent_id.as_ref() {
            Some(p) => session(ctx, p.as_str()).await,
            None => None,
        };
        let (id, title) = lead.map_or_else(|| (s.id.0.clone(), s.title.clone()), |l| (l.id.0.clone(), l.title.clone()));
        let title = if title.is_empty() { "Untitled".to_owned() } else { title };
        match named.iter_mut().find(|x| x.id == id) {
            Some(x) => x.used += t.used,
            None => named.push(wisp_budget_api::TaskUse { id, title, used: t.used }),
        }
    }
    if named.is_empty() {
        return None;
    }
    w.traced = (w.traced - gone).max(0.0);
    w.tasks = named;
    let mut out = wisp_budget_core::traced::top(w, SHOWN);
    // the other tasks' share stays in `traced`: "N other tasks" is traced minus the shown
    out.more += u32::try_from(all.len() - looked).unwrap_or(u32::MAX);
    Some(out)
}

/// Every account's *Where it went*, named.
pub(crate) async fn named(ctx: &Ctx, views: &mut [AccountView]) {
    for v in views.iter_mut() {
        if let Some(w) = v.where_went.take() {
            v.where_went = name(ctx, w).await;
        }
    }
}
