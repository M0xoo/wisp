//! Drawing, in wisp's look (docs/v2-tui-design.md, "The look"): colours from `@wisp/tokens`, few borders (one rule
//! between the panes, the composer the one framed thing), a column of padding inside every pane, the sidebar's
//! two-line rows with the selected one on a surface and an accent bar, a state pill in the task header, the
//! prompt as a band, coloured tool rows, styled answer blocks and a status bar on `bg-2`. Every line is drawn
//! whole each frame through ratatui's buffer; nothing is printed outside `Terminal::draw`.
//!
//! Pure: [`draw`] reads the [`App`] and returns where things went, for the mouse ([`Hit`]).

#![allow(clippy::many_single_char_names)] // ratatui's `f` (the frame) and `r` (a rect), with widths and heights

use std::collections::BTreeMap;

use ratatui::Frame;
use ratatui::layout::{Constraint, Direction, Layout, Position, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, BorderType, Borders, Clear, Padding, Paragraph};
use serde_json::Value;
use wisp_tui_api::diff;
use wisp_tui_api::{InputCx, Slot, Theme, cell};

use super::app::{App, Hit, Mode, Overlay, Side, Zone};
use super::keys::{KEYS, Where};
use super::model::{Section, Transcript, s};

/// Narrower than this, one zone shows at a time.
pub const ONE_ZONE: u16 = 100;
const SPIN: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPIN_ASCII: [&str; 4] = ["|", "/", "-", "\\"];

/// The glyphs (docs/v2-tui-design.md: `◆ ● ○ ✓ ✗ › ⋯ ↳` and braille), or ASCII when `$TERM` is dumb.
struct G {
    ascii: bool,
}

impl G {
    fn pick(&self, fancy: &'static str, plain: &'static str) -> &'static str {
        if self.ascii { plain } else { fancy }
    }
    fn dot(&self) -> &'static str {
        self.pick("●", "*")
    }
    fn ok(&self) -> &'static str {
        self.pick("✓", "v")
    }
    fn no(&self) -> &'static str {
        self.pick("✗", "x")
    }
    fn prompt(&self) -> &'static str {
        self.pick("›", ">")
    }
    fn more(&self) -> &'static str {
        self.pick("⋯", "...")
    }
    fn sub(&self) -> &'static str {
        self.pick("↳", "->")
    }
    fn bar(&self) -> &'static str {
        self.pick("▌", "|")
    }
    fn rule(&self) -> &'static str {
        self.pick("─", "-")
    }
    fn vrule(&self) -> &'static str {
        self.pick("│", "|")
    }
    fn spin(&self, tick: u64) -> &'static str {
        if self.ascii { SPIN_ASCII[usize::try_from(tick / 8 % 4).unwrap_or(0)] } else { SPIN[usize::try_from(tick / 6 % 10).unwrap_or(0)] }
    }
}

fn g(app: &App) -> G {
    G { ascii: app.ascii }
}

/// A task state's glyph in the list's tone (the GUI's dots).
pub fn glyph(state: &str) -> &'static str {
    match state {
        "waiting" | "asking" => "◆",
        "done" => "✓",
        "error" => "✗",
        "stopped" => "○",
        _ => "●",
    }
}

/// A state's tone colour.
fn tone(th: &Theme, state: &str) -> Color {
    match state {
        "running" | "starting" | "queued" => th.accent,
        "waiting" | "asking" => th.warn,
        "review" => th.info,
        "done" => th.good,
        "error" | "failed" => th.bad,
        _ => th.muted,
    }
}

fn width(l: &Line<'_>) -> usize {
    l.width()
}

