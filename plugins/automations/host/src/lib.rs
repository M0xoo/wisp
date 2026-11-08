//! wisp.automations host (triggers, watchers, recipes, cron schedules, inbound webhooks).
//!
//! The plugin is registered and its manifest checked; its commands, routes and migrations are registered here as they are ported. Until then it adds nothing to the
//! kernel, so switching it on or off changes nothing else.

use wisp_kernel::{Manifest, Plugin, Result, Setup};

#[derive(Debug, Default)]
pub struct AutomationsPlugin;

impl Plugin for AutomationsPlugin {
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
        assert_eq!(AutomationsPlugin.manifest().id, "wisp.automations");
    }
}
