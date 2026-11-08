//! wisp-plugins: wisp.plugins plugin: wiring to the kernel, store and HTTP routes.
//!
//! The plugin is registered and its manifest checked; its commands, routes and migrations are registered here as they are ported. Until then it adds nothing to the
//! kernel, so switching it on or off changes nothing else.

mod kinds;

use wisp_kernel::{Manifest, Plugin, Result, Setup};

#[derive(Debug, Default)]
pub struct PluginsPlugin;

impl Plugin for PluginsPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        crate::kinds::register(s);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(PluginsPlugin.manifest().id, "wisp.plugins");
    }
}