/// A line wrapped at `w` columns, at spaces where it can (a word longer than the line is cut). The line's own
/// style (a band's background) carries to every piece.
pub fn wrap(line: Line<'static>, w: usize) -> Vec<Line<'static>> {
    if w == 0 || width(&line) <= w {
        return vec![line];
    }
    let mut out: Vec<Line<'static>> = Vec::new();
    let mut cur: Vec<Span<'static>> = Vec::new();
    let mut n = 0;
    let base = line.style;
    for span in line.spans {
        let st = span.style;
        let mut word = String::new();
        let push = |word: &mut String, cur: &mut Vec<Span<'static>>, n: &mut usize, out: &mut Vec<Line<'static>>| {
            let len = word.chars().count();
            if *n + len > w && *n > 0 {
                out.push(Line::from(std::mem::take(cur)).style(base));
                *n = 0;
                let t = word.trim_start().to_owned();
                *word = t;
            }
            while word.chars().count() > w {
                let head: String = word.chars().take(w - *n).collect();
                let rest: String = word.chars().skip(w - *n).collect();
                cur.push(Span::styled(head, st));
                out.push(Line::from(std::mem::take(cur)).style(base));
                *n = 0;
                *word = rest;
            }
            *n += word.chars().count();
            if !word.is_empty() {
                cur.push(Span::styled(std::mem::take(word), st));
            }
        };
        for ch in span.content.chars() {
            if ch == ' ' && !word.is_empty() && !word.ends_with(' ') {
                push(&mut word, &mut cur, &mut n, &mut out);
            }
            word.push(ch);
        }
        push(&mut word, &mut cur, &mut n, &mut out);
    }
    if !cur.is_empty() {
        out.push(Line::from(cur).style(base));
    }
    out
}

fn wrap_all(lines: Vec<Line<'static>>, w: usize) -> Vec<Line<'static>> {
    lines.into_iter().flat_map(|l| wrap(l, w)).collect()
}

/// At most `w` columns, ending in `…` when cut.
fn cut(t: &str, w: usize) -> String {
    if t.chars().count() <= w {
        return t.to_owned();
    }
    let mut s: String = t.chars().take(w.saturating_sub(1)).collect();
    s.push('…');
    s
}

/// A line filled to `w` columns with `bg` (a band, the selected row): every cell is drawn.
fn band(mut spans: Vec<Span<'static>>, w: usize, bg: Color) -> Line<'static> {
    let n: usize = spans.iter().map(Span::width).sum();
    if n < w {
        spans.push(Span::raw(" ".repeat(w - n)));
    }
    // a span with its own background (a pill) keeps it
    Line::from(spans.into_iter().map(|s| if s.style.bg.is_some() { s } else { s.patch_style(Style::default().bg(bg)) }).collect::<Vec<_>>()).style(Style::default().bg(bg))
}

/// `left` and `right` on one line of `w` columns, `right` flush to the edge (`left` cut to make room).
fn split(left: Vec<Span<'static>>, right: Vec<Span<'static>>, w: usize) -> Vec<Span<'static>> {
    let rw: usize = right.iter().map(Span::width).sum();
    let room = w.saturating_sub(rw + 1);
    let mut out: Vec<Span<'static>> = Vec::new();
    let mut used = 0;
    for sp in left {
        let n = sp.width();
        if used + n <= room {
            used += n;
            out.push(sp);
        } else {
            let t = cut(&sp.content, room.saturating_sub(used));
            used += t.chars().count();
            out.push(Span::styled(t, sp.style));
            break;
        }
    }
    out.push(Span::raw(" ".repeat(w.saturating_sub(used + rw))));
    out.extend(right);
    out
}

/// "now", "5m", "2h", "3d" (the list's times).
fn ago(now: i64, at: i64) -> String {
    if now <= 0 || at <= 0 || at > now + 60_000 {
        return String::new();
    }
    // v1 format.js ago(): now under 45 s, then each unit rounded
    let s = (now - at) / 1000;
    let round = |n: i64, d: i64| (n + d / 2) / d;
    match s {
        ..45 => "now".into(),
        45..3600 => format!("{}m", round(s, 60).max(1)),
        3600..86_400 => format!("{}h", round(s, 3600)),
        _ => format!("{}d", round(s, 86_400)),
    }
}

/// A rect less a column of padding each side.
fn padded(r: Rect) -> Rect {
    Rect { x: r.x + 1, width: r.width.saturating_sub(2), ..r }
}

/// The whole screen.
pub fn draw(f: &mut Frame<'_>, app: &App) -> Hit {
    let th = &app.th;
    let area = f.area();
    // every cell gets the page's colours first: a cell nothing else draws is still drawn, so nothing stale stays
    f.render_widget(Clear, area);
    f.render_widget(Block::default().style(Style::default().bg(th.bg).fg(th.ink)), area);
    let mut hit = Hit::default();
    let banner = u16::from(!app.online);
    let rows = Layout::default().direction(Direction::Vertical).constraints([Constraint::Length(banner), Constraint::Min(3), Constraint::Length(1)]).split(area);
    if banner > 0 {
        let w = usize::from(rows[0].width);
        f.render_widget(Paragraph::new(band(vec![Span::styled(" ○ Connection lost. Reconnecting; what you do now is sent when it's back.", Style::default().fg(th.on_accent).add_modifier(Modifier::BOLD))], w, th.warn)), rows[0]);
    }
    let main = rows[1];
    let one = main.width < ONE_ZONE;
    let side_w = if one || app.side.is_none() { 0 } else { app.widths.1.min(main.width / 2) };
    let list_w = if one { if app.focus == Zone::List { main.width } else { 0 } } else { app.widths.0.min(main.width / 3) };
    let rule = |w: u16| u16::from(!(one || w == 0));
    let cols = Layout::default()
        .direction(Direction::Horizontal)
        .constraints([Constraint::Length(list_w), Constraint::Length(rule(list_w)), Constraint::Min(0), Constraint::Length(rule(side_w)), Constraint::Length(side_w)])
        .split(main);
    let gl = g(app);
    for i in [1, 3] {
        if cols[i].width > 0 {
            let lines: Vec<Line<'static>> = (0..cols[i].height).map(|_| Line::from(Span::styled(gl.vrule(), Style::default().fg(th.line2)))).collect();
            f.render_widget(Paragraph::new(lines), cols[i]);
        }
    }
    if list_w > 0 {
        hit.list = cols[0];
        hit.rows = sidebar(f, app, cols[0]);
    }
    if cols[2].width > 0 {
        let (body, comp) = task_column(f, app, cols[2]);
        hit.task = body;
        hit.composer = comp;
        match &app.screen {
            Some(v) => view(f, app, v, body),
            None => hit.tools = task(f, app, body),
        }
    }
    if side_w > 0 {
        hit.side = cols[4];
        side(f, app, cols[4]);
    }
    status(f, app, rows[2]);
    toasts(f, app, main);
    match &app.overlay {
        Some(Overlay::Help) => help(f, th, area, app.help_scroll),
        Some(Overlay::Palette(p, _)) => palette(f, app, p, area),
        Some(Overlay::Ask(_, label, text)) => {
            let r = centered(area, 64, 3);
            f.render_widget(Clear, r);
            let line = Line::from(vec![Span::styled(format!("{} ", g(app).prompt()), Style::default().fg(th.accent_ink).add_modifier(Modifier::BOLD)), Span::styled(text.clone(), th.text()), Span::styled("▏", Style::default().fg(th.accent))]);
            let b = frame(th, label, true).title_bottom(Line::from(hints(th, &[("Enter", "show"), ("Esc", "back")])).right_aligned());
            f.render_widget(Paragraph::new(line).block(b), r);
        }
        Some(Overlay::Confirm(q, _, _)) => {
            let r = centered(area, 56, 3);
            f.render_widget(Clear, r);
            f.render_widget(Paragraph::new(Line::from(vec![Span::styled(q.clone(), th.strong()), Span::styled("   y", th.text()), Span::styled(" yes  ", th.dim()), Span::styled("any key", th.text()), Span::styled(" no", th.dim())])).block(frame(th, "Sure?", true)), r);
        }
        None => {}
    }
    hit
}

/// The one framed thing's frame: rounded, `accent` when focused, `line-2` when not, on the page's colour.
fn frame<'a>(th: &Theme, title: &str, focused: bool) -> Block<'a> {
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::default().fg(if focused { th.accent } else { th.line2 }))
        .style(Style::default().bg(th.bg).fg(th.ink))
        .title(Span::styled(format!(" {title} "), if focused { Style::default().fg(th.accent_ink).add_modifier(Modifier::BOLD) } else { th.dim() }))
        .padding(Padding::horizontal(1))
}

/// The task column: the body (header and transcript, or a view), the queue, and the composer under them.
/// → (the body's rect, the composer's rect)
fn task_column(f: &mut Frame<'_>, app: &App, r: Rect) -> (Rect, Rect) {
    // the queue is the open task's: a view hides it; a blank line keeps it off the transcript
    let mut queue = if app.screen.is_some() { Vec::new() } else { queue_lines(app, usize::from(r.width.saturating_sub(4))) };
    if !queue.is_empty() {
        queue.insert(0, Line::from(""));
    }
    let qh = u16::try_from(queue.len()).unwrap_or(0).min(5);
    let ch = u16::try_from(app.composer.rows()).unwrap_or(1) + 2;
    let parts = Layout::default().direction(Direction::Vertical).constraints([Constraint::Min(3), Constraint::Length(qh), Constraint::Length(ch)]).split(r);
    if qh > 0 {
        f.render_widget(Paragraph::new(queue), Rect { x: r.x + 2, width: r.width.saturating_sub(4), ..parts[1] });
    }
    let comp = Rect { x: r.x + 1, width: r.width.saturating_sub(2), ..parts[2] };
    composer(f, app, comp);
    (parts[0], comp)
}

/// The sidebar: "wisp" and the count, then the tasks in their sections, two lines each. → screen row → task.
fn sidebar(f: &mut Frame<'_>, app: &App, r: Rect) -> BTreeMap<u16, String> {
    let th = &app.th;
    let gl = g(app);
    let focused = app.focus == Zone::List && app.screen.is_none();
    let inner = padded(r);
    let w = usize::from(inner.width);
    let full = usize::from(r.width);
    let order = app.order();
    let mut head = vec![Span::styled("wisp", Style::default().fg(th.accent_ink).add_modifier(Modifier::BOLD))];
    if let Some(q) = app.search.as_ref().filter(|_| app.focus == Zone::List) {
        head = vec![Span::styled("/", th.accent()), Span::styled(q.clone(), th.text()), Span::styled("▏", th.accent())];
    }
    let count = format!("{} task{}", order.len(), if order.len() == 1 { "" } else { "s" });
    let mut top = vec![Line::from(split(head, vec![Span::styled(count, th.dim())], w)), Line::from("")];
    // the rows: (line, the task it belongs to, whether it's the selected one)
    let mut body: Vec<(Line<'static>, Option<String>)> = Vec::new();
    let mut last: Option<Section> = None;
    for id in &order {
        let t = &app.tasks.rows[id];
        let sec = Section::of(t);
        if last != Some(sec) {
            if last.is_some() {
                body.push((Line::from(""), None));
            }
            let n = order.iter().filter(|x| Section::of(&app.tasks.rows[*x]) == sec).count();
            body.push((Line::from(vec![Span::styled(format!(" {}", sec.title().to_uppercase()), th.dim().add_modifier(Modifier::BOLD)), Span::styled(format!("  {n}"), th.dim())]), None));
            last = Some(sec);
        }
        let state = s(t, "state");
        let selected = Some(id) == app.sel.as_ref();
        let unread = t.get("unread").and_then(Value::as_bool) == Some(true);
        let title_st = if unread || selected { th.strong() } else { th.text() };
        let mut title = s(t, "title").to_owned();
        if title.is_empty() {
            title = "Untitled task".into();
        }
        if app.stopping.contains(id) {
            title = format!("{title} (stopping)");
        }
        let time = ago(app.now, super::model::updated(t));
        let line1 = split(vec![Span::styled(title, title_st)], vec![Span::styled(time, th.dim())], w);
        let dot = if matches!(state, "running" | "starting") { gl.spin(app.tick) } else if gl.ascii { gl.dot() } else { glyph(state) };
        let project = s(t, "cwd").rsplit('/').next().unwrap_or_default().to_owned();
        let meta = [s(t, "agent").to_owned(), project].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" · ");
        let line2 = split(vec![Span::styled(format!("{dot} "), Style::default().fg(tone(th, state))), Span::styled(if meta.is_empty() { state.to_owned() } else { meta }, th.dim())], Vec::new(), w);
        for spans in [line1, line2] {
            // a column of bar (the selected row's accent), the padding, the text, filled to the pane's width
            let mut row = vec![Span::styled(if selected { gl.bar() } else { " " }, Style::default().fg(if focused { th.accent } else { th.muted }))];
            row.extend(spans);
            body.push((if selected { band(row, full, th.bg2) } else { Line::from(row) }, Some(id.clone())));
        }
    }
    if order.is_empty() {
        body.push((Line::from(Span::styled(" No tasks yet. n starts one.", th.dim())), None));
    }
    // the selected row stays in sight
    let h = usize::from(r.height).saturating_sub(top.len());
    let sel_end = body.iter().rposition(|(_, id)| id.is_some() && id.as_ref() == app.sel.as_ref()).map_or(0, |i| i + 1);
    let skip = sel_end.saturating_sub(h);
    let mut map = BTreeMap::new();
    for (i, (line, id)) in body.into_iter().skip(skip).take(h).enumerate() {
        if let Some(id) = id {
            map.insert(r.y + 2 + u16::try_from(i).unwrap_or(0), id);
        }
        top.push(line);
    }
    // the header lines take the padding; the rows run edge to edge so the bar and the band reach the rule
    let header: Vec<Line<'static>> = top.drain(..2).collect();
    f.render_widget(Paragraph::new(header), Rect { height: 2.min(r.height), ..inner });
    f.render_widget(Paragraph::new(top), Rect { y: r.y + 2, height: r.height.saturating_sub(2), ..r });
    map
}

fn inputs(app: &App, slot: Slot, cx: &InputCx) -> Vec<Span<'static>> {
    app.reg.inputs.iter().filter(|i| i.slot() == slot).filter_map(|i| i.render(cx, &app.th)).flat_map(|sp| [Span::raw("  "), sp]).collect()
}

