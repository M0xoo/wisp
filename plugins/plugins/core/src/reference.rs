//! `wisp_plugin_schema`: the complete reference for writing an untrusted plugin (ADR-0048), made from the real
//! types so it never drifts: the manifest keys the kernel's checker knows (`wisp_kernel::manifest`), the kit an
//! untrusted UI may describe (`packages/shell/src/remote/kit.json`, the shell renderer's own list), the commands wisp has (the
//! catalogue, with the permission each needs) and worked examples that pass `check`.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;
use serde_json::Value;
use wisp_kernel::CommandInfo;
use wisp_kernel::manifest::{ACTIVATIONS, CONTRIBUTES, KEYS, SETTING_TYPES};

use crate::kit::kit;

pub const FIELDS_JSON: &str = include_str!("../data/manifest-fields.json");
pub const EXAMPLES_JSON: &str = include_str!("../data/plugin-examples.json");

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Fields {
    pub keys: BTreeMap<String, String>,
    pub contributes: BTreeMap<String, String>,
}

/// A worked example: what the user asked, the plugin that does it.
#[derive(Debug, Clone, Deserialize)]
pub struct Example {
    pub ask: String,
    pub manifest: Value,
    pub files: BTreeMap<String, String>,
}

static FIELDS: LazyLock<Fields> = LazyLock::new(|| serde_json::from_str(FIELDS_JSON).unwrap_or_default());
static EXAMPLES: LazyLock<Vec<Example>> = LazyLock::new(|| serde_json::from_str(EXAMPLES_JSON).unwrap_or_default());

pub fn fields() -> &'static Fields {
    &FIELDS
}

pub fn examples() -> &'static [Example] {
    &EXAMPLES
}

fn manifest_section() -> String {
    let f = fields();
    let line = |k: &str, doc: Option<&String>| format!("- `{k}`: {}", doc.map_or("", String::as_str));
    let keys = KEYS.iter().map(|k| line(k, f.keys.get(*k))).collect::<Vec<_>>().join("\n");
    let contrib = CONTRIBUTES.iter().map(|k| line(k, f.contributes.get(*k))).collect::<Vec<_>>().join("\n");
    format!(
        "## The manifest: `wisp-plugin.json` in the plugin's folder\n\nUnknown keys are refused (with the one you probably meant).\n\n{keys}\n\n### `contributes`\n\n{contrib}\n\nActivation kinds: {}. Setting types: {}.",
        ACTIVATIONS.iter().map(|a| format!("`{a}`")).collect::<Vec<_>>().join(", "),
        SETTING_TYPES.iter().map(|a| format!("`{a}`")).collect::<Vec<_>>().join(", "),
    )
}

fn kit_section() -> String {
    let k = kit();
    let parents = k.parents.iter().map(|p| format!("`{p}`")).collect::<Vec<_>>().join(", ");
    let comps = k
        .components
        .iter()
        .map(|(name, props)| {
            let p = props.iter().map(|(n, t)| format!("{n}: {}", t.words())).collect::<Vec<_>>().join("; ");
            let kids = if k.parents.contains(name) { " Children: k." } else { "" };
            let ev = k.events.get(name).map(|e| format!(" on: {e}.")).unwrap_or_default();
            format!("- `{name}` {{ {p} }}.{kids}{ev}")
        })
        .collect::<Vec<_>>()
        .join("\n");
    let places = k
        .places
        .iter()
        .map(|(id, p)| format!("- `{id}`: {}{}", p.words, if p.drawn { "" } else { " (allowed; not drawn yet)" }))
        .collect::<Vec<_>>()
        .join("\n");
    let l = &k.limits;
    format!(
        "## The UI module\n\nA `contributes.ui` entry's `component` is a `.js` file in the plugin's folder. It runs in a Worker inside a sandboxed frame: no DOM, no network, no storage, no imports (one file, {} KB at most). Its `wisp` has only:\n\n- `wisp.render(tree)`: draw this descriptor tree (call it again to update; nodes update in place).\n- `wisp.call(command, args)` → Promise: run a wisp command as the plugin itself, checked against its own permissions (never the user's).\n- `wisp.on(event, fn)`: `fn(value)` runs when a node with `on: event` fires.\n\n### Descriptors\n\n`Node = string | {{ c: '<Component>', p?: {{ …props }}, k?: Node[], on?: '<event>' }}`. Text only: no HTML, no `class`, no `style`. Anything not listed here (an unknown component, a prop it doesn't take, a value of the wrong kind) is dropped. A string is drawn as text. Children (`k`) only on {parents}; the others take their text from props. `on` matches `{}`.\n\n{comps}\n\n### Parts, tokens and icons\n\nTokens: the values above are wisp's tokens (`gap` is the space scale, `tone` the colour roles, `size` the type scale); the kit maps them, so the plugin looks like wisp in light and dark. Parts: every component is drawn by the kit with its own `data-part`; an untrusted plugin can't restyle them (`partStyles` never apply to it). Icons: none (a `Button` has a `label`).\n\n### Where it may show (`attachTo.id`)\n\n{places}\n\nLimits: {} characters per text, {} nodes, {} levels, {} items per Select.",
        l.module / 1024,
        l.event,
        l.text,
        l.nodes,
        l.depth,
        l.items,
    )
}

