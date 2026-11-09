//! wisp tui's points (ADR-0024). The TUI is a shell (zones, focus, palette, keymap, theme) and everything it shows
//! comes through three points, which a plugin's `tui/` crate contributes to the same way the built-ins do:
//!
//! - **`tui.view@1`** ([`TuiView`]): a screen reached from the palette or a goto key. Most are tables: a source
//!   (a command or a topic), columns, row actions bound to keys, and a detail pane ([`Table`]).
//! - **`tui.input@1`** ([`TuiInput`]): an item in one of the shell's slots (the status bar, a task's header), the
//!   GUI shell's inputs one to one.
//! - **`term.block@1`** ([`TermBlock`]): an answer block's terminal renderer, shared with the CLI.

pub mod blocks;
pub mod diff;
pub mod theme;
pub mod tokens;

use std::sync::Arc;

use ratatui::text::{Line, Span};
use serde_json::Value;

pub use theme::Theme;

/// Where a view's rows come from.
#[derive(Debug, Clone, PartialEq)]
pub enum Source {
    /// a command's answer; `rows`: the JSON pointer to its list ("" when the answer is the list)
    Command { id: String, args: Value, rows: String },
    /// a sync topic's rows of entity `entity`
    Topic { topic: String, entity: String },
}

/// A column: its title, the JSON pointer it reads, and its width (0: what's left).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Column {
    pub title: String,
    pub pointer: String,
    pub width: u16,
}

/// A key on a row: run `command` with `args`, where `"{/pointer}"` strings are filled from the row.
#[derive(Debug, Clone, PartialEq)]
pub struct RowAction {
    pub key: char,
    pub label: String,
    pub command: String,
    pub args: Value,
    /// asks y/n first (a delete, a stop)
    pub confirm: bool,
}

/// `tui.view@1`.
pub trait TuiView: Send + Sync + 'static {
    fn id(&self) -> &str;
    fn title(&self) -> &str;
    /// `g` then this key goes to it
    fn goto(&self) -> Option<char> {
        None
    }
    fn source(&self) -> Source;
    fn columns(&self) -> Vec<Column>;
    fn actions(&self) -> Vec<RowAction> {
        Vec::new()
    }
    /// what the detail pane shows for a row
    fn detail(&self, row: &Value, _width: u16, th: &Theme) -> Vec<Line<'static>> {
        detail_of(row, th)
    }
}

/// A row as `key: value` lines (the default detail).
pub fn detail_of(row: &Value, th: &Theme) -> Vec<Line<'static>> {
    let Some(o) = row.as_object() else { return vec![Line::from(row.to_string())] };
    o.iter()
        .filter(|(_, v)| !v.is_null())
        .map(|(k, v)| {
            let val = match v {
                Value::String(s) => s.clone(),
                Value::Array(a) if a.iter().all(Value::is_string) => a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", "),
                other => other.to_string(),
            };
            Line::from(vec![Span::styled(format!("{k}: "), th.dim()), Span::styled(val, th.text())])
        })
        .collect()
}

/// A cell: the value at `pointer`, as text (a list joined, a bool as ✓, a time left as it is).
pub fn cell(row: &Value, pointer: &str) -> String {
    match row.pointer(pointer) {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => if *b { "✓".into() } else { String::new() },
        Some(Value::Array(a)) => a.iter().map(|x| x.as_str().map_or_else(|| x.to_string(), str::to_owned)).collect::<Vec<_>>().join(", "),
        Some(v) => v.to_string(),
    }
}

/// `args` with every `"{/pointer}"` string replaced by the row's value there.
pub fn fill(args: &Value, row: &Value) -> Value {
    match args {
        Value::String(s) if s.starts_with("{/") && s.ends_with('}') => row.pointer(&s[1..s.len() - 1]).cloned().unwrap_or(Value::Null),
        Value::Object(o) => Value::Object(o.iter().map(|(k, v)| (k.clone(), fill(v, row))).collect()),
        Value::Array(a) => Value::Array(a.iter().map(|v| fill(v, row)).collect()),
        other => other.clone(),
    }
}

/// A table view, declared.
#[derive(Debug, Clone)]
pub struct Table {
    pub id: String,
    pub title: String,
    pub goto: Option<char>,
    pub source: Source,
    pub columns: Vec<Column>,
    pub actions: Vec<RowAction>,
}

impl Table {
    pub fn new(id: &str, title: &str, source: Source) -> Self {
        Self { id: id.into(), title: title.into(), goto: None, source, columns: Vec::new(), actions: Vec::new() }
    }
    #[must_use]
    pub fn goto(mut self, k: char) -> Self {
        self.goto = Some(k);
        self
    }
    #[must_use]
    pub fn col(mut self, title: &str, pointer: &str, width: u16) -> Self {
        self.columns.push(Column { title: title.into(), pointer: pointer.into(), width });
        self
    }
    #[must_use]
    pub fn act(mut self, key: char, label: &str, command: &str, args: Value, confirm: bool) -> Self {
        self.actions.push(RowAction { key, label: label.into(), command: command.into(), args, confirm });
        self
    }
}