fn cx(app: &App) -> InputCx {
    let t = app.open.as_ref();
    InputCx { task: t.map(Transcript::session).unwrap_or_default(), turn: t.and_then(Transcript::running).unwrap_or_default(), online: app.online }
}

/// The task header: the title bold with its state pill, then `project · branch · harness model` and the inputs,
/// then a rule.
fn header(app: &App, session: &Value, w: usize) -> Vec<Line<'static>> {
    let th = &app.th;
    let state = s(session, "state");
    let pill = format!(" {state} ");
    let mut first = vec![Span::styled(cut(s(session, "title"), w.saturating_sub(pill.chars().count() + 2)), th.strong())];
    if !state.is_empty() {
        first.push(Span::raw("  "));
        first.push(Span::styled(pill, Style::default().bg(tone(th, state)).fg(th.on_accent).add_modifier(Modifier::BOLD)));
    }
    let project = s(session, "cwd").rsplit('/').next().unwrap_or_default().to_owned();
    let run = [cell(session, "/agent"), cell(session, "/model")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>().join(" ");
    let mut meta: Vec<String> = [project, cell(session, "/branch"), run].into_iter().filter(|x| !x.is_empty()).collect();
    // the goal comes from wisp.goal's own tui crate (a TaskHeader input), as the GUI's band does
    for (label, v) in [("PR #", cell(session, "/pr/number")), ("@", cell(session, "/crew"))] {
        if !v.is_empty() {
            meta.push(format!("{label}{v}"));
        }
    }
    let mut second = vec![Span::styled(cut(&meta.join(" · "), w), th.dim())];
    second.extend(inputs(app, Slot::TaskHeader, &cx(app)));
    vec![Line::from(first), Line::from(second), Line::from(Span::styled(g(app).rule().repeat(w), Style::default().fg(th.line)))]
}

