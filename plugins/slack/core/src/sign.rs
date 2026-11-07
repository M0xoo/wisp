//! Slack's request signature (v1 `hooks.js` `slackOk`): `v0=` HMAC-SHA256 of `v0:<ts>:<body>` with the
//! signing secret, over the exact bytes, and a timestamp no more than five minutes from now. A
//! signature compares in constant time; whatever is wrong, the answer is one of three fixed lines.
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::SlackError;

/// How far Slack's timestamp may be from now, either way.
pub const SKEW_S: i64 = 5 * 60;
pub const MISSING: &str = "Missing Slack’s signature headers.";
pub const OLD: &str =
    "Slack’s timestamp is more than 5 minutes off: a replay, or this computer’s clock is wrong.";
pub const WRONG: &str = "Slack’s signature doesn’t match the signing secret.";

/// `v0=<hex>` for these bytes at this timestamp.
pub fn signature(secret: &str, ts: &str, raw: &[u8]) -> String {
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret.as_bytes()) else {
        return String::new();
    };
    mac.update(b"v0:");
    mac.update(ts.as_bytes());
    mac.update(b":");
    mac.update(raw);
    let bytes = mac.finalize().into_bytes();
    let mut out = String::with_capacity(3 + bytes.len() * 2);
    out.push_str("v0=");
    for b in bytes {
        out.push(char::from(HEX[usize::from(b >> 4)]));
        out.push(char::from(HEX[usize::from(b & 15)]));
    }
    out
}

const HEX: &[u8; 16] = b"0123456789abcdef";

/// `x-slack-request-timestamp` and `x-slack-signature` against the body. `now_ms`: when it arrived
/// (for a held message, when the grid took it).
pub fn verify(
    secret: &str,
    raw: &[u8],
    timestamp: Option<&str>,
    sig: Option<&str>,
    now_ms: i64,
) -> Result<(), SlackError> {
    let ts = timestamp.map(str::trim).filter(|t| !t.is_empty());
    let (Some(ts), Some(sig)) = (ts, sig.filter(|s| !s.is_empty())) else {
        return Err(SlackError::Signature(MISSING));
    };
    let Some(at) = ts.parse::<i64>().ok().filter(|n| *n != 0) else {
        return Err(SlackError::Signature(MISSING));
    };
    if now_ms
        .saturating_sub(at.saturating_mul(1000))
        .saturating_abs()
        > SKEW_S * 1000
    {
        return Err(SlackError::Signature(OLD));
    }
    let want = signature(secret, ts, raw);
    if want.is_empty()
        || want.len() != sig.len()
        || !bool::from(want.as_bytes().ct_eq(sig.as_bytes()))
    {
        return Err(SlackError::Signature(WRONG));
    }
    Ok(())
}
