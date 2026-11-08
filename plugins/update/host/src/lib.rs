//! wisp-update: wisp.update plugin: wiring to the kernel, store and HTTP routes.
//!
//! The plugin is registered and its manifest checked; its commands, routes and migrations are registered here as they are ported. Until then it adds nothing to the
//! kernel, so switching it on or off changes nothing else.

use wisp_kernel::{Manifest, Plugin, Result, Setup};

#[derive(Debug, Default)]
pub struct UpdatePlugin;

impl Plugin for UpdatePlugin {
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
        assert_eq!(UpdatePlugin.manifest().id, "wisp.update");
    }
}
