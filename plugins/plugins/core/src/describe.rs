//! What a spell does, in plain words, with the riskiest kind it reaches (v1 describeSpell): the review
//! dialog's lines and badge, the Make a plugin agent's check, Settings → Plugins' summary.
use serde_json::{Map, Value};
use wisp_plugins_api::{Risk, Section};

use crate::js::{clip, js_string, truthy};
use crate::schema::schema;

const WHERE: &[(&str, &str)] = &[
    ("topbar", "A top bar button"), ("float", "A floating button"), ("palette", "A ⌘K item"), ("launcher.bar", "A prompt box button"),
    ("launcher.chips", "A chip under the prompt box"), ("composer.bar", "A follow-up box button"), ("composer.chips", "A quick reply above the follow-up box"),
    ("card.head", "A chip in each card's head"), ("card.hover", "A card button (on hover)"), ("card.menu", "An item in each card's menu"),
    ("term.head", "A button in a task's terminal"), ("panel.head", "A button in the side panel's head"), ("crew.page", "A button on each crew member's page"),
    ("org.head", "A button on the Org page"), ("plan.head", "A button on a scheduled task's page"), ("stuff.head", "A button on My Stuff"), ("machine.head", "A button on This Mac"),
];
const ON_WORDS: &[(&str, &str)] = &[("finished", "when a task finishes"), ("done", "when a task is marked done"), ("ci", "when CI fails")];

fn s(v: Option<&Value>) -> String {
    v.map(js_string).unwrap_or_else(|| "undefined".into())
}
fn field<'a>(v: Option<&'a Value>, k: &str) -> Option<&'a Value> {
    v.and_then(|v| v.get(k))
}
fn list(v: Option<&Value>) -> Vec<&Value> {
    v.and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default()
}
fn join(v: Option<&Value>, sep: &str) -> String {
    list(v).into_iter().map(js_string).collect::<Vec<_>>().join(sep)
}
fn kv(m: Option<&Value>) -> String {
    m.and_then(Value::as_object).map(|o| o.iter().map(|(k, v)| format!("{k}: {}", js_string(v))).collect::<Vec<_>>().join(", ")).unwrap_or_default()
}
fn on_agent(v: Option<&Value>) -> String {
    field(v, "agent").filter(|a| truthy(Some(a))).map(|a| format!(" on {}", js_string(a))).unwrap_or_default()
}

fn act_words(k: &str, v: Option<&Value>, spell: &Value) -> Option<String> {
    let c = |n| clip(&s(v), n);
    let p = |n| clip(&s(field(v, "prompt")), n);
    let vals = |skip: &str| v.and_then(Value::as_object).map(|o| o.iter().filter(|(k2, x)| truthy(Some(x)) && k2.as_str() != skip).map(|(_, x)| js_string(x)).collect::<Vec<_>>().join(" · ")).unwrap_or_default();
    Some(match k {
        "open" => format!("opens {}", s(v)),
        "openAll" if truthy(field(v, "data")) => format!("opens every link in {}", s(field(v, "data"))),
        "openAll" => format!("opens the links {}() returns", s(field(v, "fn"))),
        "panel" => {
            let title = list(spell.get("panels")).into_iter().find(|x| x.get("id") == v).and_then(|x| x.get("title")).filter(|t| truthy(Some(t))).map_or_else(|| s(v), js_string);
            format!("opens the “{title}” panel")
        }
        "insert" => format!("types “{}” into the box", c(50)),
        "copy" => format!("copies “{}”", c(40)),
        "toast" => "shows a message".into(),
        "setLaunch" => format!("sets the prompt box to {}", vals("")),
        "send" => format!("sends “{}” to the task", c(50)),
        "reply" => format!("replies “{}” to the task", c(50)),
        "launchWith" => format!("launches with {}", vals("text")),
        "launch" => format!("starts a task: “{}”", p(50)),
        "fork" => format!("forks the task to “{}”{}", p(50), on_agent(v)),
        "side" => format!("starts a side discussion: “{}”{}", p(50), on_agent(v)),
        "rerun" => {
            let what: Vec<String> = ["agent", "model", "mode"].iter().filter_map(|f| field(v, f)).filter(|x| truthy(Some(x))).map(js_string).collect();
            format!("reruns the task on {}", if what.is_empty() { "another harness".into() } else { what.join(" · ") })
        }
        "recipe" => format!("runs the recipe {}", s(v)),
        "ship" => "opens Ship it".into(),
        "done" => "marks the task done".into(),
        "archive" => "archives the task".into(),
        "forLater" => "saves the task for later".into(),
        "compact" => "compacts the task".into(),
        "notify" => "notifies you".into(),
        "webhook" => format!("POSTs the task to {}", s(v)),
        "exec" => format!("runs `{}`", c(60)),
        _ => return None,
    })
}

