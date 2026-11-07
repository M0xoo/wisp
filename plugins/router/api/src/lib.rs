//! wisp.router contract: Auto (v1 server/router.js, services/auto.js, routes/auto.js). Auto picks the
//! harness, model and thinking level for a task with a bandit, learns from what you pick yourself and
//! from how runs went, and tells usage limits apart from the model failing.
//!
//! Other plugins reach it through [`service::RouterService`] (`router.service@1`): the runtime asks it
//! to pick for `agent: "auto"`, to classify a run's error, and reports what happened. Settings → Auto
//! and the launcher's preview use the commands in [`commands`] (and v1's routes, same paths and JSON).
//!
//! Wire shapes are v1's (camelCase): older clients and the importer of v1's router.json read them as
//! they were. Types the UI reads derive `ts_rs::TS` and export under `router/`.

pub mod commands;
pub mod service;
pub mod types;
pub mod view;

pub use service::{Outcome, PickRequest, RouterApi, RouterService, RunError};
pub use types::*;
pub use view::*;

/// The plugin id (manifest `id`).
pub const PLUGIN_ID: &str = "wisp.router";
/// Every router row (arms, stats, routes, taste, corrections, cooling): Settings → Auto watches it.
pub const TOPIC: &str = "plugin:wisp.router:router";

/// Thinking levels wisp knows, weakest first.
pub const LEVELS: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];
/// The kinds of task the router learns per (v1 router.js:42).
pub const TYPES: [&str; 8] = [
    "bug", "feature", "ui", "test", "refactor", "docs", "release", "question",
];

pub fn is_level(e: &str) -> bool {
    LEVELS.contains(&e)
}

/// `agent:model[:effort]`: one harness × model × thinking level ('' is the default).
pub fn arm_key(agent: &str, model: &str, effort: &str) -> String {
    let mut k = String::with_capacity(agent.len() + model.len() + effort.len() + 2);
    k.push_str(agent);
    k.push(':');
    k.push_str(model);
    if !effort.is_empty() {
        k.push(':');
        k.push_str(effort);
    }
    k
}

/// The three parts of an arm key, borrowed from it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyParts<'a> {
    pub agent: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
}

/// A trailing segment is a level only if wisp knows it, so a model id with a colon in it
/// (ollama's `llama3:8b`) stays whole (v1 router.js:124). A key without a colon is all agent.
pub fn split_key(k: &str) -> KeyParts<'_> {
    let Some((agent, rest)) = k.split_once(':') else {
        // v1: indexOf(':') is -1, so the agent is everything but the last character and the model
        // the whole key; no caller passes such a key, so keep it simple and total.
        return KeyParts {
            agent: k,
            model: "",
            effort: "",
        };
    };
    match rest.rsplit_once(':') {
        Some((model, tail)) if is_level(tail) => KeyParts {
            agent,
            model,
            effort: tail,
        },
        _ => KeyParts {
            agent,
            model: rest,
            effort: "",
        },
    }
}

/// The three goals of Auto: (id, label, value in the utility, hint) (v1 router.js:37).
pub const GOALS: [(&str, &str, f64, &str); 3] = [
    ("cheap", "Cheap", 1.0, "Lowest cost that still gets it done"),
    (
        "balanced",
        "Balanced",
        5.0,
        "Frontier models as their makers ship them, a level up where it pays",
    ),
    (
        "best",
        "Best",
        50.0,
        "Frontier models at high thinking; cost only breaks ties",
    ),
];

pub fn is_goal(g: &str) -> bool {
    GOALS.iter().any(|(id, ..)| *id == g)
}
