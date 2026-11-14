//! The kit an untrusted UI may describe (ADR-0048 §3): `packages/shell/src/remote/kit.json`, beside the shell's
//! descriptor renderer that draws it (packages/shell/test/remote-kit.test.ts holds them equal), read once.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use serde::Deserialize;

pub const KIT_JSON: &str = include_str!("../../../../packages/shell/src/remote/kit.json");

/// One prop: its kind (`string`, `bool`, `number`, `items`, `node`) or the values it takes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum Prop {
    Kind(String),
    Values(Vec<String>),
}

impl Prop {
    /// How the reference writes it.
    pub fn words(&self) -> String {
        match self {
            Self::Kind(k) if k == "items" => "[{ value, label }]".to_owned(),
            Self::Kind(k) if k == "node" => "one descriptor".to_owned(),
            Self::Kind(k) => k.clone(),
            Self::Values(v) => v.iter().map(|x| format!("'{x}'")).collect::<Vec<_>>().join(" | "),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Limits {
    pub text: usize,
    pub nodes: usize,
    pub depth: usize,
    pub items: usize,
    pub event: String,
    pub module: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct Place {
    pub words: String,
    pub drawn: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct Kit {
    pub components: BTreeMap<String, BTreeMap<String, Prop>>,
    pub parents: Vec<String>,
    pub events: BTreeMap<String, String>,
    pub limits: Limits,
    pub api: Vec<String>,
    pub places: BTreeMap<String, Place>,
}

static KIT: LazyLock<Kit> = LazyLock::new(|| serde_json::from_str(KIT_JSON).unwrap_or_default());

/// The kit (empty if kit.json didn't read: a test holds it readable).
pub fn kit() -> &'static Kit {
    &KIT
}

impl Kit {
    /// The places an untrusted UI may show, in words (`a pane in Settings → Advanced`).
    pub fn place_words(&self, place: &str) -> Option<&str> {
        self.places.get(place).map(|p| p.words.as_str())
    }
}
