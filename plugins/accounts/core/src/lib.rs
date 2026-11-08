//! wisp.accounts core (sans-IO): the account list per harness (v1 server/accounts.js minus its
//! folders), the harness watch's decisions (v1 harness-watch.js minus its hashing), and reading a
//! sign-in's output (v1 agent-login.js `parse`). The host does the disk, the processes and the store.

pub mod accounts;
pub mod login;
pub mod watch;