/// A tool step's one line: `✓ Edit src/auth.ts +12 −3` (a spinner while it runs), the verb in `ink-2`, the target
/// in `ink`; the cursor's row on a band with the accent bar.
fn tool_line(app: &App, b: &Value, live: bool, open: bool, at: bool, w: usize) -> Line<'static> {
    let th = &app.th;
    let gl = g(app);
    let label = if s(b, "label").is_empty() { s(b, "tool") } else { s(b, "label") };
    let file = s(b, "file");
    let rel = file.strip_prefix(&format!("{}/", app.cwd)).unwrap_or(file);
    let (verb, target) = match label.split_once(' ') {
        _ if !rel.is_empty() && !label.contains(rel) => (label.to_owned(), rel.to_owned()),
        Some((v, t)) => (v.to_owned(), t.to_owned()),
        None => (label.to_owned(), String::new()),
    };
    let failed = s(b, "status") == "error";
    let (mark, mark_st) = if live { (gl.spin(app.tick), Style::default().fg(th.accent)) } else if failed { (gl.no(), Style::default().fg(th.bad)) } else { (gl.ok(), Style::default().fg(th.good)) };
    let mut spans = vec![
        Span::styled(if at { gl.bar() } else { " " }, Style::default().fg(th.accent)),
        Span::raw(" "),
        Span::styled(format!("{mark} "), mark_st.add_modifier(Modifier::BOLD)),
        Span::styled(verb, Style::default().fg(th.ink2)),
    ];
    if !target.is_empty() {
        spans.push(Span::styled(format!(" {target}"), th.text()));
    }
    if let Some(rows) = diff::parse_unified(s(b, "detail")) {
        let (a, d) = diff::counts(&rows);
        spans.push(Span::styled(format!("  +{a}"), Style::default().fg(th.add)));
        spans.push(Span::styled(format!(" −{d}"), Style::default().fg(th.del)));
    }
    let more = !s(b, "detail").is_empty() || !s(b, "output").is_empty();
    if more && !open {
        spans.push(Span::styled(format!("  {}", gl.more()), th.dim()));
    }
    if at { band(spans, w, th.bg2) } else { Line::from(spans) }
}

/// The task's transcript, top to bottom, wrapped at `w`. → lines, and the tool seq each line is (for clicks).
// size-ok: one pass over the turns, each kind of step a short arm
#[allow(clippy::too_many_lines)]
pub fn transcript(app: &App, t: &Transcript, w: u16) -> (Vec<Line<'static>>, Vec<Option<i64>>) {
    let th = &app.th;
    let gl = g(app);
    let wu = usize::from(w);
    let mut out: Vec<(Line<'static>, Option<i64>)> = Vec::new();
    let add = |lines: Vec<Line<'static>>, seq: Option<i64>, out: &mut Vec<(Line<'static>, Option<i64>)>| out.extend(wrap_all(lines, wu).into_iter().map(|l| (l, seq)));
    let turns = t.turns();
    let mark = app.search.as_ref().filter(|q| !q.is_empty() && app.focus == Zone::Task).map(|q| q.to_lowercase());
    for turn in &turns {
        let id = s(turn, "id");
        let status = s(turn, "status");
        let live = !matches!(status, "done" | "error" | "stopped");
        let prompt = s(turn, "prompt");
        if !out.is_empty() {
            out.push((Line::from(""), None));
        }
        if !prompt.is_empty() {
            // the prompt as a band: `›` and the text on bg-2, the full width, wrapped inside the band
            let inner = wu.saturating_sub(3);
            let mut lines = vec![band(Vec::new(), wu, th.bg2)];
            for (i, l) in prompt.lines().enumerate() {
                for (j, piece) in wrap(Line::from(Span::styled(l.to_owned(), th.text())), inner).into_iter().enumerate() {
                    let lead = if i == 0 && j == 0 { format!(" {} ", gl.prompt()) } else { "   ".to_owned() };
                    let mut spans = vec![Span::styled(lead, Style::default().fg(th.accent_ink).add_modifier(Modifier::BOLD))];
                    spans.extend(piece.spans);
                    lines.push(band(spans, wu, th.bg2));
                }
            }
            lines.push(band(Vec::new(), wu, th.bg2));
            out.extend(lines.into_iter().map(|l| (l, None)));
            out.push((Line::from(""), None));
        }
        let events = t.events(id);
        let outputs: BTreeMap<String, String> = events.iter().filter(|(_, b)| s(b, "kind") == "tool_output").map(|(_, b)| (s(b, "callId").to_owned(), s(b, "text").to_owned())).collect();
        let last = events.last().map(|(seq, _)| *seq);
        for (seq, b) in &events {
            match s(b, "kind") {
                "tool" => {
                    let open = t.expanded.contains(seq);
                    let done = !live || outputs.contains_key(s(b, "callId")) || Some(*seq) != last;
                    out.push((tool_line(app, b, !done, open, app.cursor == Some(*seq), wu), Some(*seq)));
                    if open {
                        let detail = s(b, "detail");
                        let mut body: Vec<Line<'static>> = match diff::parse_unified(detail) {
                            Some(rows) => diff::render(&rows, w.saturating_sub(6), th).0,
                            None => detail.lines().map(|l| Line::from(Span::styled(l.to_owned(), th.text()))).collect(),
                        };
                        let output = if s(b, "output").is_empty() { outputs.get(s(b, "callId")).map(String::as_str).unwrap_or_default() } else { s(b, "output") };
                        body.extend(output.lines().take(40).map(|l| Line::from(Span::styled(l.to_owned(), Style::default().fg(th.ink2)))));
                        let lead = |i: usize| Span::styled(if i == 0 { format!("    {} ", gl.sub()) } else { "      ".to_owned() }, th.dim());
                        let body = body.into_iter().enumerate().map(|(i, l)| Line::from([vec![lead(i)], l.spans].concat()).style(l.style)).collect();
                        add(body, Some(*seq), &mut out);
                    }
                }
                // text streams in full while the turn runs; once it's done the answer says it, so a done turn
                // keeps only its first line, as a note
                "text" if live => add(wisp_tui_api::blocks::markdown(s(b, "text"), th), None, &mut out),
                "text" => {
                    let first = s(b, "text").lines().find(|l| !l.trim().is_empty()).unwrap_or_default().trim().to_owned();
                    add(vec![Line::from(vec![Span::raw("   "), Span::styled(first, Style::default().fg(th.ink2))])], None, &mut out);
                }
                "thinking" if live && Some(*seq) == last => add(vec![Line::from(vec![Span::styled(format!("   {} ", gl.spin(app.tick)), Style::default().fg(th.accent)), Span::styled("thinking", th.dim())])], None, &mut out),
                "tool_error" => add(vec![Line::from(vec![Span::styled(format!("   {} ", gl.no()), Style::default().fg(th.bad).add_modifier(Modifier::BOLD)), Span::styled(s(b, "name").to_owned(), Style::default().fg(th.ink2)), Span::styled(format!(" {}", s(b, "text")), th.text())])], None, &mut out),
                "blocked" => add(vec![Line::from(vec![Span::styled(format!("   {} ", gl.no()), Style::default().fg(th.bad).add_modifier(Modifier::BOLD)), Span::styled(format!("{} blocked", s(b, "tool")), Style::default().fg(th.ink2)), Span::styled(format!(" {}", s(b, "detail")), th.text())])], None, &mut out),
                "notice" => add(vec![Line::from(vec![Span::styled("   ! ", Style::default().fg(th.warn).add_modifier(Modifier::BOLD)), Span::styled(s(b, "text").to_owned(), th.text())])], None, &mut out),
                _ => {}
            }
        }
        if !live {
            let blocks = turn.pointer("/presentation/blocks").and_then(Value::as_array).filter(|b| !b.is_empty());
            let fallback = turn.pointer("/presentation/fallback").and_then(Value::as_bool) == Some(true);
            let mut answer: Vec<Line<'static>> = Vec::new();
            match blocks {
                Some(bs) if !fallback => {
                    for (i, b) in bs.iter().enumerate() {
                        if i > 0 {
                            answer.push(Line::from(""));
                        }
                        answer.extend(app.reg.render_block(b, w, th));
                    }
                }
                _ => answer.extend(wisp_tui_api::blocks::markdown(s(turn, "text"), th)),
            }
            if !answer.is_empty() {
                out.push((Line::from(""), None));
                add(answer, None, &mut out);
            }
            if status == "stopped" {
                add(vec![Line::from(Span::styled("○ stopped", th.dim()))], None, &mut out);
            }
        }
    }
    if let Some(ask) = t.ask() {
        out.push((Line::from(""), None));
        let mut lines = vec![Line::from(vec![Span::styled("◆ ", Style::default().fg(th.warn).add_modifier(Modifier::BOLD)), Span::styled(ask.question.clone(), th.strong())])];
        lines.extend(ask.options.iter().enumerate().map(|(i, o)| Line::from(vec![Span::styled(format!("  {} ", i + 1), Style::default().fg(th.accent_ink).add_modifier(Modifier::BOLD)), Span::styled(o.clone(), th.text())])));
        let approval = ask.options.iter().any(|o| o.eq_ignore_ascii_case("allow"));
        let keys: &[(&str, &str)] = if approval { &[("y", "allow"), ("a", "always"), ("n", "deny")] } else { &[("1-9", "choose"), ("i", "write an answer")] };
        let mut hint = vec![Span::raw("  ")];
        for (k, word) in keys {
            hint.push(Span::styled((*k).to_owned(), th.text().add_modifier(Modifier::BOLD)));
            hint.push(Span::styled(format!(" {word}   "), th.dim()));
        }
        lines.push(Line::from(hint));
        add(lines, None, &mut out);
    }
    if turns.is_empty() && t.ask().is_none() {
        add(vec![Line::from(vec![Span::styled(format!("{} ", gl.spin(app.tick)), Style::default().fg(th.accent)), Span::styled("Starting", th.dim())])], None, &mut out);
    }
    if let Some(q) = mark {
        for (l, _) in &mut out {
            let text: String = l.spans.iter().map(|s| s.content.as_ref()).collect();
            if text.to_lowercase().contains(&q) {
                *l = band(l.spans.clone(), wu, th.accent_soft);
            }
        }
    }
    out.into_iter().unzip()
}

