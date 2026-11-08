//! Tokens per turn by account (v1 budget.js:754-817): for each model a harness ran on two or more
//! accounts over the last 7 days, each account's median turn. Only what the CLI reported per turn, so
//! it shows when the same work costs one login more than another. A diagnostic: nothing here picks
//! an account. And `tool_set`, the hash the comparison uses to say an account's tools differ.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::receipt::{COMPARE_DAYS, COMPARE_MIN, js_round, median, turn_tokens};
use crate::work::{RunLike, ToolSet};

/// SHA-1 of `bytes`, as hex. v1 hashed tool lists with node:crypto SHA-1; stored hashes must match.
#[allow(clippy::many_single_char_names)] // FIPS 180-4's own names (a..e, h, w)
pub fn sha1_hex(bytes: &[u8]) -> String {
    let mut h: [u32; 5] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476, 0xc3d2_e1f0];
    let mut msg = bytes.to_vec();
    let bits = (bytes.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bits.to_be_bytes());
    for chunk in msg.chunks(64) {
        let mut w = [0u32; 80];
        for (i, word) in chunk.chunks(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for t in 16..80 {
            w[t] = (w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16]).rotate_left(1);
        }
        let [mut a, mut b, mut c, mut d, mut e] = h;
        for (t, wt) in w.iter().enumerate() {
            let (f, k) = match t {
                0..20 => ((b & c) | (!b & d), 0x5a82_7999),
                20..40 => (b ^ c ^ d, 0x6ed9_eba1),
                40..60 => ((b & c) | (b & d) | (c & d), 0x8f1b_bcdc),
                _ => (b ^ c ^ d, 0xca62_c1d6),
            };
            let next = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(*wt);
            (e, d, c, b, a) = (d, c, b.rotate_left(30), a, next);
        }
        for (x, y) in h.iter_mut().zip([a, b, c, d, e]) {
            *x = x.wrapping_add(y);
        }
    }
    h.iter().fold(String::with_capacity(40), |mut s, x| {
        use std::fmt::Write as _;
        let _ = write!(s, "{x:08x}");
        s
    })
}

/// A run's tool list (Claude Code's system/init tools) as `turn.details.tools`. wisp's own MCP tools
/// are left out (they change with the task), so the hash only moves when the account's own tools do.
/// `seen` (hashes earlier turns of this task stored the list under) drops the list from repeats.
pub fn tool_set(list: &[String], seen: &[String]) -> ToolSet {
    let mut names: Vec<String> = list.iter().filter(|n| !n.is_empty() && !n.starts_with("mcp__wisp__")).cloned().collect();
    names.sort();
    names.dedup();
    let hash = sha1_hex(names.join("\n").as_bytes())[..12].to_owned();
    let list = (!seen.contains(&hash)).then_some(names);
    ToolSet { hash: Some(hash), list }
}

/// One account's median turn on a model.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountTurns {
    pub account: String,
    pub turns: usize,
    pub output: i64,
    pub input: i64,
    pub cache: Option<f64>,
    /// tools another account in the row had on its latest turn and this one didn't
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ModelCompare {
    pub model: String,
    pub accounts: Vec<AccountTurns>,
}

#[derive(Default)]
struct Acc {
    out: Vec<f64>,
    read: Vec<f64>,
    cached: f64,
    read_sum: f64,
    tools: Option<String>,
    tools_at: Option<i64>,
}

/// Per model, each account's median turn, only for models with `min` finished turns on two or more
/// accounts; most output first; models by name.
pub fn compare_accounts(sessions: &[RunLike], agent: &str, now: i64, days: Option<i64>, min: Option<usize>) -> Vec<ModelCompare> {
    let since = now - days.unwrap_or(COMPARE_DAYS) * 86_400_000;
    let min = min.unwrap_or(COMPARE_MIN);
    let mut by: BTreeMap<String, Vec<(String, Acc)>> = BTreeMap::new();
    let mut lists: BTreeMap<String, Vec<String>> = BTreeMap::new(); // hash → list, from whichever turn stored it
    for s in sessions {
        for t in &s.turns {
            let ts = t.details.as_ref().and_then(|d| d.tools.as_ref());
            if let Some(ToolSet { hash: Some(h), list: Some(l) }) = ts {
                lists.insert(h.clone(), l.clone());
            }
            let ta = t.agent.as_deref().filter(|a| !a.is_empty()).or(s.agent.as_deref()).unwrap_or_default();
            let Some(started) = t.started_at.filter(|at| *at >= since && *at <= now) else { continue };
            if ta != agent || t.status() != "done" {
                continue;
            }
            let k = turn_tokens(&t.stats());
            if k.output == 0.0 {
                continue;
            }
            let m = by.entry(t.model.clone().unwrap_or_default()).or_default();
            let account = t.account.clone().filter(|a| !a.is_empty()).unwrap_or_else(|| "default".to_owned());
            let i = m.iter().position(|(a, _)| *a == account).unwrap_or_else(|| {
                m.push((account, Acc::default()));
                m.len() - 1
            });
            let e = &mut m[i].1;
            // The account's tools as of its latest turn that reported them.
            if let Some(h) = ts.and_then(|x| x.hash.clone())
                && e.tools_at.is_none_or(|at| started >= at)
            {
                e.tools = Some(h);
                e.tools_at = Some(started);
            }
            e.out.push(k.output);
            e.read.push(k.read);
            e.cached += k.cached;
            e.read_sum += k.read;
        }
    }
    let mut out = Vec::new();
    for (model, m) in by {
        let mut rows: Vec<(AccountTurns, Option<Vec<String>>)> = m
            .into_iter()
            .filter(|(_, e)| e.out.len() >= min)
            .map(|(account, e)| {
                let cache = (e.read_sum != 0.0 && e.cached != 0.0).then(|| e.cached / e.read_sum);
                let tools = e.tools.as_ref().and_then(|h| lists.get(h)).cloned();
                (AccountTurns { account, turns: e.out.len(), output: js_round(median(&e.out)), input: js_round(median(&e.read)), cache, missing: Vec::new() }, tools)
            })
            .collect();
        rows.sort_by_key(|r| std::cmp::Reverse(r.0.output));
        if rows.len() < 2 {
            continue;
        }
        // Tools another account had that this one didn't: a reason its turns differ. Only between
        // accounts that both reported a list.
        let known: Vec<&Vec<String>> = rows.iter().filter_map(|(_, t)| t.as_ref()).collect();
        let mut all: Vec<String> = known.iter().flat_map(|t| t.iter().cloned()).collect();
        all.sort();
        all.dedup();
        let enough = known.len() >= 2;
        let accounts = rows
            .iter()
            .map(|(a, tools)| {
                let mut a = a.clone();
                if let Some(t) = tools.as_ref().filter(|_| enough) {
                    a.missing = all.iter().filter(|n| !t.contains(n)).cloned().collect();
                }
                a
            })
            .collect();
        out.push(ModelCompare { model, accounts });
    }
    out
}
