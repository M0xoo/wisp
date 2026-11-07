//! wisp-machine-core: wisp.machine's pure logic. Sans-IO: no tokio, fs, net or clock; every reading,
//! time and table comes in as an argument.

pub mod hold;
pub mod this_mac;
pub mod watch;
