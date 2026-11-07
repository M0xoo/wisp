//! wisp-channels-core: the pure logic of `wisp.channels`, shared by the hub and every transport. Who
//! may speak and what may leave (policy, scrub, secrets), what a message asks for (grammar, mentions,
//! lists), the conversation flow, link codes, signed taps, box rules and routed retries. Sans-IO: no
//! tokio, fs, net or clock; time comes in as an argument.

pub mod grammar;
pub mod link;
pub mod lists;
pub mod mentions;
pub mod policy;
pub mod scrub;
pub mod secrets;
pub mod sign;
