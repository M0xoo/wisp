//! `GET /api/status` (v1 routes/meta.js, edge case 9): whether anything is going on, for whoever starts
//! and stops this wisp (wisp Grid stops an idle box). Plugins report their part through the
//! `kernel.status` point; the edge adds the clients looking and its own `lastActivityAt`: every non-GET
//! request except a quiet open route (a channel's inbound message must never keep a box awake).
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use serde_json::{Value, json};
use wisp_kernel::http::{Liveness, StatusPart};

#[derive(Debug)]
pub struct Activity {
    last: AtomicI64,
}

impl Activity {
    pub fn new(now_ms: i64) -> Self {
        // a wisp that just started counts as used: the grid gives a fresh box its idle period
        Self {
            last: AtomicI64::new(now_ms),
        }
    }
    pub fn touch(&self, now_ms: i64) {
        self.last.fetch_max(now_ms, Ordering::Relaxed);
    }
    pub fn last(&self) -> i64 {
        self.last.load(Ordering::Relaxed)
    }
}

/// The sum of the plugins' parts: counts add up, the latest activity and the earliest wake win.
pub fn combine(parts: &[Arc<dyn StatusPart>]) -> Liveness {
    parts
        .iter()
        .map(|p| p.liveness())
        .fold(Liveness::default(), |a, b| Liveness {
            live: a.live + b.live,
            sides: a.sides + b.sides,
            terms: a.terms + b.terms,
            channels: a.channels + b.channels,
            last_activity_at: a.last_activity_at.max(b.last_activity_at),
            next_wake_at: match (a.next_wake_at, b.next_wake_at) {
                (Some(x), Some(y)) => Some(x.min(y)),
                (x, y) => x.or(y),
            },
        })
}

/// v1's shape: `{live, sides, terms, channels, clients, lastActivityAt, nextWakeAt, version}`.
pub fn answer(
    parts: &[Arc<dyn StatusPart>],
    clients: usize,
    activity: &Activity,
    version: &str,
) -> Value {
    let l = combine(parts);
    let last = l
        .last_activity_at
        .map_or(activity.last(), |x| x.max(activity.last()));
    json!({
        "live": l.live,
        "sides": l.sides,
        "terms": l.terms,
        "channels": l.channels,
        "clients": clients,
        "lastActivityAt": last,
        "nextWakeAt": l.next_wake_at,
        "version": version,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct P(Liveness);
    impl StatusPart for P {
        fn liveness(&self) -> Liveness {
            self.0
        }
    }

    #[test]
    fn parts_add_up() {
        let parts: Vec<Arc<dyn StatusPart>> = vec![
            Arc::new(P(Liveness {
                live: 2,
                sides: 1,
                last_activity_at: Some(50),
                next_wake_at: Some(900),
                ..Liveness::default()
            })),
            Arc::new(P(Liveness {
                terms: 3,
                channels: 1,
                last_activity_at: Some(70),
                next_wake_at: Some(800),
                ..Liveness::default()
            })),
            Arc::new(P(Liveness::default())),
        ];
        let a = Activity::new(10);
        let v = answer(&parts, 4, &a, "2.0.0");
        assert_eq!(
            v,
            json!({"live": 2, "sides": 1, "terms": 3, "channels": 1, "clients": 4, "lastActivityAt": 70, "nextWakeAt": 800, "version": "2.0.0"})
        );
        a.touch(100);
        a.touch(90); // never goes back
        assert_eq!(answer(&parts, 0, &a, "x")["lastActivityAt"], 100);
        assert_eq!(answer(&[], 0, &a, "x")["nextWakeAt"], Value::Null);
    }
}
