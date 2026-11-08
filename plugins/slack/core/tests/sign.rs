#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)] // tests may fail loudly
//! Slack's v0 signature (v1 test/channel-inbound.test.js: "a bad signature, a missing one and an old
//! timestamp are refused"; "it's judged by when the grid took it").
mod common;

use wisp_slack_core::SlackError;
use wisp_slack_core::sign::{MISSING, OLD, WRONG, signature, verify};

const SECRET: &str = "8f742231b10e8888abcd99yyyzzz85a5";

#[test]
fn slacks_own_example_verifies() {
    // api.slack.com/authentication/verifying-requests-from-slack
    let body = b"token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c";
    let sig = "v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503";
    assert_eq!(signature(SECRET, "1531420618", body), sig);
    assert_eq!(
        verify(
            SECRET,
            body,
            Some("1531420618"),
            Some(sig),
            1_531_420_618_000
        ),
        Ok(())
    );
}

#[test]
fn missing_old_and_wrong_each_say_why() {
    let body = b"{}";
    let now = 1_700_000_000_000;
    let ts = "1700000000";
    let good = signature(SECRET, ts, body);
    assert_eq!(
        verify(SECRET, body, None, Some(&good), now),
        Err(SlackError::Signature(MISSING))
    );
    assert_eq!(
        verify(SECRET, body, Some(ts), None, now),
        Err(SlackError::Signature(MISSING))
    );
    assert_eq!(
        verify(SECRET, body, Some("soon"), Some(&good), now),
        Err(SlackError::Signature(MISSING))
    );
    assert_eq!(
        verify(SECRET, body, Some(ts), Some(&good), now + 300_001),
        Err(SlackError::Signature(OLD))
    );
    assert_eq!(
        verify(SECRET, body, Some(ts), Some(&good), now - 300_001),
        Err(SlackError::Signature(OLD)),
        "from the future too"
    );
    assert_eq!(
        verify(SECRET, body, Some(ts), Some(&good), now + 300_000),
        Ok(()),
        "five minutes is still in"
    );
    assert_eq!(
        verify("other", body, Some(ts), Some(&good), now),
        Err(SlackError::Signature(WRONG))
    );
    assert_eq!(
        verify(SECRET, b"{} ", Some(ts), Some(&good), now),
        Err(SlackError::Signature(WRONG))
    );
    assert_eq!(
        verify(SECRET, body, Some(ts), Some("v0=00"), now),
        Err(SlackError::Signature(WRONG))
    );
}

#[test]
fn property_signed_bytes_verify_and_any_changed_byte_does_not() {
    let mut r = common::Rng::new(99);
    for _ in 0..500 {
        let len = r.below(200);
        let mut body = r.bytes(len);
        let ts = (1_600_000_000 + r.below(100_000_000)).to_string();
        let now = ts.parse::<i64>().unwrap() * 1000;
        let sig = signature(SECRET, &ts, &body);
        assert_eq!(verify(SECRET, &body, Some(&ts), Some(&sig), now), Ok(()));
        if !body.is_empty() {
            let at = r.below(body.len());
            body[at] ^= 1 << r.below(8);
            assert_eq!(
                verify(SECRET, &body, Some(&ts), Some(&sig), now),
                Err(SlackError::Signature(WRONG))
            );
        }
    }
}
