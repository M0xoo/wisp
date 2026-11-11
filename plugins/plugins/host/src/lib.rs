//! wisp-plugins: the plugin manager. `plugins.list` (what the kernel has, and each one's state) and
//! `plugins.setEnabled` (the kernel switches it on or off, and everything it registered with it); the
//! `plugin` resource kind (ADR-0028) does the same from a formula, on apply and at start.

mod install;
mod kinds;

pub use install::{UserPlugin, at_start as user_plugins, read as read_plugin};

use wisp_kernel::{Ctx, Manifest, Plugin, PluginStatus, Result, Setup, WireError};
use wisp_plugins_api::{List, PluginRow, SetEnabled};

/// `plugins.install` (ADR-0046): a folder or a git URL into `~/.wisp/plugins`, added off.
#[derive(Debug)]
pub struct Install;
impl wisp_kernel::Command for Install {
    const ID: &'static str = "plugins.install";
    const PERMISSION: Option<&'static str> = Some(wisp_plugins_api::perm::WRITE);
    type Args = install::InstallArgs;
    type Out = install::Installed;
}

/// `plugins.uninstall` (ADR-0046): a `user.` plugin off, out, and its folder gone.
#[derive(Debug)]
pub struct Uninstall;
impl wisp_kernel::Command for Uninstall {
    const ID: &'static str = "plugins.uninstall";
    const PERMISSION: Option<&'static str> = Some(wisp_plugins_api::perm::WRITE);
    type Args = install::UninstallArgs;
    type Out = serde_json::Value;
}

/// `plugins.trust` (ADR-0048): a plugin of yours trusted, or back to untrusted.
#[derive(Debug)]
pub struct Trust;
impl wisp_kernel::Command for Trust {
    const ID: &'static str = "plugins.trust";
    const PERMISSION: Option<&'static str> = Some(wisp_plugins_api::perm::WRITE);
    type Args = install::TrustArgs;
    type Out = serde_json::Value;
}

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
        let kind = crate::kinds::register(s);
        s.command::<SetEnabled, _, _>(move |ctx, call, a| {
            let kind = kind.clone();
            async move {
                ctx.set_plugin_enabled(&a.id, a.enabled).await?;
                // kept so it comes back that way; a store that can't keep it doesn't undo the switch
                if let Err(e) = crate::kinds::remember(&kind, &call, &a.id, a.enabled).await {
                    tracing::warn!(plugin = %a.id, "its switch isn't kept: {}", e.message);
                }
                find(&ctx, &a.id)
            }
        });
        // ADR-0046: a user's plugin from a folder or a git URL, and taking one out
        s.command::<Install, _, _>(|ctx, _call, a| async move { install::install(&ctx, &a).await });
        s.command::<Uninstall, _, _>(|ctx, _call, a| async move { install::uninstall(&ctx, &a).await });
        s.command::<Trust, _, _>(|ctx, _call, a| async move { install::trust(&ctx, &a).await });
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
