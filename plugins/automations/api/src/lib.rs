//! wisp.automations contract (ADR-0043: one trigger engine, sources as `trigger.source@1`; v1 server/triggers.js, recipes.js, hooks.js, routes/automations.js,
//! routes/hooks.js). Triggers start tasks without you: a schedule, a CI failure, a labelled issue, a task
//! finishing or marked done, an outside call to a secret URL. Recipes are saved prompts with `{params}`.
//!
//! The schedule helpers ([`cron`], [`words`]) are pure functions in this crate, not in core: crew
//! check-ins read schedules too, and wisp.crew's host may depend on this crate only (ADR-0003).

pub mod commands;
pub mod cron;
pub mod model;
pub mod source;
pub mod spec;
pub mod tasks;
pub mod v1;
pub mod words;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use wisp_kernel::{Event, Point};

pub use cron::{
    Cron, CronError, FixedOffset, Local, Utc, Zone, local_fields, matches, matches_local, next_run, parse_cron, read_schedule,
};
pub use model::{
    Delivery, Held, MemberRef, Origin, Recipe, RecipeFrom, RecipeView, TriggerBase, TriggerView,
};
pub use source::{PROVIDERS, Polled, Provided, SOURCE, SourceOn, TriggerEvent, TriggerFired, TriggerProvider, TriggerSource};
pub use spec::{Budget, Target, TriggerSpec, When};
pub use words::to_cron;

/// The plugin id (manifest `id`), also the ext slot on tasks a trigger or recipe started: `{origin}`.
pub const PLUGIN_ID: &str = "wisp.automations";
pub const EXT: &str = PLUGIN_ID;

/// A recipe a plugin brings (v1 spells' recipes): read-only to the user.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PluginRecipe {
    pub recipe: Recipe,
    pub from: RecipeFrom,
}

/// `automations.recipes@1`: plugins add recipes the run dialog, `wisp run` and triggers can use.
pub trait RecipeSource: Send + Sync + 'static {
    fn recipes(&self) -> Vec<PluginRecipe>;
}

pub const RECIPES: Point<dyn RecipeSource> = Point::new("automations.recipes", 1);

/// Triggers or recipes changed (v1 `configChanged`): clients reading them refresh.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Changed {
    /// `triggers` or `recipes`
    pub what: String,
}

impl Event for Changed {
    const TYPE: &'static str = "automations.changed";
}

/// Shared handle type for a zone, as hosts keep it.
pub type ZoneRef = Arc<dyn Zone>;
