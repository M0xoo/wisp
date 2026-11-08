//! wisp.grok: Grok CLI as a module of wisp.runtime (`runtime.harness@1`).
//!
//! The plugin is registered and its manifest checked; its harness contribution (`runtime.harness@1`) comes with its parser in `wisp-grok-core`. Until then it adds nothing to the
//! kernel, so switching it on or off changes nothing else.

use wisp_kernel::{Manifest, Plugin, Result, Setup};

#[derive(Debug, Default)]
pub struct GrokPlugin;

impl Plugin for GrokPlugin {
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
        assert_eq!(GrokPlugin.manifest().id, "wisp.grok");
    }
}
