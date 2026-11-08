//! wisp.machine: This Mac. The plugin wires `this_mac` (sampling, the load guard, the routes of v1
//! routes/machine.js), `hold` (the before:run limit guard) and `watch` (GET /sessions/:id/watch) to the
//! kernel, the proc service and HTTP.

mod kinds;
mod hold;
mod this_mac;
mod watch;

use wisp_kernel::{Manifest, Plugin, Result, Setup};

#[derive(Debug, Default)]
pub struct MachinePlugin;

impl Plugin for MachinePlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        crate::kinds::register(s);
        this_mac::setup(s);
        hold::setup(s);
        watch::setup(s);
        Ok(())
    }
}
