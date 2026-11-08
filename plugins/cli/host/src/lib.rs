//! wisp.cli host: what the command-line frontend needs from the server, which is one read. The verbs,
//! flags, help, completions and block renderers live in the client (`wisp-cli-core`), built from
//! `cli.catalogue`: the commands the caller's capability set lets it run, with each one's manifest title
//! and argument type. A plugin someone installs gets its CLI verbs with no work of its own.

use wisp_cli_api::Catalogue;
use wisp_kernel::{Manifest, Plugin, Result, Setup};

pub use wisp_cli_api::PLUGIN_ID;

#[derive(Debug, Default)]
pub struct CliPlugin;

impl Plugin for CliPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<Catalogue, _, _>(|ctx, call, _args| {
            let out = ctx.catalogue(call.caller());
            async move { Ok(out) }
        });
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(CliPlugin.manifest().id, PLUGIN_ID);
    }
}
