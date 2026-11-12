//! Where a turn's tokens went (the receipt). As claude 2.1.316 streams it: `result.modelUsage` has the
//! tokens per model (subagents' and side calls' included) and adds up over every result of the
//! process, so each result keeps only what's new since the last. `result.usage` is the main thread's
//! alone. On --resume the CLI starts from the conversation's saved counters (edge case 2).

use serde_json::{Map, Value, json};
use wisp_harness_kit::js::{json_num, num, str};

use crate::line::{Entries, Line, NULL, or_null};

/// What one model did, since the last result.
#[derive(Debug, Clone, PartialEq)]
pub struct ModelTokens {
    pub model: String,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
}

const KEYS: [&str; 4] = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
];

/// A positive number, else 0 (v1 `n0`).
pub fn n0(v: &Value) -> f64 {
    num(v).filter(|x| *x > 0.0).unwrap_or(0.0)
}

impl ModelTokens {
    fn get(&self, i: usize) -> f64 {
        [self.input, self.output, self.cache_read, self.cache_write][i]
    }
    pub fn to_json(&self) -> Value {
        json!({ "model": self.model, "input": json_num(self.input), "output": json_num(self.output), "cacheRead": json_num(self.cache_read), "cacheWrite": json_num(self.cache_write) })
    }
}

/// Per model, most output first, what's new since `prev` (a modelUsage-shaped object), or None.
pub fn models_of(model_usage: Option<&Entries>, prev: &Value) -> Option<Vec<ModelTokens>> {
    let mu = model_usage?;
    let mut list: Vec<ModelTokens> =
        mu.0.iter()
            .map(|(model, u)| {
                let k = |i: usize| (n0(&u[KEYS[i]]) - n0(&prev[model.as_str()][KEYS[i]])).max(0.0);
                ModelTokens {
                    model: model.clone(),
                    input: k(0),
                    output: k(1),
                    cache_read: k(2),
                    cache_write: k(3),
                }
            })
            .filter(|m| m.input + m.output + m.cache_read + m.cache_write > 0.0)
            .collect();
    // Stable, as Array.prototype.sort is: ties keep modelUsage's order.
    list.sort_by(|a, b| {
        b.output
            .partial_cmp(&a.output)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    (!list.is_empty()).then_some(list)
}

/// The context window of the main thread's model, from modelUsage (each model says its own), or 0 (v1 #785
/// `contextWindowOf`). The init's model id can carry a suffix modelUsage leaves off (`claude-opus-5-5[1m]`);
/// with no match, the window of the model that read most is the safest reading.
pub fn context_window_of(mu: &Entries, model: &str) -> f64 {
    let ok = |v: &Value| num(v).filter(|x| x.is_finite() && *x > 0.0).unwrap_or(0.0);
    let base = model.find('[').map_or(model, |i| &model[..i]);
    let hit = [model, base].into_iter().filter(|m| !m.is_empty()).find_map(|m| mu.0.iter().find(|(k, _)| k == m)).map(|(_, u)| ok(&u["contextWindow"]));
    if let Some(w) = hit.filter(|w| *w > 0.0) {
        return w;
    }
    let read = |u: &Value| n0(&u["inputTokens"]) + n0(&u["cacheReadInputTokens"]) + n0(&u["cacheCreationInputTokens"]);
    // the first of the most read, as v1's stable sort kept it
    let mut top: Option<&Value> = None;
    for (_, u) in &mu.0 {
        if top.is_none_or(|t| read(u) > read(t)) {
            top = Some(u);
        }
    }
    top.map_or(0.0, |u| ok(&u["contextWindow"]))
}

/// A models list back in modelUsage's shape, for `models_of`'s prev.
pub fn model_usage_of(list: &[ModelTokens]) -> Value {
    let mut m = Map::new();
    for t in list {
        let mut e = Map::new();
        for (i, k) in KEYS.iter().enumerate() {
            e.insert((*k).to_owned(), json_num(t.get(i)));
        }
        m.insert(t.model.clone(), Value::Object(e));
    }
    Value::Object(m)
}

pub fn models_json(list: &[ModelTokens]) -> Value {
    Value::Array(list.iter().map(ModelTokens::to_json).collect())
}

/// The counters a conversation had after its last turn (stats.totals).
#[derive(Debug, Clone, PartialEq)]
pub struct Counted {
    pub cost_usd: f64,
    pub models: Option<Vec<ModelTokens>>,
}

pub fn as_counted(v: &Value) -> Option<Counted> {
    let cost = num(&v["costUsd"])?;
    let models = v["models"].as_array().map(|a| {
        a.iter()
            .map(|m| ModelTokens {
                model: str(&m["model"]),
                input: n0(&m["input"]),
                output: n0(&m["output"]),
                cache_read: n0(&m["cacheRead"]),
                cache_write: n0(&m["cacheWrite"]),
            })
            .collect()
    });
    Some(Counted {
        cost_usd: cost,
        models,
    })
}

fn total_cost(msg: &Line) -> Option<f64> {
    num(or_null(&msg.total_cost_usd))
}

/// Whether this process started from `prior`: the counters grew by at least what this run's main
/// thread wrote. It can also start from zero (another account's login folder).
pub fn restored_from(msg: &Line, prior: Option<&Counted>) -> bool {
    let Some(prior) = prior else { return false };
    if !total_cost(msg).is_some_and(|t| t >= prior.cost_usd) {
        return false;
    }
    let now: f64 = msg.model_usage.as_ref().map_or(0.0, |e| {
        e.0.iter().map(|(_, u)| n0(&u["outputTokens"])).sum()
    });
    let was: f64 = prior
        .models
        .as_ref()
        .map_or(0.0, |m| m.iter().map(|x| x.output).sum());
    now - was >= n0(&msg.usage["output_tokens"])
}

/// Where this process's counters started, from its first result.
#[derive(Debug, Clone, PartialEq)]
pub enum Start {
    /// from zero
    Zero,
    /// from the conversation's last turn (`prior`)
    Prior(Counted),
    /// a chat that ran elsewhere (bring-in): this first result is the baseline
    Baseline(Counted),
}

impl Start {
    pub fn counted(&self) -> Option<&Counted> {
        match self {
            Self::Zero => None,
            Self::Prior(c) | Self::Baseline(c) => Some(c),
        }
    }
}

/// unknownPrior: its counters hold all it ever spent and the chat can't be read to learn how much,
/// so one turn undercounts rather than a whole conversation overcounting on one turn.
pub fn counted_from(msg: &Line, prior: Option<&Counted>, unknown_prior: bool) -> Start {
    if restored_from(msg, prior) {
        return prior.map_or(Start::Zero, |p| Start::Prior(p.clone()));
    }
    match total_cost(msg) {
        Some(t) if unknown_prior && prior.is_none() => Start::Baseline(Counted {
            cost_usd: t,
            models: models_of(msg.model_usage.as_ref(), &NULL),
        }),
        _ => Start::Zero,
    }
}

/// This turn's cost: the total since the start, to 7 places (NaN when the CLI sent none, as v1).
pub fn cost_since(msg: &Line, counted: &Counted) -> f64 {
    let d = (total_cost(msg).unwrap_or(f64::NAN) - counted.cost_usd) * 1e7;
    // Math.round: half up
    let r = (d + 0.5).floor() / 1e7;
    if r.is_nan() { r } else { r.max(0.0) }
}
