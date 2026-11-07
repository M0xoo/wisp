//! The dice of a pick and the reward of a run. Thompson sampling draws from Beta(wins, losses); the
//! randomness is always passed in ([`Rng`]), never global, so a seed replays a pick exactly.

use wisp_router_api::{Check, Feedback, Hero, Signals};

use crate::keys::round;

/// Uniform numbers in [0, 1).
pub trait Rng {
    fn next_f64(&mut self) -> f64;
}

/// v1's mulberry32: small, fast and the same sequence as v1 for a seed.
#[derive(Debug, Clone)]
pub struct Mulberry32(u32);

impl Mulberry32 {
    pub fn new(seed: u32) -> Self {
        Self(seed)
    }
}

impl Rng for Mulberry32 {
    fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let a = self.0;
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
}

fn unit(r: &mut dyn Rng) -> f64 {
    let x = r.next_f64();
    if x > 0.0 { x } else { 1e-12 }
}

/// Gamma(k, 1) by Marsaglia–Tsang. The loop ends with probability 1; the cap only guards a broken
/// generator (one that always answers the same number).
fn gamma(k: f64, r: &mut dyn Rng) -> f64 {
    if k < 1.0 {
        return gamma(k + 1.0, r) * unit(r).powf(1.0 / k);
    }
    let d = k - 1.0 / 3.0;
    let c = 1.0 / (9.0 * d).sqrt();
    for _ in 0..10_000 {
        let u1 = unit(r);
        let u2 = r.next_f64();
        let x = (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos();
        let v = 1.0 + c * x;
        if v <= 0.0 {
            continue;
        }
        let v = v * v * v;
        if unit(r).ln() < 0.5 * x * x + d - d * v + d * v.ln() {
            return d * v;
        }
    }
    d
}

/// Beta(a, b) from two Gamma draws. A count rounded to zero or below (a voided run) is a tiny one.
pub fn beta_sample(a: f64, b: f64, r: &mut dyn Rng) -> f64 {
    let x = gamma(a.max(1e-9), r);
    let y = gamma(b.max(1e-9), r);
    let s = x + y;
    if s > 0.0 && s.is_finite() { x / s } else { a.max(0.0) / (a.max(0.0) + b.max(0.0)).max(1e-12) }
}

/// The reward of a run, strongest signal first; `None` while nothing says how it went (v1
/// router.js:777). A later, stronger signal replaces an earlier one because this reads them all.
pub fn reward(s: &Signals) -> Option<f64> {
    let yes = |b: Option<bool>| b == Some(true);
    // moved to another harness or model in a follow-up: whatever happens next isn't this arm's
    if yes(s.switched) {
        return Some(0.1);
    }
    if yes(s.merged) {
        return Some(1.0);
    }
    match s.feedback.flatten() {
        Some(Feedback::Up) => return Some(1.0),
        Some(Feedback::Down) => return Some(0.0),
        None => {}
    }
    if yes(s.closed) {
        return Some(0.2);
    }
    if s.rolled_back.flatten() == Some(true) {
        return Some(0.1);
    }
    if yes(s.error) || s.check == Some(Check::Error) {
        return Some(0.0);
    }
    let follow = 0.1 * f64::from(s.followups.unwrap_or(0));
    // wisp's own test run beats the agent's word; a repair round and losing a best-of-2 cost some
    match s.check {
        Some(Check::Fail) => return Some(0.1),
        Some(Check::Pass) => {
            let base = if yes(s.repaired) { 0.6 } else { 0.8 } - if s.picked == Some(false) { 0.15 } else { 0.0 };
            return Some(round((base - follow).max(0.3), 2));
        }
        _ => {}
    }
    let base = match s.hero? {
        Hero::Done => 0.6,
        Hero::Partial => 0.3,
        Hero::Blocked => 0.1,
        Hero::Info => 0.5,
    };
    Some(round((base - follow).max(0.05), 2))
}
