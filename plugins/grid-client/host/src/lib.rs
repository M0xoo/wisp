//! wisp.grid-client (plan §7.2.2, ADR-0010, 0038, 0041): wisp and a wisp Grid.
//!
//! - **Sign in** (`signin.rs`): RFC 8628's device flow; the token in secrets; the cloud box as a machine.
//! - **Transports** (`transport.rs`): `grid` (a cloud box: watched without waking, woken by real use) and
//!   `grid-tunnel` (another of your computers, through the tunnel it holds), for wisp.machines.
//! - **This computer** (`computer.rs`): `wisp computer on|off|status`, the tunnel it holds open, redials.
//! - **wisp Cloud** (`cloud.rs`): the `wisp-cloud` share destination, my shares, fetching links, imports
//!   and "update available".
//!
//! It reaches other plugins only through their api crates and commands (machines.*, share.destination@1).
//! The grid's HTTP goes through its own client (`net.rs`, as wisp.machines does): it streams (the sync
//! stream through a box) and upgrades (the tunnel), which the kernel's whole-body net service doesn't.
//!
//! resources: data-only (the account signed in to and what was imported: a sign-in is the device flow,
//! never declared in a formula; a box or computer as code is wisp.machine's `machine` kind (ADR-0028)).

// `Failing<T>` is the transport contract's result (machines-api): a failure carries its hint; rare, never hot
#![allow(clippy::result_large_err)]

mod cloud;
pub mod computer;
mod net;
mod peers;
mod signin;
mod state;
mod transport;

use std::sync::{Arc, OnceLock};

use wisp_grid_client_api as api;
use wisp_kernel::{Manifest, Plugin, Result, Setup, WireError};
use wisp_machines_api::{TRANSPORT, Transport};
use wisp_share_api::{DESTINATION, ShareDestination};
use wisp_store::Store;

pub use state::St;

type Slot = Arc<OnceLock<Arc<St>>>;

fn st(slot: &Slot) -> Result<Arc<St>> {
    slot.get().cloned().ok_or_else(|| WireError::unavailable("wisp.grid-client is starting"))
}

/// A destination that waits for the plugin to start.
struct LazyCloud(Slot);

impl ShareDestination for LazyCloud {
    fn id(&self) -> &'static str {
        "wisp-cloud"
    }
    fn label(&self) -> &'static str {
        "wisp Cloud"
    }
    fn ready(&self) -> wisp_kernel::BoxFuture<'static, std::result::Result<(), String>> {
        match self.0.get() {
            Some(s) => cloud::Cloud(s.clone()).ready(),
            None => Box::pin(async { Err("wisp Cloud is starting".to_owned()) }),
        }
    }
    fn send(&self, out: wisp_share_api::Outgoing) -> wisp_kernel::BoxFuture<'static, Result<serde_json::Value>> {
        match self.0.get() {
            Some(s) => cloud::Cloud(s.clone()).send(out),
            None => Box::pin(async { Err(WireError::unavailable("wisp Cloud is starting")) }),
        }
    }
}

#[derive(Debug, Default)]
pub struct GridClientPlugin;

macro_rules! on {
    ($s:expr, $slot:expr, $cmd:ty, |$st:ident, $a:ident| $body:expr) => {{
        let slot = $slot.clone();
        $s.command::<$cmd, _, _>(move |_ctx, _call, $a| {
            let slot = slot.clone();
            async move {
                let $st = st(&slot)?;
                $body.await
            }
        });
    }};
}

impl Plugin for GridClientPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let slot: Slot = Arc::new(OnceLock::new());
        let client = net::client(false);
        for tunnel in [false, true] {
            let t: Arc<dyn Transport> = Arc::new(transport::GridTransport { tunnel, client: client.clone() });
            s.contribute(&TRANSPORT, t);
        }
        let d: Arc<dyn ShareDestination> = Arc::new(LazyCloud(slot.clone()));
        s.contribute(&DESTINATION, d);
        on!(s, slot, api::SignInCmd, |st, a| signin::start(&st, &a));
        on!(s, slot, api::SignInGet, |st, a| async move { signin::get(&st, &a.id) });
        on!(s, slot, api::SignInCancel, |st, a| async move { signin::cancel(&st, &a.id) });
        on!(s, slot, api::StatusCmd, |st, _a| async move { Ok(status(&st)) });
        on!(s, slot, api::SignOut, |st, _a| async move {
            signin::sign_out(&st).await?;
            Ok(status(&st))
        });
        on!(s, slot, api::Computer, |st, a| computer::set(&st, a.on, a.name));
        on!(s, slot, api::Shares, |st, _a| async move { cloud::mine(&st).await });
        on!(s, slot, api::Access, |st, a| async move { cloud::access(&st, &a).await });
        on!(s, slot, api::Revoke, |st, a| async move { cloud::revoke(&st, &a.id).await });
        on!(s, slot, api::Fetch, |st, a| async move { cloud::fetch(&st, &a.link, a.password.as_deref()).await });
        on!(s, slot, api::Imported, |st, a| async move { cloud::imported(&st, &a.link, a.version).await });
        on!(s, slot, api::Updates, |st, _a| async move { cloud::updates(&st).await });
        s.on_start(move |ctx| async move {
            let store = ctx.service::<Store>()?.as_ref().clone();
            state::install(&store).map_err(|e| WireError::internal(e.to_string()))?;
            let st = St::load(ctx, store).await?;
            let _ = slot.set(st.clone());
            computer::resume(&st).await;
            let st2 = st.clone();
            st.ctx.spawn(async move {
                let _ = peers::sync_computers(&st2).await;
            });
            Ok(())
        });
        Ok(())
    }
}

fn status(st: &St) -> api::Status {
    let a = st.account();
    api::Status { signed_in: a.is_some(), grid: a.as_ref().map(|a| a.grid.clone()).unwrap_or_default(), handle: a.as_ref().map(|a| a.handle.clone()).unwrap_or_default(), machine: a.map(|a| a.machine).unwrap_or_default(), computer: computer::view(st) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(GridClientPlugin.manifest().id, api::PLUGIN);
    }
}
