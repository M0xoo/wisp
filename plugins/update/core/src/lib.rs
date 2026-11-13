//! wisp-update-core: the pure half of wisp.update (v1 server/update.js, server/services/install.js). Version
//! order, channels, how this copy was installed, the update check and install as a state machine, the app
//! self-update's checks, and the harness installer's npm arguments and messages. Sans-IO: the host fetches,
//! spawns (through the proc port) and writes files.

pub mod app;
pub mod channel;
pub mod harness;
pub mod install;
pub mod updater;
pub mod version;

pub use channel::{CHANNELS, Channel};
pub use install::{Install, Method, Platform, asset_name, cargo_clone, detect, installed_version};
pub use updater::{Asset, CheckRequest, Env, InstallStep, Refusal, Status, Swap, Updater, View, release_version, run_failed};
pub use version::{compare, newer, newest};