struct Words<'a> {
    spell: &'a Value,
    kind: Risk,
}

impl Words<'_> {
    fn bump(&mut self, k: Risk) {
        self.kind = self.kind.max(k);
    }
    fn act(&mut self, a: Option<&Value>) -> String {
        let Some((k, v)) = a.and_then(Value::as_object).and_then(|o| o.iter().next()) else { return String::new() };
        self.bump(schema().action(k).map_or(Risk::Safe, |(r, _)| r));
        act_words(k, Some(v), self.spell).unwrap_or_else(|| k.clone())
    }
}

fn where_of(slot: Option<&Value>) -> String {
    let slot = s(slot);
    WHERE.iter().find(|(k, _)| *k == slot).map_or(slot, |(_, w)| (*w).to_owned())
}

fn cards(w: Option<&Value>) -> String {
    if w.is_some_and(|w| !w.is_null()) { format!(" (cards {})", kv(w)) } else { String::new() }
}

fn ui_lines(sp: &Value, w: &mut Words, lines: &mut Vec<String>) {
    for b in list(sp.get("buttons")) {
        let label = if truthy(b.get("label")) { s(b.get("label")) } else { s(b.get("icon")) };
        lines.push(format!("{} “{label}”{} that {}", where_of(b.get("slot")), cards(b.get("when")), w.act(b.get("do"))));
    }
    for c in list(sp.get("chips")) {
        let text = if truthy(c.get("text")) { format!(" showing “{}”", s(c.get("text"))) } else { String::new() };
        let does = if truthy(c.get("do")) { format!(" that {}", w.act(c.get("do"))) } else { String::new() };
        lines.push(format!("{}{text}{}{does}", where_of(c.get("slot")), cards(c.get("when"))));
    }
    for x in list(sp.get("panels")) {
        let as_ = s(x.get("as"));
        let what = match as_.as_str() {
            "card" => format!("panel in each card ({})", s(x.get("slot"))),
            "feed" => "panel on home".into(),
            _ => as_,
        };
        let title = if truthy(x.get("title")) { s(x.get("title")) } else { s(x.get("id")) };
        lines.push(format!("A {what} “{title}”"));
    }
    for b in list(sp.get("blocks")) {
        lines.push(format!("A “{}” block agents can use in their reports", s(b.get("type"))));
    }
    for (name, v) in sp.get("parts").and_then(Value::as_object).into_iter().flatten() {
        let style = v.get("style").and_then(Value::as_object).map(|o| format!(" ({})", o.keys().cloned().collect::<Vec<_>>().join(", "))).unwrap_or_default();
        let props = v.get("props").filter(|p| p.is_object()).map(|p| format!(" ({})", kv(Some(p)))).unwrap_or_default();
        let order = v.get("order").map(|o| format!(" (order: {})", join(Some(o), ", "))).unwrap_or_default();
        lines.push(format!("Changes {name}{style}{props}{order}"));
    }
    let ui = sp.get("ui");
    if field(ui, "hide").and_then(Value::as_array).is_some_and(|h| !h.is_empty()) {
        lines.push(format!("Hides {}", join(field(ui, "hide"), ", ")));
    }
    if field(ui, "tokens").is_some() || field(ui, "dark").is_some() {
        let mut keys: Map<String, Value> = Map::new();
        for k in ["tokens", "dark"] {
            keys.extend(field(ui, k).and_then(Value::as_object).cloned().unwrap_or_default());
        }
        lines.push(format!("Recolours wisp ({})", keys.keys().cloned().collect::<Vec<_>>().join(", ")));
    }
}

