//! What an agent writing an untrusted plugin (ADR-0048) reads and runs, through wisp.mcp's tools (ADR-0040; v1's
//! spell tools, gone with spells, ADR-0031): `plugins.agent.list` (`wisp_plugins`), `.schema`
//! (`wisp_plugin_schema`), `.data` (`wisp_plugin_data`) and `.check` (`wisp_plugin_check`). All four only read:
//! `.data` runs a read-only command off an allowlist (`DATA`) as the caller (its own capability set applies, a capped
//! task's too), and
//! `.check` installs nothing and runs nothing of the plugin.

use wisp_kernel::{Call, Caller, CommandInfo, Ctx, Setup};
use wisp_plugins_api::{AgentCheck, AgentData, AgentList, AgentSchema, AgentText};
use wisp_plugins_core::{check, reference, sample, summary};

/// The data sources `wisp_plugin_data` samples: read-only commands with one of these permissions (declared in this
/// plugin's manifest too, since a nested call narrows through it). Not on it, though they only read: what reveals a
/// secret (`runtime:unmasked`, `accounts:read`) or makes a link (`share:make`, `stuff:publish`).
pub const DATA: &[&str] = &[
    "automations:read",
    "budget:read",
    "connectors:list",
    "crew:read",
    "git:diff",
    "git:read",
    "git:status",
    "history:blame",
    "history:list",
    "later:list",
    "machines:list",
    "plugins:read",
    "resources:read",
    "runtime:activity",
    "runtime:agents",
    "runtime:get",
    "runtime:list",
    "runtime:presentation",
    "runtime:sessions",
    "runtime:turns",
    "runtime:usage",
    "settings:read",
    "ship:details",
    "ship:view",
    "stuff:read",
    "workflows:read",
];
/// Never sampled, whatever their permission: an agent's own tools (they answer about the caller's task).
const NOT_DATA: &[&str] = &[".agent."];

/// Every command wisp has, whoever may run it: what a plugin may ask a permission for.
fn all(ctx: &Ctx) -> Vec<CommandInfo> {
    ctx.catalogue(&Caller::kernel())
}

pub(crate) fn register(s: &mut Setup) {
    s.command::<AgentList, _, _>(|ctx, _call, _a| async move {
        let have: Vec<summary::Have> = ctx
            .plugins()?
            .into_iter()
            .map(|p| summary::Have { id: p.id, version: p.version, state: p.state, builtin: p.builtin, reason: p.reason })
            .collect();
        let home = ctx.service::<wisp_kernel::services::Paths>().ok();
        let folder =
            |id: &str| home.as_ref().map(|h| h.join("plugins").join(wisp_plugins_core::slug(id)).display().to_string()).unwrap_or_default();
        Ok(AgentText::text(summary::text(&have, &ctx.manifests(), &folder)))
    });
    s.command::<AgentSchema, _, _>(|ctx, _call, _a| async move { Ok(AgentText::text(reference::reference(&all(&ctx)))) });
    s.command::<AgentData, _, _>(|ctx, call, a| async move {
        Ok(data(&ctx, &call, &a.command, a.args.unwrap_or_else(|| serde_json::json!({}))).await)
    });
    s.command::<AgentCheck, _, _>(
        |ctx, _call, a| async move { Ok(AgentText::text(check::check(&a.manifest, &a.files, &all(&ctx)).text())) },
    );
}

/// `wisp_plugin_data`: only a command that reads, that the caller may run, sampled.
async fn data(ctx: &Ctx, call: &Call, command: &str, args: serde_json::Value) -> AgentText {
    let command = command.trim();
    if command.is_empty() {
        return AgentText::error("command: which command a plugin would call (wisp_plugin_schema lists them), e.g. \"plugins.list\"");
    }
    let Some(cmd) = all(ctx).into_iter().find(|c| c.id == command) else {
        return AgentText::error(format!("{command} isn't a command wisp has (wisp_plugin_schema lists them)"));
    };
    if !cmd.read_only || NOT_DATA.iter().any(|x| cmd.id.contains(x)) {
        return AgentText::error(format!(
            "{command} isn't a data source: wisp_plugin_data runs only commands that read (marked “reads” in wisp_plugin_schema)"
        ));
    }
    if !DATA.iter().any(|g| wisp_kernel::perm::covers(g, &cmd.permission)) || !ctx.may(&cmd.permission) {
        return AgentText::error(format!(
            "{command} (\"{}\") isn't one wisp_plugin_data samples: it reads {}",
            cmd.permission,
            DATA.join(", ")
        ));
    }
    if !ctx.catalogue(call.caller()).iter().any(|c| c.id == cmd.id) {
        return AgentText::error(format!(
            "this task may not run {command}, so it can't sample it (a plugin could, with \"{}\")",
            cmd.permission
        ));
    }
    match ctx.run_json(call, &cmd.id, args).await {
        Ok(v) => AgentText::text(sample::text(&cmd.id, &cmd.permission, &v)),
        Err(e) => AgentText::error(format!("{command} refused: {}", e.message)),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use wisp_kernel::Plugin;

    #[test]
    fn every_data_source_permission_is_one_this_plugin_declares() {
        let m = crate::PluginsPlugin.manifest();
        for g in DATA {
            assert!(m.permissions.iter().any(|p| p == g), "{g} in wisp-plugin.json permissions: a nested call narrows through them");
        }
        for secret in ["runtime:unmasked", "accounts:read", "secrets:read", "share:make", "stuff:publish"] {
            assert!(!DATA.iter().any(|g| wisp_kernel::perm::covers(g, secret)), "{secret} is never sampled");
        }
    }
}
