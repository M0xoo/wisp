//! What Plan budget keeps past the windows, per account (v1 budget.js `whereItWent`, `compareAccounts`), so a
//! restart loses neither: each window's traced shares by task this period, and the last 7 days of finished turns'
//! tokens by model. Pure; the host adds task titles.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use wisp_budget_api::{AccountTurns, COMPARE_DAYS, COMPARE_MIN, ModelCompare, WhereView, WindowView};

use crate::model::Budget;
use crate::receipt::StatsLike;
use crate::state::Acc;
use crate::windows::same_period;
use crate::work::{RunLike, TurnLike};

const DAY: i64 = 24 * 3600 * 1000;
/// Tasks kept per window period: the smallest go first.
const MAX_TASKS: usize = 200;
/// Turns kept per account and model: the newest, enough for a steady median, few enough that the account's row (written
/// on every turn end) stays small.
const MAX_TURNS: usize = 40;

/// One window's period and each task's part of it so far.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Traced {
    pub resets_at: Option<i64>,
    pub tasks: BTreeMap<String, f64>,
}

/// A finished turn's tokens on one account, for tokens per turn by account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSample {
    pub at: i64,
    /// '' : the harness's default
    pub model: String,
    /// everything the turn read, the cache's reads and writes in
    pub input: u64,
    pub output: u64,
    /// of `input`, what came from the cache
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<u64>,
}

/// A task's part of a window's move, added to this period's (a new period starts the list again).
pub fn trace(acc: &mut Acc, window: &str, resets_at: Option<i64>, sid: &str, used: f64) {
    // a window with no reset time has no period to keep (`same_period(None, None)` is false: it would start over
    // on every share), and `where_of` never shows one
    if sid.is_empty() || resets_at.is_none() || !used.is_finite() || used <= 0.0 {
        return;
    }
    let t = acc.traced.entry(window.to_owned()).or_default();
    if !same_period(t.resets_at, resets_at) {
        t.tasks.clear();
    }
    t.resets_at = resets_at;
    let e = t.tasks.entry(sid.to_owned()).or_insert(0.0);
    *e = (*e + used).min(1.0);
    while t.tasks.len() > MAX_TASKS {
        let Some(k) = t.tasks.iter().min_by(|a, b| a.1.total_cmp(b.1)).map(|(k, _)| k.clone()) else { break };
        t.tasks.remove(&k);
    }
}

/// Where the account's longest window went this period: every traced task, most first, titles left to the host.
/// None when the window is fresh or nothing of this period was traced.
pub fn where_of(acc: &Acc, windows: &[WindowView], now: i64) -> Option<WhereView> {
    let w = windows.iter().filter(|w| w.resets_at.is_some_and(|r| r > now)).max_by_key(|w| w.ms.unwrap_or(0))?;
    let t = acc.traced.get(&w.id).filter(|t| same_period(t.resets_at, w.resets_at))?;
    let mut tasks: Vec<wisp_budget_api::TaskUse> =
        t.tasks.iter().map(|(id, used)| wisp_budget_api::TaskUse { id: id.clone(), title: String::new(), used: *used }).collect();
    if tasks.is_empty() {
        return None;
    }
    tasks.sort_by(|a, b| b.used.total_cmp(&a.used).then_with(|| a.id.cmp(&b.id)));
    let traced = tasks.iter().map(|x| x.used).sum::<f64>().min(1.0);
    Some(WhereView { window: w.id.clone(), label: w.label.clone(), used: w.used, traced, tasks, more: 0 })
}

/// The top `limit` once the host has named and folded them; the rest are counted in `more`.
pub fn top(mut v: WhereView, limit: usize) -> WhereView {
    v.tasks.sort_by(|a, b| b.used.total_cmp(&a.used).then_with(|| a.id.cmp(&b.id)));
    let more = v.tasks.len().saturating_sub(limit);
    v.tasks.truncate(limit);
    v.more = u32::try_from(more).unwrap_or(u32::MAX);
    v
}

impl Budget {
    /// A finished turn on `account` (only finished ones with output count, as v1's `status === 'done'`).
    pub fn note_turn(&mut self, agent: &str, account: &str, sample: TurnSample, now: i64) {
        if agent.is_empty() || sample.output == 0 {
            return;
        }
        let acc = self.ensure(agent, account);
        acc.turns.retain(|t| t.at >= now - COMPARE_DAYS * DAY);
        if let Some(i) = (acc.turns.iter().filter(|t| t.model == sample.model).count() >= MAX_TURNS)
            .then(|| acc.turns.iter().position(|t| t.model == sample.model))
            .flatten()
        {
            acc.turns.remove(i);
        }
        acc.turns.push(sample);
    }

    /// Tokens per turn by account (v1 `compareAccounts`, [`crate::accounts::compare_accounts`] over the turns kept here):
    /// per model, each account's median finished turn over the last 7 days once it has [`COMPARE_MIN`] of them, only
    /// where two or more accounts do. Models in name order.
    #[allow(clippy::cast_precision_loss)]
    pub fn compare_accounts(&self, agent: &str, now: i64) -> Vec<ModelCompare> {
        let turns = self
            .of(agent)
            .flat_map(|(account, acc)| {
                acc.turns.iter().map(move |t| TurnLike {
                    agent: Some(agent.to_owned()),
                    account: Some(account.to_owned()),
                    model: Some(t.model.clone()),
                    status: Some("done".into()),
                    started_at: Some(t.at),
                    // `input` already holds the cache, as OpenAI counts it: read = input, cached = of it from the cache
                    stats: Some(StatsLike {
                        input_tokens: Some(t.input as f64),
                        output_tokens: Some(t.output as f64),
                        cached_input_tokens: t.cache.map(|c| c as f64),
                        ..StatsLike::default()
                    }),
                    ..TurnLike::default()
                })
            })
            .collect();
        let runs = [RunLike { agent: Some(agent.to_owned()), turns, ..RunLike::default() }];
        crate::accounts::compare_accounts(&runs, agent, now, Some(COMPARE_DAYS), Some(COMPARE_MIN))
            .into_iter()
            .map(|c| ModelCompare {
                model: c.model,
                accounts: c
                    .accounts
                    .into_iter()
                    .map(|a| AccountTurns {
                        account: a.account,
                        turns: u32::try_from(a.turns).unwrap_or(u32::MAX),
                        output: u64::try_from(a.output).unwrap_or(0),
                        input: u64::try_from(a.input).unwrap_or(0),
                        cache: a.cache,
                    })
                    .collect(),
            })
            .collect()
    }
}
