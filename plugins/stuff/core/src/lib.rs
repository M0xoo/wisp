//! wisp-stuff-core: the pure half of `wisp.stuff` (no tokio, no fs, no net, no clock). Everything My
//! Stuff decides lives here so it can be tested on its own: names, kinds and types (`kind`), records
//! and their versions and grants (`record`, `make`), an app's code hash and the starter rule (`app`),
//! what an app's server answers (`serve`), the app database's rules (`appdb`), what an agent reads
//! (`agent`) and the v1 import plan (`import_v1`). The host does the reading and writing.

pub mod agent;
pub mod app;
pub mod appdb;
pub mod import_v1;
pub mod kind;
pub mod make;
pub mod record;
pub mod serve;

/// A refusal with its HTTP status and the words the user (or agent) reads. The host maps it to a
/// `WireError` by status.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bad {
    pub status: u16,
    pub message: String,
}

impl Bad {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Bad {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Bad {}