impl TuiView for Table {
    fn id(&self) -> &str {
        &self.id
    }
    fn title(&self) -> &str {
        &self.title
    }
    fn goto(&self) -> Option<char> {
        self.goto
    }
    fn source(&self) -> Source {
        self.source.clone()
    }
    fn columns(&self) -> Vec<Column> {
        self.columns.clone()
    }
    fn actions(&self) -> Vec<RowAction> {
        self.actions.clone()
    }
}

/// The shell's slots an input may fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    StatusLeft,
    StatusRight,
    TaskHeader,
}

/// What an input sees: the open task (its merged row), the turn running, the connection.
#[derive(Debug, Clone, Default)]
pub struct InputCx {
    pub task: Value,
    pub turn: Value,
    pub online: bool,
}

/// `tui.input@1`.
pub trait TuiInput: Send + Sync + 'static {
    fn slot(&self) -> Slot;
    fn render(&self, cx: &InputCx, th: &Theme) -> Option<Span<'static>>;
}

/// `term.block@1`: `kinds` are block types (`*`: any the others don't take).
pub trait TermBlock: Send + Sync + 'static {
    fn kinds(&self) -> &[&str];
    fn render(&self, block: &Value, width: u16, th: &Theme) -> Vec<Line<'static>>;
}

/// What the TUI has: its views, inputs and block renderers, built-ins first. A plugin's `tui/` crate adds to it
/// with a `register(&mut Registry)`.
#[derive(Clone, Default)]
pub struct Registry {
    pub views: Vec<Arc<dyn TuiView>>,
    pub inputs: Vec<Arc<dyn TuiInput>>,
    pub blocks: Vec<Arc<dyn TermBlock>>,
}

impl std::fmt::Debug for Registry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Registry").field("views", &self.views.iter().map(|v| v.id().to_owned()).collect::<Vec<_>>()).field("inputs", &self.inputs.len()).field("blocks", &self.blocks.len()).finish()
    }
}

impl Registry {
    pub fn view(&mut self, v: impl TuiView) -> &mut Self {
        self.views.push(Arc::new(v));
        self
    }
    pub fn input(&mut self, i: impl TuiInput) -> &mut Self {
        self.inputs.push(Arc::new(i));
        self
    }
    /// A plugin's renderer goes ahead of the built-ins, so it may restyle a type.
    pub fn block(&mut self, b: impl TermBlock) -> &mut Self {
        self.blocks.insert(0, Arc::new(b));
        self
    }
    /// One block through the first renderer that takes its type.
    pub fn render_block(&self, b: &Value, width: u16, th: &Theme) -> Vec<Line<'static>> {
        let ty = b.get("type").and_then(Value::as_str).unwrap_or_default();
        let r = self.blocks.iter().find(|r| r.kinds().contains(&ty)).or_else(|| self.blocks.iter().find(|r| r.kinds().contains(&"*")));
        r.map_or_else(|| blocks::render(b, width, th), |r| r.render(b, width, th))
    }
    pub fn find(&self, id: &str) -> Option<Arc<dyn TuiView>> {
        self.views.iter().find(|v| v.id() == id).cloned()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Shout;
    impl TermBlock for Shout {
        fn kinds(&self) -> &[&str] {
            &["hero"]
        }
        fn render(&self, b: &Value, _w: u16, _th: &Theme) -> Vec<Line<'static>> {
            vec![Line::from(b["title"].as_str().unwrap_or_default().to_uppercase())]
        }
    }

    #[test]
    fn a_plugins_block_renderer_goes_first() {
        let mut r = Registry::default();
        r.block(blocks::Builtin);
        let hero = json!({ "type": "hero", "title": "done it" });
        assert!(r.render_block(&hero, 80, &Theme::DARK)[0].spans.iter().any(|s| s.content.contains("done it")));
        r.block(Shout);
        assert_eq!(r.render_block(&hero, 80, &Theme::DARK)[0].spans[0].content, "DONE IT");
        assert!(r.render_block(&json!({ "type": "markdown", "text": "x" }), 80, &Theme::DARK)[0].spans.iter().any(|s| s.content == "x"), "the rest stay built-in");
    }

    #[test]
    fn a_tables_cells_and_actions_read_the_row() {
        let row = json!({ "id": "m1", "name": "Ada", "on": ["ci.failed", "schedule"], "paused": true });
        assert_eq!((cell(&row, "/name"), cell(&row, "/on"), cell(&row, "/paused"), cell(&row, "/nope")), ("Ada".into(), "ci.failed, schedule".into(), "✓".into(), String::new()));
        assert_eq!(fill(&json!({ "id": "{/id}", "why": "from the tui", "n": [ "{/name}" ] }), &row), json!({ "id": "m1", "why": "from the tui", "n": ["Ada"] }));
        let t = Table::new("crew", "Crew", Source::Command { id: "crew.list".into(), args: json!({}), rows: String::new() }).goto('c').col("Name", "/name", 20).act('w', "Wake", "crew.wake", json!({ "id": "{/id}" }), false);
        assert_eq!((TuiView::goto(&t), t.columns().len(), t.actions()[0].key), (Some('c'), 1, 'w'));
    }
}