/// The task: its header and transcript, a column of padding each side. → screen row → tool seq.
fn task(f: &mut Frame<'_>, app: &App, r: Rect) -> BTreeMap<u16, i64> {
    let th = &app.th;
    let inner = Rect { x: r.x + 1, y: r.y, width: r.width.saturating_sub(2), height: r.height };
    let Some(t) = &app.open else {
        f.render_widget(Paragraph::new(vec![Line::from(""), Line::from(Span::styled("No task open.", th.strong())), Line::from(vec![Span::styled("n", th.text().add_modifier(Modifier::BOLD)), Span::styled(" starts one · ", th.dim()), Span::styled("Ctrl-K", th.text().add_modifier(Modifier::BOLD)), Span::styled(" finds anything", th.dim())])]), padded(inner));
        return BTreeMap::new();
    };
    let session = t.session();
    let session = if session.is_null() { app.tasks.rows.get(&t.task).cloned().unwrap_or_default() } else { session };
    let head = header(app, &session, usize::from(inner.width));
    f.render_widget(Paragraph::new(head), Rect { height: 3.min(inner.height), ..inner });
    let body = Rect { y: inner.y + 4, height: inner.height.saturating_sub(4), ..inner };
    let (lines, seqs) = transcript(app, t, body.width);
    let h = usize::from(body.height);
    let end = lines.len().saturating_sub(usize::from(app.scroll)).max(h.min(lines.len()));
    let start = end.saturating_sub(h);
    let mut tools = BTreeMap::new();
    for (i, seq) in seqs[start..end].iter().enumerate() {
        if let Some(seq) = seq {
            tools.insert(body.y + u16::try_from(i).unwrap_or(0), *seq);
        }
    }
    f.render_widget(Paragraph::new(lines[start..end].to_vec()), body);
    if app.scroll > 0 && start > 0 {
        let more = Rect { y: body.y + body.height.saturating_sub(1), height: 1, ..body };
        let text = format!(" ↓ {} more · G follows ", lines.len() - end);
        let tw = u16::try_from(text.chars().count()).unwrap_or(20);
        f.render_widget(Paragraph::new(Line::from(Span::styled(text, Style::default().fg(th.on_accent).bg(th.accent)))), Rect { x: more.x + more.width.saturating_sub(tw), width: tw.min(more.width), ..more });
    }
    tools
}

/// The changes the open task made, from its edit steps' diffs: (file, rows).
pub fn changes(t: &Transcript) -> Vec<(String, Vec<diff::Row>)> {
    let mut out: Vec<(String, Vec<diff::Row>)> = Vec::new();
    for turn in t.turns() {
        for (_, b) in t.events(s(&turn, "id")) {
            if let Some(rows) = diff::parse_unified(s(&b, "detail")) {
                let file = s(&b, "file").to_owned();
                match out.iter_mut().find(|(f, _)| *f == file) {
                    Some((_, r)) => r.extend(rows),
                    None => out.push((file, rows)),
                }
            }
        }
    }
    out
}

