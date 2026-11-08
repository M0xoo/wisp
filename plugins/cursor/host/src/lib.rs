//! wisp.cursor: Cursor as a module of wisp.runtime (`runtime.harness@1`).
//!
//! The plugin is registered and its manifest checked; its harness contribution (`runtime.harness@1`) comes with its parser in `wisp-cursor-core`. Until then it adds nothing to the
//! kernel, so switching it on or off changes nothing else.

use wisp_kernel::{Manifest, Plugin, Result, Setup};

#[derive(Debug, Default)]
pub struct CursorPlugin;

impl Plugin for CursorPlugin {
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
        assert_eq!(CursorPlugin.manifest().id, "wisp.cursor");
    }
}
