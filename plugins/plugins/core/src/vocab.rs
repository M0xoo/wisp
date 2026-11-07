//! The UI vocabulary a spell (or declarative plugin) names: slots, parts and their props, tokens,
//! icons, and the settings it may set while on. The defaults are v1's, so every spell made before
//! plugins still checks; the shell and settings owners add theirs through `plugins.vocabulary`.
use std::collections::HashSet;

use wisp_plugins_api::{PropType, Vocabulary};

use crate::schema::{schema, v1_parts};

/// Every name, the v1 defaults merged with what plugins contributed. Lists keep their order: problem
/// messages name them in it, as v1 did.
#[derive(Debug, Clone)]
pub struct Vocab {
    pub slots: Vec<(String, String)>,
    pub parts: Vec<String>,
    part_set: HashSet<String>,
    pub part_props: Vec<(String, Vec<(String, PropType)>)>,
    pub tokens: Vec<String>,
    pub icons: Vec<String>,
    pub settings: Vec<(String, PropType)>,
}

fn add_unique<T: PartialEq + Clone>(to: &mut Vec<T>, from: &[T]) {
    for x in from {
        if !to.contains(x) {
            to.push(x.clone());
        }
    }
}

fn upsert<V: Clone>(to: &mut Vec<(String, V)>, k: &str, v: &V) {
    match to.iter_mut().find(|(n, _)| n == k) {
        Some(slot) => slot.1 = v.clone(),
        None => to.push((k.to_owned(), v.clone())),
    }
}

impl Vocab {
    /// v1's names only.
    pub fn v1() -> Self {
        let s = schema();
        let parts: Vec<String> = v1_parts().iter().map(|r| r.v1.clone()).collect();
        Self {
            slots: s.slots.clone(),
            part_set: parts.iter().cloned().collect(),
            parts,
            part_props: s.part_props.clone(),
            tokens: s.tokens.clone(),
            icons: s.icons.clone(),
            settings: s.settings.clone(),
        }
    }

    /// v1's names plus every contribution (a later one wins for the same slot, prop or setting).
    pub fn merged(extra: &[&Vocabulary]) -> Self {
        let mut v = Self::v1();
        for x in extra {
            for (k, d) in &x.slots {
                upsert(&mut v.slots, k, d);
            }
            add_unique(&mut v.parts, &x.parts);
            for (part, props) in &x.part_props {
                if let Some(slot) = v.part_props.iter_mut().find(|(p, _)| p == part) {
                    for (k, t) in props {
                        upsert(&mut slot.1, k, t);
                    }
                } else {
                    v.part_props.push((part.clone(), props.clone()));
                }
            }
            add_unique(&mut v.tokens, &x.tokens);
            add_unique(&mut v.icons, &x.icons);
            for (k, t) in &x.settings {
                upsert(&mut v.settings, k, t);
            }
        }
        v.part_set = v.parts.iter().cloned().collect();
        v
    }

    pub fn is_slot(&self, s: &str) -> bool {
        self.slots.iter().any(|(k, _)| k == s)
    }
    pub fn slot_names(&self) -> String {
        self.slots.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(", ")
    }
    pub fn is_part(&self, s: &str) -> bool {
        self.part_set.contains(s)
    }
    pub fn props_of(&self, part: &str) -> &[(String, PropType)] {
        self.part_props.iter().find(|(p, _)| p == part).map_or(&[], |(_, v)| v.as_slice())
    }
    pub fn setting(&self, k: &str) -> Option<&PropType> {
        self.settings.iter().find(|(n, _)| n == k).map(|(_, t)| t)
    }
    pub fn setting_names(&self) -> String {
        self.settings.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(", ")
    }
}

impl Default for Vocab {
    fn default() -> Self {
        Self::v1()
    }
}
