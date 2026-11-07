//! What a *Make a plugin* agent is told (plan §6.0.3 rule 4: one agent where v1 had *Cast a spell* and
//! *Make a pane*): v1 server/spell-guide.js and server/pane-guide.js in one guide. The reference comes
//! from the same tables the checker uses, and the pane half from wisp.stuff's pane rules, so neither
//! drifts from what wisp accepts. The agent's tools and report block keep their v1 names
//! (`wisp_spell_*`, the `spell` block): agents and released clients read them.
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use wisp_stuff_api::pane::{CALL_DOCS, MAX_PANES, PANE_CALLS, PANE_USES, PANE_WRITES_PER_MIN};

use crate::schema::{pairs_json, schema};
use crate::vocab::Vocab;

/// A worked example: what the user asked, and a spell that does it (each one checks: a test).
#[derive(Debug, Clone, Deserialize)]
pub struct Example {
    pub ask: String,
    pub spell: Value,
}

#[derive(Debug, Deserialize)]
struct Fields {
    format: String,
    fields: Vec<(String, String)>,
    templates: String,
}

pub const EXAMPLES_JSON: &str = include_str!("../data/examples.json");
const FIELDS_JSON: &str = include_str!("../data/fields.json");

pub fn examples() -> &'static [Example] {
    static E: OnceLock<Vec<Example>> = OnceLock::new();
    E.get_or_init(|| serde_json::from_str(EXAMPLES_JSON).unwrap_or_default())
}

fn fields() -> &'static Fields {
    static F: OnceLock<Fields> = OnceLock::new();
    F.get_or_init(|| serde_json::from_str(FIELDS_JSON).unwrap_or(Fields { format: String::new(), fields: Vec::new(), templates: String::new() }))
}

fn types(v: &[(String, Vec<(String, wisp_plugins_api::PropType)>)]) -> Value {
    Value::Object(v.iter().map(|(p, props)| (p.clone(), Value::Object(props.iter().map(|(k, t)| (k.clone(), json!(t))).collect()))).collect())
}

/// The full reference, as JSON (the `wisp_spell_schema` tool).
pub fn spell_reference(v: &Vocab) -> Value {
    let s = schema();
    let f = fields();
    let gh: Map<String, Value> = s.gh_read.iter().map(|(k, x)| (k.clone(), x.as_ref().map_or_else(|| json!("GET only"), |l| json!(l)))).collect();
    json!({
        "format": f.format,
        "fields": pairs_json(&f.fields),
        "templates": f.templates,
        "slots": pairs_json(&v.slots),
        "parts": v.parts,
        "partProps": types(&v.part_props),
        "cardHeadOrder": s.card_head_order,
        "styleProps": s.style_props,
        "tokens": v.tokens,
        "icons": v.icons,
        "actions": Value::Object(s.actions.iter().map(|(k, _, doc)| (k.clone(), json!(doc))).collect()),
        "settings": Value::Object(v.settings.iter().map(|(k, t)| (k.clone(), json!(t))).collect()),
        "wispData": s.wisp_data,
        "ghReadOnly": gh,
        "examples": examples().iter().map(|e| json!({ "ask": e.ask, "spell": e.spell })).collect::<Vec<_>>(),
    })
}

/// The smallest whole pane: its wisp-app.json passes wisp.stuff's `uses_of` (a test).
pub const PANE_ASK: &str = "A pane with a count of my running tasks";
pub const PANE_MANIFEST: &str = r#"{
  "name": "Running now",
  "description": "How many of your tasks are running.",
  "uses": [
    "tasks:read"
  ]
}"#;
pub const PANE_HTML: &str = r#"<!doctype html>
<meta charset="utf-8">
<title>Running now</title>
<link rel="stylesheet" href="/_wisp/pane.css">
<script src="/_wisp/pane.js"></script>
<div class="card"><b id="count">…</b> <span class="muted">running</span></div>
<p class="muted" id="note"></p>
<script>
  const paint = (tasks) => {
    document.getElementById('count').textContent = tasks.filter((t) => t.state === 'running').length;
  };
  // Refused until the user allows tasks:read from the pane's bar: say so, and wait.
  wisp.tasks.list().then((tasks) => {
    paint(tasks);
    wisp.on('tasks', paint);
  }, (err) => {
    document.getElementById('note').textContent = err.message;
  });
</script>
"#;

/// The pane half of the reference: everything a pane can touch (v1 paneReference).
pub fn pane_reference() -> String {
    let scopes = PANE_USES.iter().map(|(k, w)| format!("- `{k}`: {w}")).collect::<Vec<_>>().join("\n");
    let calls = PANE_CALLS
        .iter()
        .filter_map(|(m, need)| CALL_DOCS.iter().find(|(c, _, _)| c == m).map(|(_, call, ret)| format!("- `{call}` (needs `{need}`) → {ret}")))
        .collect::<Vec<_>>()
        .join("\n");
    include_str!("../data/pane-reference.md").replace("{scopes}", &scopes).replace("{calls}", &calls).replace("{writes}", &PANE_WRITES_PER_MIN.to_string()).replace("{max}", &MAX_PANES.to_string())
}

/// The system-prompt section for a Make a plugin task. `tool`: how this harness names wisp's ask tool.
pub fn make_guide(tool: &str) -> String {
    let t = |name: &str| tool.strip_suffix("ask_user").map_or_else(|| tool.to_owned(), |p| format!("{p}{name}"));
    include_str!("../data/make-guide.md")
        .replace("{schema}", &t("wisp_spell_schema"))
        .replace("{spells}", &t("wisp_spells"))
        .replace("{data}", &t("wisp_spell_data"))
        .replace("{check}", &t("wisp_spell_check"))
        .replace("{ask}", tool)
        .replace("{pane_reference}", &pane_reference())
        .replace("{pane_ask}", PANE_ASK)
        .replace("{pane_manifest}", PANE_MANIFEST)
        .replace("{pane_html}", PANE_HTML)
}

pub const DEFAULT_TOOL: &str = "mcp__wisp__ask_user";
