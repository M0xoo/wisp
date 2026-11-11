//! wisp.crew pure logic, sans-IO (v1 server/crew.js, crew-share.js, crew-tools.js): the schedule, the
//! queue, filing, follow-ups, the notebook, kits, mentions, spells' locks and sharing. Time comes in as
//! `now` (ms since the epoch), ids through [`kit::Ids`], the local zone through [`cron::Zone`].

pub mod answers;
pub mod cron;
pub mod error;
pub mod filing;
pub mod jobs;
pub mod kit;
pub mod layout;
pub mod member;
pub mod memory;
pub mod mentions;
pub mod note;
pub mod queue;
pub mod run;
pub mod scan;
pub mod schedule;
pub mod share;
pub mod spell;
pub mod text;
pub mod tick;
pub mod tools;
pub mod transfer;

pub use error::{Error, Result};
