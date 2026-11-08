//! wisp.copilot: GitHub Copilot CLI as a module of wisp.runtime (`runtime.harness@1`).
//!
//! The plugin is registered and its manifest checked; its harness contribution (`runtime.harness@1`) comes with its parser in `wisp-copilot-core`. Until then it adds nothing to the
//! kernel, so switching it on or off changes nothing else.

use wisp_kernel::{Manifest, Plugin, Result, Setup};

#[derive(Debug, Default)]
pub struct CopilotPlugin;

impl Plugin for CopilotPlugin {
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
        assert_eq!(CopilotPlugin.manifest().id, "wisp.copilot");
    }
}
