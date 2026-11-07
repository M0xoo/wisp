//! Facts `wisp.machines` publishes after the command (or the connection change) that caused them.
use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::Event;

use crate::rows::{PeerRow, PeerState};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Online {
    pub id: String,
}
impl Event for Online {
    const TYPE: &'static str = "machines.online";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Offline {
    pub id: String,
    pub state: PeerState,
}
impl Event for Offline {
    const TYPE: &'static str = "machines.offline";
}

/// The row or its status changed: the `machines` topic carries the new values.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct Changed {
    pub id: String,
}
impl Event for Changed {
    const TYPE: &'static str = "machines.changed";
}

/// A peer was removed: projects drop their checkouts there (v1 `remove()` re-homed them itself).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
pub struct Removed {
    pub id: String,
    pub row: PeerRow,
}
impl Event for Removed {
    const TYPE: &'static str = "machines.removed";
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
pub enum RemoteOp {
    Upsert,
    Del,
}

/// A row on a peer's list changed: other plugins (crew, router) follow remote tasks this way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub id: String,
    pub op: RemoteOp,
    pub row_id: String,
}
impl Event for Remote {
    const TYPE: &'static str = "machines.remote";
}
