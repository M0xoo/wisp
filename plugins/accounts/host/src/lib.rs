//! wisp.accounts: several accounts per harness, signing in, the harness watch.
//!
//! The plugin is registered and its manifest checked; its commands, routes and migrations are registered here as they are ported. Until then it adds nothing to the
//! kernel, so switching it on or off changes nothing else.

use wisp_kernel::{Manifest, Plugin, Result, Setup};

#[derive(Debug, Default)]
pub struct AccountsPlugin;

impl Plugin for AccountsPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, _s: &mut Setup) -> Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(AccountsPlugin.manifest().id, "wisp.accounts");
    }
}
