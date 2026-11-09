//! wisp.automations' pure logic (ADR-0043), sans-IO: the trigger engine's decisions ([`engine`]) and when a
//! schedule is due ([`schedule`]). The host feeds it events and the time and runs what it decides.

pub mod engine;
pub mod schedule;
