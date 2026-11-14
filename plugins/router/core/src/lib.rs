//! wisp.router pure logic, sans-IO: Auto picks the harness, model and thinking level for a task
//! with a bandit (Thompson sampling over Beta records stacked from public benchmarks, your history
//! and your taste), and tells usage limits apart from the model failing. Time comes in as `now`
//! (ms since the epoch) and randomness as an [`math::Rng`]; nothing here does I/O.
//!
//! v1: server/router.js, server/priors-build.js, server/services/auto.js, server/routes/auto.js.

pub mod auto;
pub mod choose;
pub mod classify;
pub mod estimate;
pub mod keys;
pub mod math;
pub mod priors;
pub mod priors_build;
pub mod report;
pub mod router;
pub mod state;

pub use choose::{Prefs, choose, cooling, level_up};
pub use classify::{BLIP_MS, MAX_COOL_MS, infra_error, limit_of, task};
pub use math::{Mulberry32, Rng, reward};
pub use router::Router;
pub use state::RouterState;

/// The one error this crate gives: a request the router refuses, with v1's message.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
}
