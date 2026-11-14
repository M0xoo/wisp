//! `plugins.ui` (ADR-0048): what an untrusted plugin shows in the app, for the shell's remote view host. Each of its
//! `contributes.ui` entries whose `component` is a `.js` file in its own folder comes back with that file's text: the
//! app runs it in a Worker inside a sandboxed frame, where it can only send kit descriptors and call wisp as itself.
//! Only plugins that are on, installed by you (`user.`); only where an untrusted UI may show (a Settings pane, a side
//! view, a block renderer, a toolbar button); a module is 256 KB at most and never read from outside its folder.

use serde::{Deserialize, Serialize};
use wisp_kernel::{Ctx, Result};

/// The largest module the app runs.
pub const MAX_MODULE: u64 = 256 * 1024;
/// Where an untrusted UI may show (ADR-0048 §5): `attachTo.id` of its `contributes.ui` entry.
pub const PLACES: [&str; 4] = ["shell.settings", "shell.side", "shell.block", "shell.toolbar"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteUi {
    pub plugin: String,
    pub id: String,
    /// `shell.settings` …
    pub place: String,
    pub title: String,
    pub module: String,
}

/// A module's path inside its plugin's folder (`./ui.js#default` → `ui.js`); and the `contributes.ui` entries an
/// untrusted UI may have. In wisp-plugins-core, so `wisp_plugin_check` reads a plugin exactly as this serves it.
pub use wisp_plugins_core::check::entries;
pub use wisp_plugins_core::module_path;

pub async fn list(ctx: &Ctx) -> Result<Vec<RemoteUi>> {
    let home = ctx.service::<wisp_kernel::services::Paths>()?;
    let on: Vec<String> = ctx.plugins()?.into_iter().filter(|p| p.state != "off" && !p.builtin).map(|p| p.id).collect();
    let mut out = Vec::new();
    for m in ctx.manifests().into_iter().filter(|m| m.id.starts_with("user.") && on.contains(&m.id)) {
        let dir = home.join("plugins").join(crate::install::slug(&m.id));
        for (id, place, title, component) in entries(&m.contributes) {
            let file = dir.join(&component);
            match tokio::fs::metadata(&file).await {
                Ok(meta) if meta.is_file() && meta.len() <= MAX_MODULE => {}
                _ => continue,
            }
            let Ok(module) = tokio::fs::read_to_string(&file).await else { continue };
            let title = if title.is_empty() { m.name.clone().unwrap_or_else(|| m.id.clone()) } else { title };
            out.push(RemoteUi { plugin: m.id.clone(), id, place, title, module });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    #[test]
    fn an_untrusted_ui_is_a_module_in_its_own_folder_shown_only_where_it_may() {
        assert_eq!(module_path("./ui.js#default").as_deref(), Some("ui.js"));
        assert_eq!(module_path("./ui/pane.js#Pane").as_deref(), Some("ui/pane.js"));
        for bad in ["./../x.js#d", "/etc/x.js", "./ui.html#d", "./a\\b.js#d"] {
            assert_eq!(module_path(bad), None, "{bad}");
        }
        let c: std::collections::BTreeMap<String, Value> = [(
            "ui".to_owned(),
            json!([
                { "id": "user.theme.pane", "attachTo": { "id": "shell.settings", "input": "pane" }, "component": "./ui.js#default", "title": "Theme" },
                { "id": "user.theme.frame", "attachTo": { "id": "shell.frame", "input": "main" }, "component": "./ui.js#default" },
                { "id": "user.theme.out", "attachTo": { "id": "shell.settings", "input": "pane" }, "component": "./../../x.js#default" }
            ]),
        )]
        .into_iter()
        .collect();
        let e = entries(&c);
        assert_eq!(
            e,
            vec![("user.theme.pane".into(), "shell.settings".into(), "Theme".into(), "ui.js".into())],
            "not the frame, nothing outside its folder"
        );
    }

    #[test]
    fn the_places_an_untrusted_ui_may_show_are_the_kits_and_its_largest_module_too() {
        let kit = wisp_plugins_core::kit::kit();
        let mut places = PLACES.to_vec();
        places.sort_unstable();
        assert_eq!(kit.places.keys().map(String::as_str).collect::<Vec<_>>(), places, "kit.json places = remote::PLACES");
        assert_eq!(kit.limits.module, MAX_MODULE);
    }
}
