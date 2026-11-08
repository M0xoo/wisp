//! wisp-accounts-api: the contract of wisp.accounts. It owns a harness's several accounts (v1
//! server/accounts.js), signing in from wisp (v1 agent-login.js), the harness watch (v1
//! harness-watch.js), the harnesses' own disk (harness-disk.js), live limit reads (live-limits.js),
//! spend and outcome stats (usage.js), the allowance per window (allowance.js) and .env masking
//! (env-mask.js).
//!
//! Everything per harness reaches it through `runtime.harness@1` (`login`, `accounts`, `keys`,
//! `folders`, `live_limits`, …), never by name (ADR-0003). wisp never switches accounts to get around a
//! limit: the providers' terms forbid bypassing their limits (design/accounts.md).
//!
//! Wire shapes are v1's (camelCase) so v1 clients and the HTTP adapters stay 1:1. Rows the UI reads
//! derive `ts_rs::TS` and export under `accounts/`.

// usage and allowance are not written yet; commands and model are.
pub mod commands;
pub mod model;

use wisp_kernel::{BoxFuture, Point};

pub use model::{
    AccountKind, AccountState, AccountView, AccountsOut, AddOut, ChangeKind, CleanOut, DiskHarness,
    DiskPart, DiskRemovable, DiskView, Fingerprint, KeyProviderView, KeysView, LoginState,
    LoginStatus, LoginView, Note, WatchChange, WatchView,
};

/// The plugin id (manifest `id`).
pub const PLUGIN_ID: &str = "wisp.accounts";

/// Read accounts, sign-in state, keys (never their values), the watch, usage.
pub const PERM_READ: &str = "accounts:read";
/// Add, rename, reorder, remove accounts; trust a changed harness.
pub const PERM_WRITE: &str = "accounts:write";
/// Run a harness's own login or logout.
pub const PERM_LOGIN: &str = "accounts:login";
/// Save or remove an API key where the CLI keeps it.
pub const PERM_KEYS: &str = "accounts:keys";
/// Remove crash dumps and stale temp files from the harnesses' folders.
pub const PERM_DISK: &str = "accounts:disk";

/// Account rows, sign-ins and the watch: clients refetch the harness list on a change (the topic
/// the UI subscribes to, plugins/accounts/ui/src/types.ts).
pub const TOPIC: &str = "plugin:wisp.accounts:harnesses";

/// The `held.kind` of a turn the harness watch holds (`held.by` is [`PLUGIN_ID`]).
pub const HOLD_KIND: &str = "harness-changed";

/// v1 `config.defaults` keys this plugin reads, kept as they were (the importer maps them 1:1).
pub mod settings {
    /// 'on' | 'off': Ask before running a changed harness (off unless on)
    pub const HARNESS_ASK: &str = "harnessAsk";
    /// 'on' | 'off': Check while work waits (off unless on)
    pub const LIVE_LIMITS: &str = "liveLimits";
    /// 'on' | 'off': .env masking (on unless off)
    pub const MASK_ENV: &str = "maskEnvFiles";
}

// ---------- extension points (stand-ins until the Harness trait has them; see the report) ----------

/// How a harness counts the work its turns report, for the allowance (v1 allowance.js `readingOf`,
/// `unitFor`, `PLAN_CHANGE`). Plain data.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Meter {
    /// 'usd' (a dollar counter) | 'mtok' (millions of tokens)
    pub unit: String,
    pub counter: Counter,
    /// a plan change when 1% stops meaning the same: [from, to) in ms
    #[serde(default)]
    pub plan_change: Option<(i64, i64)>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Counter {
    /// `stats.totals.costUsd` is the counter, `stats.costUsd` the turn's own; before totals existed,
    /// `costUsd` was the conversation's running total
    CostTotals,
    /// the turn's tokens are the thread's running total
    CumulativeTokens,
    /// the turn's tokens are its own
    TurnTokens,
}

impl Default for Meter {
    fn default() -> Self {
        Self {
            unit: "mtok".into(),
            counter: Counter::TurnTokens,
            plan_change: None,
        }
    }
}

/// `accounts.meter@1`: a harness plugin says how its usage counts (until `Harness::meter()` exists).
pub trait UsageMeter: Send + Sync + 'static {
    fn agent(&self) -> &str;
    fn meter(&self) -> Meter;
}

pub const METER: Point<dyn UsageMeter> = Point::new("accounts.meter", 1);

/// `accounts.phone@1`: whoever pairs the phone sends wisp's notes to it (v1 `app.remote.send`).
/// `false`: no phone set up, so the note waits (a banked reset's note is sent once a phone is).
pub trait Phone: Send + Sync + 'static {
    fn send(&self, note: Note) -> BoxFuture<'static, bool>;
}

pub const PHONE: Point<dyn Phone> = Point::new("accounts.phone", 1);