/// A pane's title line: the title bold (accent when focused), hints at the right, a rule under it.
fn pane_head(app: &App, title: &str, right: Vec<Span<'static>>, focused: bool, w: usize) -> Vec<Line<'static>> {
    let th = &app.th;
    let st = if focused { Style::default().fg(th.accent_ink).add_modifier(Modifier::BOLD) } else { th.strong() };
    vec![Line::from(split(vec![Span::styled(title.to_owned(), st)], right, w)), Line::from(Span::styled(g(app).rule().repeat(w), Style::default().fg(th.line)))]
}

/// Keys and what they do: the key in `ink`, the word in `muted`.
fn hints(th: &Theme, keys: &[(&str, &str)]) -> Vec<Span<'static>> {
    let mut out = Vec::new();
    for (i, (k, word)) in keys.iter().enumerate() {
        if i > 0 {
            out.push(Span::raw("  "));
        }
        out.push(Span::styled((*k).to_owned(), th.text().add_modifier(Modifier::BOLD)));
        out.push(Span::styled(format!(" {word}"), th.dim()));
    }
    out
}

fn side(f: &mut Frame<'_>, app: &App, r: Rect) {
    let th = &app.th;
    let which = app.side.unwrap_or(Side::Changes);
    let inner = padded(r);
    let w = usize::from(inner.width);
    let rel = |file: &str| file.strip_prefix(&format!("{}/", app.cwd)).unwrap_or(file).to_owned();
    let mut lines: Vec<Line<'static>> = pane_head(app, which.title(), hints(th, &[("p", "next"), ("d", "close")]), app.focus == Zone::Side, w);
    lines.push(Line::from(""));
    let mut body: Vec<Line<'static>> = Vec::new();
    if let Some(t) = &app.open {
        match which {
            Side::Changes => {
                for (file, rows) in changes(t) {
                    let (a, d) = diff::counts(&rows);
                    body.push(Line::from(vec![Span::styled(rel(&file), th.strong()), Span::styled(format!("  +{a}"), Style::default().fg(th.add)), Span::styled(format!(" −{d}"), Style::default().fg(th.del))]));
                    body.extend(diff::render(&rows, inner.width, th).0);
                    body.push(Line::from(""));
                }
            }
            Side::Files => {
                for (file, rows) in changes(t) {
                    let (a, d) = diff::counts(&rows);
                    body.push(Line::from(split(vec![Span::styled(rel(&file), th.text())], vec![Span::styled(format!("+{a}"), Style::default().fg(th.add)), Span::styled(format!(" −{d}"), Style::default().fg(th.del))], w)));
                }
            }
            Side::Terminal => {
                for turn in t.turns() {
                    for (_, b) in t.events(s(&turn, "id")) {
                        if s(&b, "kind") == "tool" && matches!(s(&b, "tool"), "bash" | "shell" | "run") {
                            body.push(Line::from(vec![Span::styled("$ ", Style::default().fg(th.accent_ink).add_modifier(Modifier::BOLD)), Span::styled(s(&b, "label").to_owned(), th.strong())]));
                            body.extend(s(&b, "output").lines().map(|l| Line::from(Span::styled(l.to_owned(), Style::default().fg(th.ink2)))));
                        } else if s(&b, "kind") == "tool_output" {
                            body.extend(s(&b, "text").lines().map(|l| Line::from(Span::styled(l.to_owned(), Style::default().fg(th.ink2)))));
                        }
                    }
                }
            }
            Side::Setup => body.extend(t.session().get("setup").map(|v| wisp_tui_api::detail_of(v, th)).unwrap_or_default()),
        }
    }
    if body.is_empty() {
        body.push(Line::from(Span::styled("Nothing here yet.", th.dim())));
    }
    lines.extend(wrap_all(body, w));
    f.render_widget(Paragraph::new(lines), inner);
}

fn view(f: &mut Frame<'_>, app: &App, id: &str, r: Rect) {
    let th = &app.th;
    let gl = g(app);
    let Some(v) = app.reg.find(id) else { return };
    let rows = app.views.get(id).cloned().unwrap_or_default();
    let inner = padded(r);
    let w = usize::from(inner.width);
    // the columns that fit: from the right, a fixed one goes when the row would run past the pane
    let mut cols = v.columns();
    while cols.len() > 1 && cols.iter().map(|c| usize::from(c.width.max(8)) + 2).sum::<usize>() + 1 > w {
        cols.pop();
    }
    let fixed: usize = cols.iter().map(|c| usize::from(c.width) + 2).sum();
    let rest = w.saturating_sub(fixed + 1).max(8);
    let widths: Vec<usize> = cols.iter().map(|c| if c.width == 0 { rest } else { usize::from(c.width) }).collect();
    let mut keys: Vec<(String, String)> = v.actions().iter().map(|a| (a.key.to_string(), a.label.clone())).collect();
    if let wisp_tui_api::Source::Command { args, .. } = v.source()
        && let Some(label) = wisp_tui_api::asks(&args)
    {
        keys.push(("A".to_owned(), label.to_lowercase()));
    }
    keys.extend([("r".to_owned(), "reload".to_owned()), ("Esc".to_owned(), "back".to_owned())]);
    let key_refs: Vec<(&str, &str)> = keys.iter().map(|(k, l)| (k.as_str(), l.as_str())).collect();
    // a view that asked for something (the file it blames) names it
    let head = rows.asked.as_ref().map_or_else(|| format!("{}  {}", v.title(), rows.rows.len()), |x| format!("{}  {x}", v.title()));
    let mut lines = pane_head(app, &head, hints(th, &key_refs), true, w);
    lines.push(Line::from(""));
    let row_of = |row: &Value, st: Style| -> Vec<Span<'static>> {
        let mut spans = Vec::new();
        for (c, cw) in cols.iter().zip(&widths) {
            // the view may colour a cell (a gutter); the selection's weight stays
            let own = v.style(row, c, th).map_or(st, |x| st.patch(x));
            spans.push(Span::styled(format!("{:<cw$}  ", cut(&cell(row, &c.pointer), *cw), cw = *cw), own));
        }
        spans
    };
    let mut head = vec![Span::raw(" ")];
    head.extend(cols.iter().zip(&widths).map(|(c, cw)| Span::styled(format!("{:<cw$}  ", cut(&c.title.to_uppercase(), *cw), cw = *cw), th.dim().add_modifier(Modifier::BOLD))));
    lines.push(Line::from(head));
    let detail_h = usize::from(r.height / 3);
    let list_h = usize::from(r.height).saturating_sub(lines.len() + detail_h + 2);
    let skip = rows.sel.saturating_sub(list_h.saturating_sub(1));
    for (i, row) in rows.rows.iter().enumerate().skip(skip).take(list_h) {
        let sel = i == rows.sel;
        let mut spans = vec![Span::styled(if sel { gl.bar() } else { " " }, Style::default().fg(th.accent))];
        spans.extend(row_of(row, if sel { th.strong() } else { th.text() }));
        lines.push(if sel { band(spans, w, th.bg2) } else { Line::from(spans) });
    }
    if rows.rows.is_empty() {
        lines.push(Line::from(Span::styled(if rows.loading { " Loading…" } else if rows.error.is_empty() { " Nothing here yet." } else { rows.error.as_str() }, th.dim())));
    }
    let used = lines.len();
    let to = usize::from(r.height).saturating_sub(detail_h + 1);
    lines.extend((used..to).map(|_| Line::from("")));
    if let Some(row) = rows.rows.get(rows.sel) {
        lines.push(Line::from(Span::styled(gl.rule().repeat(w), Style::default().fg(th.line))));
        let detail = v.detail(row, u16::try_from(w).unwrap_or(80), th).into_iter().map(|l| Line::from(l.spans.into_iter().map(|s| if s.style.fg == Some(th.muted) { s } else { s.style(th.text()) }).collect::<Vec<_>>()));
        lines.extend(wrap_all(detail.collect(), w).into_iter().take(detail_h));
    }
    f.render_widget(Paragraph::new(lines), inner);
}