fn commands_section(commands: &[CommandInfo]) -> String {
    let mut by: BTreeMap<&str, Vec<&CommandInfo>> = BTreeMap::new();
    for c in commands.iter().filter(|c| !c.id.contains(".agent.")) {
        by.entry(c.plugin.as_str()).or_default().push(c);
    }
    let body = by
        .iter()
        .map(|(plugin, cs)| {
            let lines = cs
                .iter()
                .map(|c| {
                    let title = c.title.as_deref().map(|t| format!(" {t}")).unwrap_or_default();
                    format!("- `{}`{title} (`{}`{})", c.id, c.permission, if c.read_only { ", reads" } else { "" })
                })
                .collect::<Vec<_>>()
                .join("\n");
            format!("{plugin}:\n{lines}")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!(
        "## Commands it may call\n\n`wisp.call(id, args)` needs the permission in brackets in the manifest's `permissions` (a pattern like `plugins:*` covers several). Prefer the ones that only read. wisp_plugin_data samples a read-only one's real answer.\n\n{body}"
    )
}

fn examples_section() -> String {
    let body = examples()
        .iter()
        .map(|e| {
            let m = serde_json::to_string_pretty(&e.manifest).unwrap_or_default();
            let files = e.files.iter().map(|(p, t)| format!("`{p}`:\n\n```js\n{}\n```", t.trim_end())).collect::<Vec<_>>().join("\n\n");
            format!("### “{}”\n\n`wisp-plugin.json`:\n\n```json\n{m}\n```\n\n{files}", e.ask)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("## Worked examples\n\nEach passes wisp_plugin_check.\n\n{body}")
}

/// The reference. `commands`: the commands wisp has (the catalogue).
pub fn reference(commands: &[CommandInfo]) -> String {
    format!(
        "# Writing a wisp plugin (the untrusted tier)\n\nA plugin is a folder with a `wisp-plugin.json` and, for UI, a `.js` module. Whatever the user installs is untrusted until they trust it: its UI is described with kit components, never drawn by its own code, and every call it makes is checked against its own permissions. Write it in a folder, check it with wisp_plugin_check (pass the manifest and each file's text), then the user installs it from Settings → Plugins (or `wisp plugins install <folder>`) and switches it on.\n\n{}\n\n{}\n\n{}\n\n{}",
        manifest_section(),
        kit_section(),
        commands_section(commands),
        examples_section()
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::panic)]
mod tests {
    use super::*;

    fn cmd(id: &str, permission: &str, read_only: bool) -> CommandInfo {
        CommandInfo {
            id: id.into(),
            plugin: id.split('.').next().unwrap_or_default().into(),
            title: Some(format!("{id} title")),
            read_only,
            permission: permission.into(),
            args: None,
            ui_only: None,
        }
    }

    fn catalogue() -> Vec<CommandInfo> {
        vec![
            cmd("plugins.list", "plugins:read", true),
            cmd("plugins.setEnabled", "plugins:write", false),
            cmd("plugins.agent.list", "plugins:agent.list", true),
        ]
    }

    #[test]
    fn the_reference_explains_every_manifest_key_the_kernel_knows_and_no_other() {
        let f = fields();
        let known: Vec<&str> = KEYS.to_vec();
        let explained: Vec<&str> = f.keys.keys().map(String::as_str).collect();
        let mut sorted = known.clone();
        sorted.sort_unstable();
        assert_eq!(explained, sorted, "manifest-fields.json keys = wisp_kernel::manifest::KEYS");
        let mut c: Vec<&str> = CONTRIBUTES.to_vec();
        c.sort_unstable();
        assert_eq!(f.contributes.keys().map(String::as_str).collect::<Vec<_>>(), c, "contributes = CONTRIBUTES");
        assert!(f.keys.values().chain(f.contributes.values()).all(|d| !d.trim().is_empty()));
        let r = reference(&catalogue());
        for k in KEYS.iter().chain(CONTRIBUTES) {
            assert!(r.contains(&format!("- `{k}`: ")), "{k} in the reference");
        }
    }

    #[test]
    fn the_reference_lists_every_kit_component_its_props_and_where_it_may_show() {
        let k = kit();
        assert_eq!(k.components.len(), 12, "kit.json reads");
        let r = reference(&catalogue());
        for (name, props) in &k.components {
            let line = r.lines().find(|l| l.starts_with(&format!("- `{name}` {{"))).unwrap_or_else(|| panic!("{name}"));
            for p in props.keys() {
                assert!(line.contains(&format!("{p}: ")), "{name}.{p}: {line}");
            }
        }
        assert!(r.contains("- `Button` { disabled: bool; label: string; size: 'xs' | 'sm' | 'md' | 'lg'; variant: 'primary' | 'secondary' | 'ghost' | 'danger' }. on: a click (no value)."), "{r}");
        for place in k.places.keys() {
            assert!(r.contains(&format!("- `{place}`: ")), "{place}");
        }
        for a in &k.api {
            assert!(r.contains(&format!("`wisp.{a}(")), "wisp.{a}");
        }
    }

    #[test]
    fn the_reference_lists_the_commands_with_the_permission_each_needs_but_not_agent_ones() {
        let r = reference(&catalogue());
        assert!(r.contains("- `plugins.list` plugins.list title (`plugins:read`, reads)"), "{r}");
        assert!(r.contains("- `plugins.setEnabled` plugins.setEnabled title (`plugins:write`)"), "{r}");
        assert!(!r.contains("plugins.agent.list"), "an agent's own commands aren't a plugin's");
    }

    #[test]
    fn every_worked_example_passes_the_check() {
        assert!(examples().len() >= 3, "data/plugin-examples.json reads");
        let r = reference(&catalogue());
        for e in examples() {
            let rep = crate::check::check(&e.manifest, &e.files, &catalogue());
            assert!(rep.ok, "“{}”: {}", e.ask, rep.text());
            assert!(r.contains(&format!("### “{}”", e.ask)), "{} in the reference", e.ask);
        }
    }
}