/// A crew member's line when wisp.crew isn't on to say it (the schedule as written).
fn crew_line(b: &Value) -> (String, Risk) {
    let on: Vec<String> = list(b.get("on")).into_iter().map(js_string).collect();
    let kit = list(b.get("kit")).len();
    let mode = b.get("mode").and_then(Value::as_str).unwrap_or("plan");
    let cron = b.get("cron").filter(|c| truthy(Some(c))).map(|c| format!("on `{}`", js_string(c)));
    let when: Vec<String> = cron.into_iter().chain(on.iter().map(|k| ON_WORDS.iter().find(|(n, _)| n == k).map_or_else(|| k.clone(), |(_, w)| (*w).to_owned()))).collect();
    let when = if when.is_empty() { "only when asked".into() } else { when.join(", ") };
    let role = b.get("role").filter(|r| truthy(Some(r))).map(|r| format!(" · {}", js_string(r))).unwrap_or_default();
    let kits = match kit {
        0 => String::new(),
        1 => ", with 1 skill or instructions file".into(),
        n => format!(", with {n} skills and instructions files"),
    };
    let mode_w = match mode {
        "plan" => "Plan",
        "edits" => "Edits",
        "auto" => "Full auto",
        m => m,
    };
    let risk = if b.get("cron").is_some_and(|c| truthy(Some(c))) || !on.is_empty() || mode == "auto" { Risk::Runs } else { Risk::Acts };
    (format!("A crew member, {}{role}: works {when}, in {mode_w} mode{kits}. Joins paused", s(b.get("name"))), risk)
}

fn task_lines(sp: &Value, w: &mut Words, lines: &mut Vec<String>, crew: Option<&dyn Section>) {
    for r in list(sp.get("prompt")) {
        let when = r.get("when");
        let who = field(when, "agent").map_or_else(|| "every".into(), |a| join(Some(a), "/"));
        let wherein = field(when, "project").map(|p| format!(" in {}", join(Some(p), ", "))).unwrap_or_default();
        lines.push(format!("Tells {who} agent{wherein}: “{}”", clip(&s(r.get("text")), 90)));
    }
    if let Some(set) = sp.get("settings").and_then(Value::as_object) {
        lines.push(format!("Sets {} while it's on", set.iter().map(|(k, v)| format!("{k} = {}", js_string(v))).collect::<Vec<_>>().join(", ")));
    }
    for x in list(sp.get("slash")) {
        let args = if truthy(x.get("args")) { format!("<{}> ", s(x.get("args"))) } else { String::new() };
        lines.push(format!("/{} {args}that {}", s(x.get("name")), w.act(x.get("do"))));
    }
    for x in list(sp.get("commands")) {
        lines.push(format!("⌘K “{}” that {}", s(x.get("label")), w.act(x.get("do"))));
    }
    for h in list(sp.get("hooks")) {
        w.bump(Risk::Acts);
        let cond = h.get("if").and_then(Value::as_object).filter(|o| !o.is_empty()).map(|_| format!(" ({})", kv(h.get("if")))).unwrap_or_default();
        let on = s(h.get("on")).replacen('.', " ", 1);
        lines.push(format!("On its own, when {on}{cond}: {}, at most {}× per task", w.act(h.get("do")), s(h.get("max"))));
    }
    for r in list(sp.get("recipes")) {
        lines.push(format!("A recipe “{}”", s(r.get("name"))));
    }
    for b in list(sp.get("crew")) {
        let (line, risk) = crew.and_then(|c| c.describe(b)).unwrap_or_else(|| crew_line(b));
        w.bump(risk);
        lines.push(line);
    }
    for d in sp.get("data").and_then(Value::as_object).into_iter().flat_map(|o| o.values()) {
        if let Some(gh) = d.get("gh") {
            w.bump(Risk::Reads);
            lines.push(format!("Reads GitHub: `gh {}`", join(Some(gh), " ")));
        } else {
            lines.push(format!("Reads wisp's {}", s(d.get("wisp"))));
        }
    }
}

/// The lines and the riskiest kind, for a checked spell.
pub fn describe_spell(spell: &Value, crew: Option<&dyn Section>) -> (Vec<String>, Risk) {
    let mut w = Words { spell, kind: Risk::Safe };
    let mut lines = Vec::new();
    ui_lines(spell, &mut w, &mut lines);
    task_lines(spell, &mut w, &mut lines, crew);
    (lines, w.kind)
}
