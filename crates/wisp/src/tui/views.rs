//! The built-in views, as `tui.view@1` tables over the same commands the GUI's screens read: crew, automations,
//! machines, My Stuff, settings and repo history. A plugin's view is registered the same way ([`registry`]).

use serde_json::json;
use wisp_tui_api::{Registry, Source, Table, blocks::Builtin};

fn cmd(id: &str) -> Source {
    Source::Command { id: id.into(), args: json!({}), rows: String::new() }
}

/// Every view and renderer the TUI starts with.
pub fn registry() -> Registry {
    let mut r = Registry::default();
    r.block(Builtin);
    r.view(Table::new("crew", "Crew", cmd("crew.list")).goto('c').col("Name", "/name", 18).col("Role", "/role", 22).col("Running", "/running", 8).col("Jobs", "/jobs", 6).col("Machine", "/machine", 0).act('w', "wake", "crew.wake", json!({ "id": "{/id}" }), false));
    r.view(
        Table::new("automations", "Automations", cmd("automations.trigger.ls"))
            .goto('a')
            .col("Trigger", "/name", 24)
            .col("On", "/spec/on", 16)
            .col("State", "/state", 10)
            .col("Runs", "/runs", 6)
            .col("Why", "/why", 0)
            .act('f', "fire", "automations.trigger.fire", json!({ "name": "{/name}" }), true)
            .act('t', "test", "automations.trigger.test", json!({ "name": "{/name}" }), false),
    );
    r.view(Table::new("machines", "Machines", cmd("machines.list")).goto('m').col("Name", "/name", 20).col("Kind", "/kind", 10).col("State", "/state", 12).col("Working", "/working", 8).col("Address", "/address", 0).act('c', "connect", "machines.connect", json!({ "id": "{/id}" }), false).act('x', "disconnect", "machines.disconnect", json!({ "id": "{/id}" }), true));
    r.view(Table::new("stuff", "My Stuff", cmd("stuff.list")).goto('s').col("Title", "/title", 30).col("Kind", "/kind", 8).col("Tags", "/tags", 0).act('l', "launch", "stuff.launch", json!({ "id": "{/id}" }), false).act('d', "remove", "stuff.remove", json!({ "id": "{/id}" }), true));
    r.view(Table::new("settings", "Settings", cmd("settings.list")).goto(',').col("Key", "/key", 34).col("Value", "/value", 24).col("Owner", "/owner", 0));
    r.view(Table::new("history", "Repo history", cmd("runtime.history")).goto('h').col("Task", "/title", 36).col("State", "/state", 10).col("Agent", "/agent", 10).col("Project", "/cwd", 0));
    r
}
