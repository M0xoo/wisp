//! The `crew` resource kind (ADR-0026): members as `crew:` in a formula, through the crew's own commands
//! (`crew.list`, `.create`, `.update`, `.remove`). A schedule in words is read as the crew reads it, so
//! "every weekday at 9" plans as unchanged against the cron it was saved as.

use serde_json::Value;
use wisp_crew_api::spec::CrewSpec;
use wisp_kernel::{BoxFuture, Call, Ctx, Result};
use wisp_resources_api::{CrudKind, KindInfo, Op, Resource, ResourceKind, schema_of};

#[derive(Debug)]
pub struct CrewKind(CrudKind);

impl CrewKind {
    pub fn new(ctx: Ctx) -> Self {
        let info = KindInfo::new("crew", "crew", wisp_crew_api::PLUGIN_ID, schema_of::<CrewSpec>()).order(60);
        Self(CrudKind::new::<CrewSpec>(info, ctx, "crew.list", "crew.create", "crew.update", "crew.remove"))
    }
}

/// A schedule as words or an alias → the 5-field cron the crew saves; anything else as it is.
pub fn cron_of(said: &str) -> String {
    let s = said.trim();
    if s.is_empty() || s.split_whitespace().count() == 5 {
        return s.to_owned();
    }
    let alias = match s {
        "@hourly" => Some("0 * * * *"),
        "@daily" => Some("0 0 * * *"),
        "@weekly" => Some("0 0 * * 0"),
        "@monthly" => Some("0 0 1 * *"),
        "@weekdays" => Some("0 9 * * 1-5"),
        _ => None,
    };
    alias.map(str::to_owned).or_else(|| wisp_automations_api::to_cron(s)).unwrap_or_else(|| s.to_owned())
}

impl ResourceKind for CrewKind {
    fn info(&self) -> KindInfo {
        self.0.info()
    }
    fn read<'a>(&'a self, call: &'a Call) -> BoxFuture<'a, Result<Vec<Resource>>> {
        self.0.read(call)
    }
    fn normalize(&self, spec: &mut Value) {
        if let Some(c) = spec.get("cron").and_then(Value::as_str).map(cron_of) {
            spec["cron"] = Value::String(c);
        }
    }
    fn apply<'a>(&'a self, call: &'a Call, op: &'a Op) -> BoxFuture<'a, Result<()>> {
        self.0.apply(call, op)
    }
}
