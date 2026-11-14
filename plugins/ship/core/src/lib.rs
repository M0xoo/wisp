//! wisp-ship-core: Ship it's pure logic, sans-IO (no tokio, fs, net or clock: times are passed in).
//! gh's JSON in, PR rows out; the deciders between the git and gh calls the host makes; the follow-up
//! policy (polls, news, conflict fixes) and the recheck gate.
#![cfg_attr(test, allow(clippy::assert_is_empty, clippy::option_option, clippy::doc_markdown, clippy::map_unwrap_or))]

pub mod decide;
pub mod detail;
pub mod follow;
pub mod pr;
pub mod recheck;
pub mod slot;
pub mod text;
pub mod time;

pub use decide::Refusal;
pub use detail::{check_list, pr_detail_of, pull_coords, threads_of};
pub use pr::{DETAIL_FIELDS, PR_FIELDS, checks_of, classify, is_bot, pr_summary};