fn queue_lines(app: &App, w: usize) -> Vec<Line<'static>> {
    let th = &app.th;
    let mut out: Vec<Line<'static>> = Vec::new();
    let queued = app.open.as_ref().map(Transcript::queue).unwrap_or_default();
    for (i, (_, text)) in queued.iter().enumerate() {
        out.push(Line::from(vec![Span::styled(format!("{} queued  ", i + 1), th.dim()), Span::styled(cut(text.lines().next().unwrap_or_default(), w.saturating_sub(12)), th.text())]));
    }
    for (_, text) in &app.sending {
        out.push(Line::from(vec![Span::styled("↑ sending  ", Style::default().fg(th.accent_ink)), Span::styled(cut(text.lines().next().unwrap_or_default(), w.saturating_sub(12)), th.text())]));
    }
    if !queued.is_empty() {
        out.push(Line::from(hints(th, &[("Alt-↑↓", "reorder"), ("Ctrl-S", "send the first now")])));
    }
    out
}

fn composer(f: &mut Frame<'_>, app: &App, r: Rect) {
    let th = &app.th;
    let focused = app.focus == Zone::Composer;
    let title = if app.new_task || app.sel.is_none() {
        "New task".to_owned()
    } else if app.running() {
        "Follow-up · queued while it runs".to_owned()
    } else {
        "Reply".to_owned()
    };
    let inner_w = usize::from(r.width.saturating_sub(4));
    let rows = app.composer.rows();
    let top = app.composer.cur.0.saturating_sub(rows - 1);
    let mut lines: Vec<Line<'static>> = app.composer.lines.iter().skip(top).take(rows).map(|l| Line::from(Span::styled(l.clone(), th.text()))).collect();
    if app.composer.is_empty() {
        lines = vec![Line::from(if focused {
            let mut h = vec![Span::styled("Write… ", th.dim())];
            h.extend(hints(th, &[("Enter", "send"), ("Alt-Enter", "new line"), ("@", "mention"), ("/", "command")]));
            h
        } else {
            hints(th, &[("i", "write"), ("?", "keys")])
        })];
    }
    let mut b = frame(th, &title, focused);
    if !app.composer.attachments.is_empty() {
        b = b.title_top(Line::from(Span::styled(format!(" {} attached ", app.composer.attachments.len()), Style::default().fg(th.accent_ink))).right_aligned());
    }
    if focused && app.running() && app.composer.is_empty() {
        b = b.title_bottom(Line::from(vec![Span::styled(" Esc", th.text().add_modifier(Modifier::BOLD)), Span::styled(" interrupts ", th.dim())]).right_aligned());
    }
    f.render_widget(Paragraph::new(lines).block(b), r);
    if focused && app.overlay.is_none() {
        let (row, col) = app.composer.cur;
        let x = r.x + 2 + u16::try_from(col.min(inner_w)).unwrap_or(0);
        let y = r.y + 1 + u16::try_from(row - top).unwrap_or(0);
        f.set_cursor_position(Position { x, y });
    }
}

/// The status bar, one line on `bg-2`: the mode pill, harness, model and machine at the left; the connection,
/// tokens and cost, and the key hints at the right.
fn status(f: &mut Frame<'_>, app: &App, r: Rect) {
    let th = &app.th;
    let session = app.open.as_ref().map(Transcript::session).unwrap_or_default();
    let turn = app.open.as_ref().and_then(Transcript::running).unwrap_or_default();
    let c = cx(app);
    let mode_bg = match app.mode {
        Mode::Plan => th.info,
        Mode::Edits => th.warn,
        Mode::Auto => th.good,
    };
    let mut left: Vec<Span<'static>> = vec![Span::raw(" "), Span::styled(format!(" {} ", app.mode.wire()), Style::default().fg(th.on_accent).bg(mode_bg).add_modifier(Modifier::BOLD)), Span::raw(" ")];
    let run = [cell(&session, "/agent"), cell(&session, "/model"), cell(&session, "/effort")].into_iter().filter(|x| !x.is_empty()).collect::<Vec<_>>();
    if !run.is_empty() {
        left.push(Span::styled(format!(" {}", run.join(" · ")), th.text()));
    }
    let machine = cell(&session, "/machine");
    if !machine.is_empty() {
        left.push(Span::styled(format!(" · on {machine}"), th.dim()));
    }
    let hold = cell(&session, "/budget/hold");
    if !hold.is_empty() {
        left.push(Span::styled(format!("  held: {hold}"), Style::default().fg(th.warn)));
    }
    left.extend(inputs(app, Slot::StatusLeft, &c));
    let gl = g(app);
    let mut right: Vec<Span<'static>> = inputs(app, Slot::StatusRight, &c);
    let (tokens, cost) = (cell(&turn, "/stats/tokens"), cell(&turn, "/stats/cost"));
    if !tokens.is_empty() {
        right.push(Span::styled(format!("{tokens} tok  "), th.dim()));
    }
    if !cost.is_empty() {
        right.push(Span::styled(format!("${cost}  "), th.dim()));
    }
    right.push(if app.online { Span::styled(format!("{} live", gl.dot()), Style::default().fg(th.good).add_modifier(Modifier::BOLD)) } else { Span::styled("○ offline", Style::default().fg(th.bad).add_modifier(Modifier::BOLD)) });
    right.push(Span::raw("   "));
    right.extend(hints(th, &[("?", "keys"), ("^K", "go"), ("q", "quit")]));
    right.push(Span::raw(" "));
    f.render_widget(Paragraph::new(band(split(left, right, usize::from(r.width)), usize::from(r.width), th.bg2)), r);
}

