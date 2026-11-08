//! wisp-slack-core: what Slack says and what wisp says back, with no IO (v1 `server/channels/slack.js`).
//! Socket Mode frames and their acks, the connection's own rules (hello in time, Slack's disconnect,
//! when to dial again), the v0 request signature, an event read down to the message a person sent, a
//! click read down to its signed button, and Slack's markup for what leaves. The host crate
//! (`wisp-slack`) owns the wire; everything it decides is decided here, with time passed in.

pub mod event;
pub mod mrkdwn;
pub mod post;
pub mod sign;
pub mod socket;

use wisp_kernel::WireError;

/// What went wrong talking to Slack. Only ever Slack's own short codes: never a token.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum SlackError {
    /// Slack answered `{ ok: false, error }`, or an HTTP status with no body worth reading
    #[error("Slack: {0}")]
    Api(String),
    #[error("Slack: ratelimited")]
    RateLimited { retry_after_s: u64 },
    /// the request never got an answer (a refusal, a timeout, a connection that kept breaking)
    #[error("{0}")]
    Net(String),
    #[error("{0}")]
    Signature(&'static str),
}

impl SlackError {
    /// Slack's code, when it gave one.
    pub fn code(&self) -> Option<&str> {
        match self {
            Self::Api(c) => Some(c),
            Self::RateLimited { .. } => Some("ratelimited"),
            Self::Net(_) | Self::Signature(_) => None,
        }
    }
    /// Won't change by trying again: new tokens or a new app setting are needed.
    pub fn for_good(&self) -> bool {
        self.code().is_some_and(for_good)
    }
    /// What Settings shows: a code that needs new tokens says where to put them.
    pub fn line(&self) -> String {
        if self.for_good() {
            format!("{self}. {FIX}")
        } else {
            self.to_string()
        }
    }
}

impl From<SlackError> for WireError {
    fn from(e: SlackError) -> Self {
        match &e {
            SlackError::Signature(_) => WireError::forbidden(e.to_string()),
            SlackError::RateLimited { retry_after_s } => WireError::unavailable(e.to_string())
                .with_details(serde_json::json!({ "retryAfter": retry_after_s })),
            SlackError::Api(_) if e.for_good() => WireError::invalid(e.line()),
            SlackError::Net(_) | SlackError::Api(_) => WireError::unavailable(e.to_string()),
        }
    }
}

pub const FIX: &str = "Check the tokens in wisp → Settings → Phone → Slack.";
const FOR_GOOD: &[&str] = &[
    "invalid_auth",
    "not_authed",
    "account_inactive",
    "token_revoked",
    "token_expired",
    "no_permission",
    "missing_scope",
    "not_allowed_token_type",
    "org_login_required",
    "team_access_not_granted",
    "link_disabled",
];

/// A code that won't change by trying again (an API error, or the reason of Slack's disconnect).
pub fn for_good(code: &str) -> bool {
    FOR_GOOD.contains(&code)
}

pub const BACKOFF_MAX_MS: u64 = 5 * 60_000;

/// How long before dialling again after `fails` failures in a row (1 = the first): doubling, capped.
pub fn backoff_ms(base_ms: u64, fails: u32) -> u64 {
    let shift = fails.saturating_sub(1).min(30);
    base_ms.saturating_mul(1u64 << shift).min(BACKOFF_MAX_MS)
}

/// At most `n` characters, the last one `…` when it was cut (v1 `truncate`).
pub fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
    out.push('…');
    out
}
