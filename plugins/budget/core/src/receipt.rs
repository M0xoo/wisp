//! The pieces of a turn's usage receipt budget reads (v1 web/js/receipt.js): what a turn read and
//! wrote, its subagents' output, window names, percents and the median.

use serde::{Deserialize, Serialize};
use serde_json::Value;

const DAY: i64 = 86_400_000;

/// A subagent's line in `stats.subagents` (v1 adapters/claude.js subagentTally).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SubagentStat {
    #[serde(rename = "type")]
    pub kind: String,
    pub calls: Option<f64>,
    pub model: Option<String>,
    pub read: Option<f64>,
    pub output: Option<f64>,
    pub instead: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelStat {
    pub model: Option<String>,
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
}

/// A turn's stats as harnesses store them (v1 field names; every field optional).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StatsLike {
    pub cost_usd: Option<f64>,
    pub input_tokens: Option<f64>,
    pub output_tokens: Option<f64>,
    pub cache_read_tokens: Option<f64>,
    pub cache_write_tokens: Option<f64>,
    pub cached_input_tokens: Option<f64>,
    pub duration_ms: Option<f64>,
    pub turns: Option<f64>,
    pub baseline: bool,
    pub totals: Option<Box<StatsLike>>,
    /// an array of [`ModelStat`] (older turns: an object, ignored)
    pub models: Option<Value>,
    pub subagents: Vec<SubagentStat>,
}

/// v1 `n()`: a positive finite number, else 0.
pub fn n(x: Option<f64>) -> f64 {
    x.filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0)
}

/// `stats.models` of a turn. Before `stats.totals`, a resumed turn's models held the whole
/// conversation so far, so an older turn is read from usage alone.
fn models_in(st: &StatsLike) -> Vec<ModelStat> {
    if st.totals.is_none() {
        return Vec::new();
    }
    st.models.as_ref().and_then(|m| serde_json::from_value::<Vec<ModelStat>>(m.clone()).ok()).unwrap_or_default()
}

/// A subagent's output: without `stats.totals` it came from those models, so it can be the conversation's.
pub fn subagent_output(st: &StatsLike, x: &SubagentStat) -> f64 {
    if st.totals.is_some() { n(x.output) } else { 0.0 }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Tokens {
    pub read: f64,
    pub cached: f64,
    pub output: f64,
}

/// What a turn read (its cache reads and writes counted in), of that from the cache, and wrote.
/// Anthropic counts cache apart from input; `OpenAI`'s input already holds the cached tokens.
pub fn turn_tokens(st: &StatsLike) -> Tokens {
    let anthropic = st.cache_read_tokens.is_some() || st.cache_write_tokens.is_some();
    let read = if anthropic { n(st.input_tokens) + n(st.cache_read_tokens) + n(st.cache_write_tokens) } else { n(st.input_tokens) };
    let cached = if anthropic { n(st.cache_read_tokens) } else { n(st.cached_input_tokens).min(read) };
    // Claude's modelUsage counts every model the run used, its subagents' included, which usage can
    // leave out: the larger of the two is the turn's.
    let models = models_in(st);
    if !models.is_empty() {
        let m = models.iter().fold(Tokens::default(), |a, x| Tokens { read: a.read + n(x.input) + n(x.cache_read) + n(x.cache_write), cached: a.cached + n(x.cache_read), output: a.output + n(x.output) });
        if m.read + m.output > read + n(st.output_tokens) {
            return m;
        }
    }
    Tokens { read, cached, output: n(st.output_tokens) }
}

/// All the output the turn wrote, its subagents' included.
pub fn turn_output(st: &StatsLike) -> f64 {
    let models: f64 = models_in(st).iter().map(|m| n(m.output)).sum();
    let subs: f64 = st.subagents.iter().map(|x| subagent_output(st, x)).sum();
    models.max(n(st.output_tokens) + subs)
}

fn trim_zero(s: &str) -> String {
    s.strip_suffix(".0").unwrap_or(s).to_owned()
}

/// 38400 → "38k", 1250000 → "1.3M", 820 → "820".
pub fn token_words(x: f64) -> String {
    if x >= 1e6 {
        let digits = usize::from(x < 1e7);
        return format!("{}M", trim_zero(&format!("{:.*}", digits, js_round_to(x / 1e6, digits))));
    }
    if x >= 1e3 {
        return format!("{}k", js_round(x / 1e3));
    }
    js_round(x).to_string()
}

/// JS `Math.round`: half rounds up.
#[allow(clippy::cast_possible_truncation)]
pub fn js_round(x: f64) -> i64 {
    (x + 0.5).floor() as i64
}

/// `toFixed`'s rounding at `digits` decimals, half up.
#[allow(clippy::cast_precision_loss, clippy::cast_possible_wrap, clippy::cast_possible_truncation)]
fn js_round_to(x: f64, digits: usize) -> f64 {
    let p = 10f64.powi(digits as i32);
    js_round(x * p) as f64 / p
}

/// "<1%" for a share too small to round to one, and never "100%" for one that isn't all of it.
pub fn pct(x: f64) -> String {
    if x > 0.0 && x < 0.005 {
        "<1%".into()
    } else if x < 1.0 && x > 0.99 {
        "99%".into()
    } else {
        format!("{}%", js_round(x * 100.0))
    }
}

/// The window's name in a sentence: "weekly", "5-hour", "30-day"; "plan" when unknown.
#[allow(clippy::cast_precision_loss)]
pub fn window_name(id: &str) -> String {
    match id {
        "five_hour" => "5-hour".into(),
        "seven_day" => "weekly".into(),
        "seven_day_opus" => "weekly Opus".into(),
        "seven_day_sonnet" => "weekly Sonnet".into(),
        _ => match codex_mins(id) {
            0 => "plan".into(),
            m if m >= 1440 => format!("{}-day", js_round(m as f64 / 1440.0)),
            m => format!("{}-hour", js_round(m as f64 / 60.0)),
        },
    }
}

/// `w43200m` → 43200.
fn codex_mins(id: &str) -> i64 {
    id.strip_prefix('w').and_then(|r| r.strip_suffix('m')).filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit())).and_then(|d| d.parse().ok()).unwrap_or(0)
}

/// A window's length for ordering: with the 5-hour one gone on some plans, the week is what people count.
pub fn length_of(id: &str) -> i64 {
    match id {
        "seven_day" => 7 * DAY,
        "seven_day_opus" => 7 * DAY - 1,
        "seven_day_sonnet" => 7 * DAY - 2,
        "five_hour" => 5 * 3_600_000,
        _ => codex_mins(id) * 60_000,
    }
}

/// The longest window first.
pub fn longest_first(a: &str, b: &str) -> std::cmp::Ordering {
    length_of(b).cmp(&length_of(a))
}

/// Account comparison: each account's median turn over the last 7 days, once each has 5 on a model.
pub const COMPARE_MIN: usize = 5;
pub const COMPARE_DAYS: i64 = 7;

/// The middle one, or the mean of the two in the middle; 0 for none.
pub fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let mut a = xs.to_vec();
    a.sort_by(f64::total_cmp);
    let m = a.len() / 2;
    if a.len() % 2 == 1 { a[m] } else { f64::midpoint(a[m - 1], a[m]) }
}