fn toasts(f: &mut Frame<'_>, app: &App, r: Rect) {
    let th = &app.th;
    for (i, t) in app.toasts.iter().rev().take(3).enumerate() {
        let w = u16::try_from(t.text.chars().count() + 6).unwrap_or(40).min(r.width.saturating_sub(2)).max(12);
        let a = Rect { x: r.x + r.width.saturating_sub(w + 1), y: r.y + 1 + u16::try_from(i * 3).unwrap_or(0), width: w, height: 3 };
        if a.y + 3 > r.y + r.height {
            break;
        }
        f.render_widget(Clear, a);
        let edge = Style::default().fg(if t.bad { th.bad } else { th.good });
        let mark = if t.bad { "✗ " } else { "✓ " };
        f.render_widget(
            Paragraph::new(Line::from(vec![Span::styled(mark, edge.add_modifier(Modifier::BOLD)), Span::styled(cut(&t.text, usize::from(w.saturating_sub(6))), th.text())]))
                .block(Block::default().borders(Borders::ALL).border_type(BorderType::Rounded).border_style(edge).style(Style::default().bg(th.bg2)).padding(Padding::horizontal(1))),
            a,
        );
    }
}

fn centered(r: Rect, w: u16, h: u16) -> Rect {
    let w = w.min(r.width.saturating_sub(2));
    let h = h.min(r.height.saturating_sub(2));
    Rect { x: r.x + (r.width - w) / 2, y: r.y + (r.height - h) / 3, width: w, height: h }
}

/// The `?` overlay, from the keymap: one column, or two when it's taller than the screen and the screen is wide.
fn help(f: &mut Frame<'_>, th: &Theme, area: Rect, scroll: u16) {
    let mut sections: Vec<Vec<Line<'static>>> = Vec::new();
    let mut last: Option<Where> = None;
    for (w, k, what) in KEYS {
        if last != Some(*w) {
            sections.push(vec![Line::from(Span::styled(w.title().to_uppercase(), Style::default().fg(th.accent_ink).add_modifier(Modifier::BOLD)))]);
            last = Some(*w);
        }
        if let Some(sec) = sections.last_mut() {
            sec.push(Line::from(vec![Span::styled(format!("  {k:<24}"), th.text().add_modifier(Modifier::BOLD)), Span::styled((*what).to_owned(), Style::default().fg(th.ink2))]));
        }
    }
    let join = |secs: &[Vec<Line<'static>>]| -> Vec<Line<'static>> { secs.iter().enumerate().flat_map(|(i, s)| if i == 0 { s.clone() } else { [vec![Line::from("")], s.clone()].concat() }).collect() };
    let all = join(&sections);
    let tall = u16::try_from(all.len()).unwrap_or(u16::MAX) + 2 > area.height.saturating_sub(2);
    let col_w: u16 = 96;
    if tall && area.width >= col_w * 2 + 4 {
        let half = all.len() / 2;
        let mut n = 0;
        let cut_at = sections.iter().position(|s| {
            n += s.len() + 1;
            n >= half
        });
        let k = cut_at.map_or(1, |i| i + 1).min(sections.len());
        let (left, right) = (join(&sections[..k]), join(&sections[k..]));
        let h = u16::try_from(left.len().max(right.len())).unwrap_or(u16::MAX) + 2;
        let r = centered(area, col_w * 2 + 2, h);
        f.render_widget(Clear, r);
        let b = frame(th, "Keys · any key closes", true);
        let inner = b.inner(r);
        f.render_widget(b, r);
        let cols = Layout::default().direction(Direction::Horizontal).constraints([Constraint::Percentage(50), Constraint::Percentage(50)]).split(inner);
        f.render_widget(Paragraph::new(left), cols[0]);
        f.render_widget(Paragraph::new(right), cols[1]);
        return;
    }
    // one column; taller than the screen, it scrolls with j k (the title says so)
    let h = u16::try_from(all.len()).unwrap_or(u16::MAX) + 2;
    let r = centered(area, col_w + 4, h);
    let shown = usize::from(r.height.saturating_sub(2));
    let top = usize::from(scroll).min(all.len().saturating_sub(shown));
    let title = if all.len() > shown { "Keys · j k scroll · any other key closes" } else { "Keys · any key closes" };
    let mut b = frame(th, title, true);
    if top + shown < all.len() {
        b = b.title_bottom(Line::from(Span::styled(format!(" ↓ {} more ", all.len() - top - shown), Style::default().fg(th.accent_ink))).right_aligned());
    }
    f.render_widget(Clear, r);
    f.render_widget(Paragraph::new(all[top..].to_vec()).block(b), r);
}

fn palette(f: &mut Frame<'_>, app: &App, p: &super::palette::Palette, area: Rect) {
    let th = &app.th;
    let r = centered(area, 72, 18);
    let w = usize::from(r.width.saturating_sub(4));
    let mut lines = vec![Line::from(vec![Span::styled(format!("{} ", g(app).prompt()), Style::default().fg(th.accent_ink).add_modifier(Modifier::BOLD)), Span::styled(p.query.clone(), th.text()), Span::styled("▏", Style::default().fg(th.accent))]), Line::from(Span::styled(g(app).rule().repeat(w), Style::default().fg(th.line)))];
    let shown = p.shown();
    let h = usize::from(r.height.saturating_sub(4));
    let skip = p.sel.saturating_sub(h.saturating_sub(1));
    for (i, it) in shown.iter().enumerate().skip(skip).take(h) {
        let sel = i == p.sel;
        let row = split(vec![Span::styled(if sel { g(app).bar() } else { " " }, Style::default().fg(th.accent)), Span::styled(format!(" {}", it.label), if sel { th.strong() } else { th.text() })], vec![Span::styled(cut(&it.kind, 16), th.dim())], w);
        lines.push(if sel { band(row, w, th.bg2) } else { Line::from(row) });
    }
    if shown.is_empty() {
        lines.push(Line::from(Span::styled(" No match.", th.dim())));
    }
    f.render_widget(Clear, r);
    f.render_widget(Paragraph::new(lines).block(frame(th, &p.title, true)), r);
}
