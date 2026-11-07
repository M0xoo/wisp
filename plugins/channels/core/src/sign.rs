//! Signed answers: a stranger who guesses the topic (ntfy) or forges a button (Telegram) can't steer
//! an agent. v1's `Remote.sign`: HMAC-SHA256 over `<session>.<kind>.<ref>.<index>` with the hub's
//! secret, base64url, the first 22 characters. Compared in constant time.
use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use wisp_channels_api::{ActionKind, Signed};

type HmacSha256 = Hmac<Sha256>;

pub const SIG_LEN: usize = 22;

/// HMAC-SHA256 of `data` under `key`, base64url without padding.
pub fn hmac_b64url(key: &[u8], data: &[u8]) -> String {
    // new_from_slice only fails for fixed-size keys; HMAC takes any length
    let Ok(mut mac) = HmacSha256::new_from_slice(key) else { return String::new() };
    mac.update(data);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

/// HMAC-SHA256 of `data` under `key`, lower hex (Slack's `v0=` signatures, GitHub's `sha256=`).
pub fn hmac_hex(key: &[u8], data: &[u8]) -> String {
    let Ok(mut mac) = HmacSha256::new_from_slice(key) else { return String::new() };
    mac.update(data);
    hex(&mac.finalize().into_bytes())
}

pub fn sha256_hex(data: &[u8]) -> String {
    hex(&Sha256::digest(data))
}

pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from(DIGITS[usize::from(b >> 4)]));
        s.push(char::from(DIGITS[usize::from(b & 0xf)]));
    }
    s
}

/// Equal strings, in time that doesn't depend on where they differ.
pub fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

fn kind_word(k: ActionKind) -> &'static str {
    match k {
        ActionKind::Answer => "answer",
        ActionKind::Reply => "reply",
        ActionKind::Done => "done",
    }
}

/// The signature of one tap.
pub fn sign(secret: &str, session_id: &str, kind: ActionKind, reference: &str, index: u32) -> String {
    let data = format!("{session_id}.{}.{reference}.{index}", kind_word(kind));
    let mut sig = hmac_b64url(secret.as_bytes(), data.as_bytes());
    sig.truncate(SIG_LEN);
    sig
}

/// A tap as signed, ready to be carried in a button.
pub fn signed(secret: &str, session_id: &str, kind: ActionKind, reference: &str, index: u32) -> Signed {
    Signed { s: session_id.into(), k: kind.code().into(), r: reference.into(), i: index, sig: sign(secret, session_id, kind, reference, index) }
}

/// True for a tap this hub signed. An unknown kind or an empty secret never verifies.
pub fn verify(secret: &str, p: &Signed) -> bool {
    let Some(kind) = ActionKind::from_code(&p.k) else { return false };
    !secret.is_empty() && same(&sign(secret, &p.s, kind, &p.r, p.i), &p.sig)
}
