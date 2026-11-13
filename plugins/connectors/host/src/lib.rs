//! wisp.connectors: the MCP servers agents get. `kinds`: the `connector` resource kind and what runs get
//! (`runtime.run@1`); `pane`: Settings → Connectors' commands, rows and the sign-in callback.

mod agent;
mod call;
mod kinds;
mod pane;

use wisp_kernel::{Manifest, Plugin, Result, Setup};

#[derive(Debug, Default)]
pub struct ConnectorsPlugin;

impl Plugin for ConnectorsPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let (stored, kind) = crate::kinds::register(s);
        crate::call::register(s, stored.clone());
        crate::pane::register(s, stored, kind);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(ConnectorsPlugin.manifest().id, "wisp.connectors");
    }
}
