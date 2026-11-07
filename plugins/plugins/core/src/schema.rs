//! What a v1 spell may hold, as v1's web/js/spell-schema.js said it (`data/v1-schema.json`, generated
//! from it). "spell" stays in these names on purpose: this is the compat path. The UI vocabulary
//! (slots, parts, props, tokens, icons, settings) is merged with what plugins contribute in `vocab`.
use std::collections::HashSet;
use std::sync::OnceLock;

use serde::Deserialize;
use serde_json::Value;
use wisp_plugins_api::{PropType, Risk};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schema {
    pub spell_version: u32,
    pub slots: Vec<(String, String)>,
    pub card_slots: Vec<String>,
    pub button_slots: Vec<String>,
    pub chip_slots: Vec<String>,
    pub themes: Vec<String>,
    pub answer_box: Vec<String>,
    pub card_head_order: Vec<String>,
    pub part_props: Vec<(String, Vec<(String, PropType)>)>,
    pub prop_range: PropRange,
    pub style_props: Vec<String>,
    pub tokens: Vec<String>,
    pub icons: Vec<String>,
    /// name, kind (safe/acts/reads/runs), doc
    pub actions: Vec<(String, String, String)>,
    pub events: Vec<(String, String)>,
    pub hook_if: Vec<String>,
    pub hook_actions: Vec<String>,
    pub settings: Vec<(String, PropType)>,
    pub wisp_data: Vec<String>,
    pub gh_read: Vec<(String, Option<Vec<String>>)>,
    pub builtin_blocks: Vec<String>,
    pub builtin_slash: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct PropRange {
    pub int: (i64, i64),
    pub px: (i64, i64),
}

/// One row of the parts compatibility table (`data/v1-parts.json`).
#[derive(Debug, Clone, Deserialize)]
pub struct PartRow {
    /// the name v1 spells use
    pub v1: String,
    /// the v2 `data-part` it maps to
    pub part: String,
    /// v1's CSS selector, for the record (v2 markup has none of it)
    pub selector: String,
}

#[derive(Debug, Deserialize)]
struct PartsFile {
    parts: Vec<PartRow>,
}

pub const V1_SCHEMA_JSON: &str = include_str!("../data/v1-schema.json");
/// The parts compatibility table as JSON: the UI reads the same file.
pub const V1_PARTS_JSON: &str = include_str!("../data/v1-parts.json");

/// The v1 tables. The files are checked in and tested, so a parse failure is a build bug: it yields
/// empty tables (every spell refused) rather than a panic.
pub fn schema() -> &'static Schema {
    static S: OnceLock<Schema> = OnceLock::new();
    S.get_or_init(|| serde_json::from_str(V1_SCHEMA_JSON).unwrap_or_else(|_| empty_schema()))
}

fn empty_schema() -> Schema {
    Schema {
        spell_version: 1,
        slots: vec![],
        card_slots: vec![],
        button_slots: vec![],
        chip_slots: vec![],
        themes: vec![],
        answer_box: vec![],
        card_head_order: vec![],
        part_props: vec![],
        prop_range: PropRange { int: (1, 40), px: (160, 1600) },
        style_props: vec![],
        tokens: vec![],
        icons: vec![],
        actions: vec![],
        events: vec![],
        hook_if: vec![],
        hook_actions: vec![],
        settings: vec![],
        wisp_data: vec![],
        gh_read: vec![],
        builtin_blocks: vec![],
        builtin_slash: vec![],
    }
}

/// The parts compatibility table: v1 part names → data-part names, in v1's order.
pub fn v1_parts() -> &'static [PartRow] {
    static P: OnceLock<Vec<PartRow>> = OnceLock::new();
    P.get_or_init(|| serde_json::from_str::<PartsFile>(V1_PARTS_JSON).map(|f| f.parts).unwrap_or_default())
}

/// The data-part a v1 part name maps to.
pub fn data_part(v1: &str) -> Option<&'static str> {
    v1_parts().iter().find(|r| r.v1 == v1).map(|r| r.part.as_str())
}

impl Schema {
    pub fn action(&self, k: &str) -> Option<(Risk, &str)> {
        self.actions.iter().find(|(n, _, _)| n == k).map(|(_, kind, doc)| (Risk::parse(kind).unwrap_or_default(), doc.as_str()))
    }
    pub fn action_names(&self) -> Vec<&str> {
        self.actions.iter().map(|(n, _, _)| n.as_str()).collect()
    }
    pub fn event_names(&self) -> Vec<&str> {
        self.events.iter().map(|(n, _)| n.as_str()).collect()
    }
    pub fn is_event(&self, k: &str) -> bool {
        self.events.iter().any(|(n, _)| n == k)
    }
    pub fn gh(&self, cmd: &str) -> Option<&Option<Vec<String>>> {
        self.gh_read.iter().find(|(c, _)| c == cmd).map(|(_, s)| s)
    }
    pub fn hook_action_set(&self) -> HashSet<&str> {
        self.hook_actions.iter().map(String::as_str).collect()
    }
    pub fn range(&self, t: &str) -> Option<(i64, i64)> {
        match t {
            "int" => Some(self.prop_range.int),
            "px" => Some(self.prop_range.px),
            _ => None,
        }
    }
}

/// JSON of a v1 table, in its order, for the agent's reference.
pub fn pairs_json(v: &[(String, String)]) -> Value {
    Value::Object(v.iter().map(|(k, d)| (k.clone(), Value::from(d.as_str()))).collect())
}
