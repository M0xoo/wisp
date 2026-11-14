//! wisp.machines (plan §7.2, ADR-0010): peers, your other computers, reached over the v2 sync
//! protocol (ADR-0005). Each peer has a link: a transport (`machines.transport@1`) opens a channel
//! to its wisp, the manager checks it answers and finds its harnesses, then a `PeerClient` (core)
//! holds one `GET /api/events` stream there and posts its messages back, resuming from its cursor.
//! The rows the peer's `list` shows are mirrored here; commands for its rows go there with the same
//! idempotency key (`machines.route`).
//!
//! - `ssh` (ssh.rs) ships here: system OpenSSH, the bootstrap installs and starts wisp's binary there
//! - `loopback` (loopback.rs): another wisp on this computer (another home, another port)
//! - `grid`, `grid-tunnel` come from wisp.grid-client; a user's plugin may add its own
//!
//! Peers, their status, the mirror and each link's resume point live in the store (store.rs). Every
//! task a link runs belongs to the plugin's scope: switching it off closes every connection.
//!
//! v2 only (ADR-0031): no v1 relay, no `<id>@<machine>` ids, no v1 route proxy.
//!
//! resources: data-only (a computer as code is wisp.machine's `machine` kind, whose owner adds it here with `machines.add`; these rows are the peers' connection state, their mirrored lists and resume points (ADR-0028)).

// `Failing<T>` is the transport contract's result (machines-api): a failure carries its hint, and is rare
#![allow(clippy::result_large_err)]

mod commands;
mod error;
mod http;
mod letin;
mod link;
mod loopback;
mod manager;
mod proxy;
mod service;
mod ssh;
mod state;
mod store;
mod sys;

use std::sync::{Arc, OnceLock};

use wisp_kernel::{Manifest, Plugin, Result, Setup, WireError};
use wisp_machines_api::{Peers, TRANSPORT, Transport};
use wisp_store::Store;

pub use error::MachinesError;
pub use loopback::LoopbackTransport;
pub(crate) use state::{State, lock};

pub(crate) type Slot = Arc<OnceLock<Arc<State>>>;

pub(crate) fn state(slot: &Slot) -> Result<Arc<State>> {
    slot.get().cloned().ok_or_else(|| WireError::unavailable("wisp.machines is starting"))
}

/// This build's version: the one the bootstrap installs over there.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Default)]
pub struct MachinesPlugin;

impl Plugin for MachinesPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let slot: Slot = Arc::new(OnceLock::new());
        let ssh: Arc<dyn Transport> = Arc::new(ssh::SshTransport { ctx: s.ctx(), version: VERSION.to_owned() });
        s.contribute(&TRANSPORT, ssh);
        let lo: Arc<dyn Transport> = Arc::new(LoopbackTransport);
        s.contribute(&TRANSPORT, lo);
        commands::register(s, &slot);
        proxy::register(s, &slot);
        let svc: Arc<dyn wisp_machines_api::MachinesService> = Arc::new(service::Service(slot.clone()));
        s.provide::<Peers>(svc);
        s.on_start(move |ctx| async move {
            let store = ctx.service::<Store>()?.as_ref().clone();
            store::install(&store).map_err(WireError::from)?;
            let loaded = store::load(&store).await.map_err(WireError::from)?;
            let st = State::new(ctx, store, loaded);
            let _ = slot.set(st.clone());
            manager::start_all(&st);
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(MachinesPlugin.manifest().id, "wisp.machines");
    }
}
