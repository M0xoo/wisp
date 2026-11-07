//! wisp-machine-api: the contract of wisp.machine (This Mac). Two parts, kept in their own modules:
//! `this_mac` (what agents cost this computer, the RAM/CPU load guard, stopping what runs left behind,
//! Pause automations; v1 machine.js, load.js, routes/machine.js) and `hold` (Ask near the limit, the
//! before:run guard on usage windows, spare allowance; v1 guard.js, web/js/limit-hold.js, web/js/spare.js)
//! plus `watch` (the page an agent keeps beside its task; v1 watch.js).

pub mod hold;
pub mod this_mac;
pub mod watch;
