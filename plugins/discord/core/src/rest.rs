//! Discord's REST rate limits (v1 discord.js `#turn`, `#learn`, `bucketOf`): calls share a bucket per route (a
//! channel's, a webhook's, an interaction's), a bucket that said it has nothing left waits until it resets, a 429
//! pauses its bucket (or every bucket, when global) for as long as Discord says, and the call tries again. Sans-IO:
//! time comes in as `now` (ms).

use std::collections::HashMap;

/// How many times a call is tried before a 429 is the answer.
pub const TRIES: u32 = 3;
/// A bucket map that grew past this is cleared (v1).
const KEEP: usize = 500;

/// The bucket a call goes in: `METHOD /channels/<id>`, `/webhooks/<id>`, `/interactions/<id>`, else its path.
pub fn bucket_of(method: &str, path: &str) -> String {
    let mut parts = path.trim_start_matches('/').splitn(3, '/');
    let (a, b) = (parts.next().unwrap_or_default(), parts.next());
    match (a, b) {
        ("channels" | "webhooks" | "interactions", Some(id)) if !id.is_empty() => format!("{method} /{a}/{id}"),
        _ => format!("{method} {path}"),
    }
}

/// What the REST client knows of Discord's limits.
#[derive(Debug, Default, Clone)]
pub struct Limits {
    paused: HashMap<String, i64>,
    global_until: i64,
}

impl Limits {
    /// How long a call in `bucket` waits before it goes (0: now).
    pub fn wait_ms(&mut self, bucket: &str, now: i64) -> u64 {
        let until = self.global_until.max(self.paused.get(bucket).copied().unwrap_or(0));
        if until <= now {
            self.paused.remove(bucket);
            return 0;
        }
        u64::try_from(until - now).unwrap_or(0)
    }

    /// The headers of an answer: a bucket with nothing left waits for its reset.
    pub fn learn(&mut self, bucket: &str, headers: &[(String, String)], now: i64) {
        let h = |k: &str| headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.trim());
        if h("x-ratelimit-remaining") != Some("0") {
            return;
        }
        if let Some(after) = h("x-ratelimit-reset-after").and_then(|v| v.parse::<f64>().ok()).filter(|a| *a > 0.0) {
            if self.paused.len() > KEEP {
                self.paused.clear();
            }
            self.paused.insert(bucket.to_owned(), now + secs_ms(after));
        }
    }

    /// A 429: its bucket (or all, when global) waits `retry_after` seconds (Discord's body, else its header, else 1).
    pub fn limited(&mut self, bucket: &str, retry_after: Option<f64>, global: bool, now: i64) -> u64 {
        let ms = secs_ms(retry_after.filter(|r| *r > 0.0).unwrap_or(1.0));
        if global {
            self.global_until = now + ms;
        } else {
            self.paused.insert(bucket.to_owned(), now + ms);
        }
        u64::try_from(ms).unwrap_or(0)
    }
}

#[allow(clippy::cast_possible_truncation)] // seconds Discord gives are small
fn secs_ms(s: f64) -> i64 {
    (s * 1000.0).ceil() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn heads(rem: &str, after: &str) -> Vec<(String, String)> {
        vec![("X-RateLimit-Remaining".into(), rem.into()), ("x-ratelimit-reset-after".into(), after.into())]
    }

    /// v1 discord.js: a bucket per channel, webhook or interaction; one that's used up waits for its reset, a 429
    /// pauses its bucket (others go on) or, global, every bucket; then calls go again.
    #[test]
    fn discord_rest_calls_wait_per_bucket_and_a_429_pauses_its_bucket_or_all() {
        assert_eq!(bucket_of("POST", "/channels/123/messages"), "POST /channels/123");
        assert_eq!(bucket_of("PATCH", "/webhooks/9/tok/messages/@original"), "PATCH /webhooks/9");
        assert_eq!(bucket_of("GET", "/gateway/bot"), "GET /gateway/bot");
        let mut l = Limits::default();
        let a = bucket_of("POST", "/channels/1/messages");
        let b = bucket_of("POST", "/channels/2/messages");
        assert_eq!(l.wait_ms(&a, 0), 0);
        l.learn(&a, &heads("3", "1.5"), 0);
        assert_eq!(l.wait_ms(&a, 0), 0, "something left: no wait");
        l.learn(&a, &heads("0", "1.5"), 0);
        assert_eq!((l.wait_ms(&a, 0), l.wait_ms(&b, 0)), (1500, 0), "used up: that bucket waits, the other doesn't");
        assert_eq!(l.wait_ms(&a, 1500), 0);
        assert_eq!(l.limited(&b, Some(0.25), false, 100), 250);
        assert_eq!((l.wait_ms(&b, 100), l.wait_ms(&a, 100)), (250, 0));
        l.limited(&a, None, true, 1000);
        assert_eq!((l.wait_ms(&a, 1000), l.wait_ms(&b, 1000), l.wait_ms("GET /x", 1999)), (1000, 1000, 1), "global: every bucket");
    }
}
