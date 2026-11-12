//! `plugins.ui` (ADR-0048): what an untrusted plugin shows in the app, for the shell's remote view host. Each of its
//! `contributes.ui` entries whose `component` is a `.js` file in its own folder comes back with that file's text: the
//! app runs it in a Worker inside a sandboxed frame, where it can only send kit descriptors and call wisp as itself.
//! Only plugins that are on, installed by you (`user.`); only where an untrusted UI may show (a Settings pane, a side
//! view, a block renderer, a toolbar button); a module is 256 KB at most and never read from outside its folder.

use serde::{Deserialize, Serialize};
use serde_json::Value;
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

/// A module's path inside its plugin's folder, from `component` (`./ui.js#default`, as the manifest checker asks):
/// relative, a `.js` file, no way out. None: not one.
pub fn module_path(component: &str) -> Option<String> {
    let path = component.split('#').next().unwrap_or_default();
    let path = path.strip_prefix("./").unwrap_or(path);
    let p = std::path::Path::new(path);
    let ok = p.extension().is_some_and(|e| e == "js") && !path.starts_with('/') && !path.contains('\\') && p.components().all(|c| matches!(c, std::path::Component::Normal(_)));
    ok.then(|| path.to_owned())
}

/// `(id, place, title, component)` for each entry of a manifest's `contributes.ui` an untrusted UI may have.
pub fn entries(contributes: &std::collections::BTreeMap<String, Value>) -> Vec<(String, String, String, String)> {
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_owned();
    contributes
        .get("ui")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|x| {
            let place = x.get("attachTo").map(|a| s(a, "id")).unwrap_or_default();
            let path = module_path(&s(x, "component"))?;
            PLACES.contains(&place.as_str()).then(|| (s(x, "id"), place, s(x, "title"), path))
        })
        .collect()
}

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
    use serde_json::json;

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
        assert_eq!(e, vec![("user.theme.pane".into(), "shell.settings".into(), "Theme".into(), "ui.js".into())], "not the frame, nothing outside its folder");
    }
}
