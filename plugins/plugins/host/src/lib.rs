//! wisp-plugins: the plugin manager. `plugins.list` (what the kernel has, and each one's state) and
//! `plugins.setEnabled` (the kernel switches it on or off, and everything it registered with it); the
//! `plugin` resource kind (ADR-0028) does the same from a formula, on apply and at start.

mod kinds;

use wisp_kernel::{Ctx, Manifest, Plugin, PluginStatus, Result, Setup, WireError};
use wisp_plugins_api::{List, PluginRow, SetEnabled};

#[derive(Debug, Default)]
pub struct PluginsPlugin;

fn row(p: PluginStatus) -> PluginRow {
    PluginRow { enabled: p.state != "off", id: p.id, version: p.version, state: p.state, builtin: p.builtin, reason: p.reason }
}

pub(crate) fn find(ctx: &Ctx, id: &str) -> Result<PluginRow> {
    ctx.plugins()?.into_iter().find(|p| p.id == id).map(row).ok_or_else(|| WireError::not_found(format!("no plugin {id}")))
}

impl Plugin for PluginsPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<List, _, _>(|ctx, _call, _args| async move { Ok(ctx.plugins()?.into_iter().map(row).collect()) });
        s.command::<SetEnabled, _, _>(|ctx, _call, a| async move {
            ctx.set_plugin_enabled(&a.id, a.enabled).await?;
            find(&ctx, &a.id)
        });
        crate::kinds::register(s);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        let m = PluginsPlugin.manifest();
        assert_eq!(m.id, "wisp.plugins");
        assert!(m.validate().is_ok());
    }
}
