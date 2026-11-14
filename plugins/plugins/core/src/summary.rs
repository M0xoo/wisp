//! The plugins the user has, in plain words (`wisp_plugins`): theirs first, each with what it does, where it shows,
//! what it may do and its whole manifest (to change one, an agent starts from it); then wisp's own, one line each.

use std::fmt::Write as _;

use serde_json::Value;
use wisp_kernel::Manifest;

use crate::kit::kit;

/// One plugin as the kernel has it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Have {
    pub id: String,
    pub version: String,
    /// active | resolved | off | refused
    pub state: String,
    pub builtin: bool,
    pub reason: Option<String>,
}

/// Where its UI shows, in words: `a pane in Settings → Advanced (“Theme”)`.
fn shows(m: &Manifest) -> Vec<String> {
    m.ui()
        .iter()
        .map(|u| {
            let place = kit().place_words(&u.attach_to.id).map_or_else(|| u.attach_to.id.clone(), str::to_owned);
            let title = m.contributes.get("ui").and_then(Value::as_array).into_iter().flatten().find_map(|x| {
                (x.get("id").and_then(Value::as_str) == Some(u.id.as_str())).then(|| x.get("title").and_then(Value::as_str)).flatten()
            });
            title.map_or(place.clone(), |t| format!("{place} (“{t}”)"))
        })
        .collect()
}

fn state_words(h: &Have, m: Option<&Manifest>) -> String {
    let on = match h.state.as_str() {
        "off" => "off".to_owned(),
        "refused" => format!("refused: {}", h.reason.as_deref().unwrap_or("it didn't load")),
        _ => "on".to_owned(),
    };
    if h.builtin {
        return on;
    }
    let trust = m.and_then(|m| m.trust.as_deref()).unwrap_or("untrusted");
    format!("{on}, {trust}")
}

/// One of the user's plugins, in full.
pub fn yours(h: &Have, m: Option<&Manifest>, folder: &str) -> String {
    let name = m.and_then(|m| m.name.clone()).unwrap_or_else(|| h.id.clone());
    let mut out = format!("- **{name}** ({} {}): {}.", h.id, h.version, state_words(h, m));
    let Some(m) = m else { return out };
    if let Some(d) = m.description.as_deref() {
        let _ = write!(out, " {d}");
    }
    let shows = shows(m);
    if !shows.is_empty() {
        let _ = write!(out, " Shows {}.", shows.join(", "));
    }
    if let Some(exec) = m.exec() {
        let _ = write!(out, " Runs its own process: `{}`.", exec.join(" "));
    }
    out.push_str(
        if m.permissions.is_empty() {
            " Asks for no permissions.".into()
        } else {
            format!(" May: {}.", m.permissions.iter().map(|p| format!("`{p}`")).collect::<Vec<_>>().join(", "))
        }
        .as_str(),
    );
    let _ = write!(out, " Folder: {folder}");
    let json = serde_json::to_string_pretty(m).unwrap_or_default();
    let _ = write!(out, "\n\n  ```json\n{}\n  ```", json.lines().map(|l| format!("  {l}")).collect::<Vec<_>>().join("\n"));
    out
}

/// A built-in, in one line.
pub fn builtin(h: &Have, m: Option<&Manifest>) -> String {
    let name = m.and_then(|m| m.name.clone()).unwrap_or_else(|| h.id.clone());
    let desc = m.and_then(|m| m.description.clone()).map(|d| format!(" {d}")).unwrap_or_default();
    format!("- **{name}** ({}): {}.{desc}", h.id, state_words(h, None))
}

/// The tool's answer. `folder`: where a plugin of the user's lives, by id.
pub fn text(have: &[Have], manifests: &[Manifest], folder: &dyn Fn(&str) -> String) -> String {
    let man = |id: &str| manifests.iter().find(|m| m.id == id);
    let (builtins, theirs): (Vec<&Have>, Vec<&Have>) = have.iter().partition(|h| h.builtin);
    let mut out = if theirs.is_empty() {
        "The user has no plugins of their own yet: write one with wisp_plugin_schema, check it with wisp_plugin_check, and they install it from Settings → Plugins (or `wisp plugins install <folder>`).".to_owned()
    } else {
        let list = theirs.iter().map(|h| yours(h, man(&h.id), &folder(&h.id))).collect::<Vec<_>>().join("\n\n");
        format!("The user's own plugins ({}), untrusted unless they trusted one:\n\n{list}", theirs.len())
    };
    if !builtins.is_empty() {
        let list = builtins.iter().map(|h| builtin(h, man(&h.id))).collect::<Vec<_>>().join("\n");
        let _ = write!(out, "\n\nwisp's own ({}, built in; a plugin of the user's can't take their ids):\n{list}", builtins.len());
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;
    use serde_json::json;

    fn have(id: &str, state: &str, builtin: bool) -> Have {
        Have { id: id.into(), version: "1.0.0".into(), state: state.into(), builtin, reason: None }
    }

    #[test]
    fn the_plugins_list_puts_the_users_own_first_in_full_and_wisps_in_a_line() {
        let mine = Manifest::from_value(json!({
            "wispPlugin": 1, "id": "user.theme", "name": "Theme", "version": "1.0.0", "api": "^1", "description": "My colours.",
            "permissions": ["plugins:read"], "trust": "untrusted",
            "contributes": { "ui": [{ "id": "user.theme.pane", "attachTo": { "id": "shell.settings", "input": "pane" }, "component": "./ui.js#default", "title": "Theme" }] }
        }))
        .unwrap();
        let own = Manifest::from_value(json!({ "wispPlugin": 1, "id": "wisp.plugins", "name": "Plugins", "version": "2.0.0", "api": "^1", "description": "The plugin manager" })).unwrap();
        let t = text(&[have("wisp.plugins", "active", true), have("user.theme", "off", false)], &[own, mine], &|id| {
            format!("/h/plugins/{}", crate::slug(id))
        });
        let (yours, wisps) = t.split_once("wisp's own").unwrap();
        assert!(yours.contains("- **Theme** (user.theme 1.0.0): off, untrusted. My colours."), "{t}");
        assert!(yours.contains("Shows a pane in Settings → Advanced (“Theme”)") && yours.contains("May: `plugins:read`."), "{t}");
        assert!(yours.contains("Folder: /h/plugins/theme") && yours.contains("\"wispPlugin\": 1"), "its manifest in full: {t}");
        assert!(wisps.contains("- **Plugins** (wisp.plugins): on. The plugin manager"), "{t}");
        let none = text(&[have("wisp.plugins", "active", true)], &[], &|_| String::new());
        assert!(none.starts_with("The user has no plugins of their own yet"), "{none}");
    }
}
