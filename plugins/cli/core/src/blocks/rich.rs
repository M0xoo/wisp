//! The structured blocks: files, diff, commits, graph, tree, compare, flow, chart, and the pointers
//! (image, video, preview, doc, task, stuff, map, app) as titled, clickable links.

use std::fmt::Write as _;

use serde_json::Value;
use wisp_cli_api::{Images, Style};

use super::{IMAGE_MARK, caption, items, s, text_of, title};
use crate::term::{self, BLUE, BOLD, CYAN, DIM, GREEN, MAGENTA, RED, YELLOW, paint};

fn change(st: &Style, c: &str) -> String {
    match c {
        "added" => paint(st, GREEN, "A"),
        "deleted" => paint(st, RED, "D"),
        "renamed" => paint(st, BLUE, "R"),
        _ => paint(st, YELLOW, "M"),
    }
}

fn counts(st: &Style, i: &Value) -> String {
    let n = |k: &str| i.get(k).and_then(Value::as_u64);
    match (n("additions"), n("deletions")) {
        (None, None) => String::new(),
        (a, d) => format!("  {} {}", paint(st, GREEN, &format!("+{}", a.unwrap_or(0))), paint(st, RED, &format!("−{}", d.unwrap_or(0)))),
    }
}

pub fn files(b: &Value, st: &Style) -> Vec<String> {
    let mut out = Vec::new();
    title(st, b, &mut out);
    for i in items(b) {
        let note = s(i, "note");
        let line = format!("{} {}{}", change(st, s(i, "change")), paint(st, BOLD, s(i, "path")), counts(st, i));
        out.push(term::truncate(&line, st.width));
        if !note.is_empty() {
            out.extend(term::wrap(note, st.width.saturating_sub(2)).into_iter().map(|l| format!("  {}", paint(st, DIM, &l))));
        }
    }
    out
}

/// A unified diff's lines, coloured: hunk headers, removals, additions.
fn unified(st: &Style, text: &str) -> Vec<String> {
    text.lines()
        .map(|l| {
            let l2 = term::truncate(l, st.width);
            if l.starts_with("@@") {
                paint(st, CYAN, &l2)
            } else if l.starts_with("+++") || l.starts_with("---") {
                paint(st, BOLD, &l2)
            } else if l.starts_with('+') {
                paint(st, GREEN, &l2)
            } else if l.starts_with('-') {
                paint(st, RED, &l2)
            } else {
                l2
            }
        })
        .collect()
}

pub fn diff(b: &Value, st: &Style) -> Vec<String> {
    let file = if s(b, "file").is_empty() { s(b, "path") } else { s(b, "file") };
    let mut out = vec![term::truncate(&format!("{} {}", paint(st, DIM, "±"), paint(st, BOLD, file)), st.width)];
    caption(st, b, &mut out);
    let patch = ["patch", "diff", "unified"].iter().map(|k| s(b, k)).find(|p| !p.is_empty());
    if let Some(p) = patch {
        out.extend(unified(st, p));
    } else if b.get("before").is_some() || b.get("after").is_some() {
        let mut u = String::from("@@\n");
        for l in s(b, "before").lines() {
            let _ = writeln!(u, "-{l}");
        }
        for l in s(b, "after").lines() {
            let _ = writeln!(u, "+{l}");
        }
        out.extend(unified(st, &u));
    } else {
        out.push(paint(st, DIM, "  (the edits are in wisp: wisp open)"));
    }
    out
}

fn short(h: &str) -> &str {
    h.get(..7).unwrap_or(h)
}

pub fn commits(b: &Value, st: &Style) -> Vec<String> {
    let mut out = Vec::new();
    let branch = s(b, "branch");
    if !branch.is_empty() {
        out.push(format!("{} {}", paint(st, MAGENTA, "⎇"), paint(st, BOLD, branch)));
    }
    for i in items(b) {
        let files = i.get("files").and_then(Value::as_u64).map_or(String::new(), |n| paint(st, DIM, &format!("  {n} file{}", if n == 1 { "" } else { "s" })));
        let tail = format!("{}{files}", counts(st, i));
        let head = format!("{} ", paint(st, YELLOW, short(s(i, "hash"))));
        let room = st.width.saturating_sub(term::width(&head) + term::width(&tail));
        out.push(format!("{head}{}{tail}", term::truncate(s(i, "message"), room.max(8))));
    }
    out
}

pub fn graph(b: &Value, st: &Style) -> Vec<String> {
    let mut out = Vec::new();
    let state = [s(b, "state"), s(b, "merge")].iter().filter(|x| !x.is_empty()).copied().collect::<Vec<_>>().join(" · ");
    let head = format!("{}{}{}", paint(st, BOLD, s(b, "title")), if s(b, "ref").is_empty() { String::new() } else { format!(" {}", s(b, "ref")) }, if state.is_empty() { String::new() } else { format!("  {}", paint(st, DIM, &format!("[{state}]"))) });
    out.extend(term::wrap(&head, st.width));
    let into = s(b, "into");
    for c in b.get("commits").and_then(Value::as_array).into_iter().flatten() {
        let on_base = !into.is_empty() && s(c, "branch") == into;
        let dot = if c.get("conflict").and_then(Value::as_bool) == Some(true) { paint(st, RED, "✗") } else if on_base { paint(st, DIM, "○") } else { paint(st, GREEN, "●") };
        let lane = if on_base { "  " } else { "" };
        let br = if s(c, "branch").is_empty() { String::new() } else { paint(st, DIM, &format!("  [{}]", s(c, "branch"))) };
        out.push(term::truncate(&format!("{lane}{dot} {} {}{br}", paint(st, YELLOW, short(s(c, "hash"))), s(c, "message")), st.width));
    }
    for c in b.get("conflicts").and_then(Value::as_array).into_iter().flatten() {
        let at = b.get("line").map_or_else(|| text_of(c.get("line")), |_| String::new());
        let place = if at.is_empty() { s(c, "file").to_owned() } else { format!("{}:{at}", s(c, "file")) };
        out.extend(term::hang(&format!("{} ", paint(st, RED, "⚠")), &format!("{place} — {}", s(c, "detail")), st.width));
        let res = s(c, "resolution");
        if !res.is_empty() {
            out.extend(term::hang("    → ", res, st.width));
        }
    }
    for c in b.get("checks").and_then(Value::as_array).into_iter().flatten() {
        let m = match s(c, "status") {
            "pass" => paint(st, GREEN, "✓"),
            "fail" => paint(st, RED, "✗"),
            _ => paint(st, YELLOW, "◌"),
        };
        out.push(term::truncate(&format!("{m} {}  {}", s(c, "label"), paint(st, DIM, s(c, "value"))), st.width));
    }
    out
}

/// One folder or file of a `tree` block.
#[derive(Default)]
struct Node<'a> {
    name: &'a str,
    item: Option<&'a Value>,
    kids: Vec<Node<'a>>,
}

fn insert<'a>(n: &mut Node<'a>, parts: &[&'a str], item: &'a Value) {
    let Some((first, rest)) = parts.split_first() else { return };
    let at = if let Some(i) = n.kids.iter().position(|k| k.name == *first && (k.item.is_none() || rest.is_empty())) {
        i
    } else {
        n.kids.push(Node { name: first, ..Node::default() });
        n.kids.len() - 1
    };
    if rest.is_empty() {
        n.kids[at].item = Some(item);
    } else {
        insert(&mut n.kids[at], rest, item);
    }
}

fn draw(st: &Style, n: &Node<'_>, lead: &str, out: &mut Vec<String>) {
    for (i, k) in n.kids.iter().enumerate() {
        let last = i + 1 == n.kids.len();
        let folder = !k.kids.is_empty();
        let name = if folder { paint(st, BLUE, &format!("{}/", k.name)) } else { k.name.to_owned() };
        let tail = k.item.map_or(String::new(), |item| {
            let (c, note) = (s(item, "change"), s(item, "note"));
            format!("{}{}", if c.is_empty() { String::new() } else { format!(" {}", change(st, c)) }, if note.is_empty() { String::new() } else { paint(st, DIM, &format!("  {note}")) })
        });
        out.push(term::truncate(&format!("{}{name}{tail}", paint(st, DIM, &format!("{lead}{}", if last { "└── " } else { "├── " }))), st.width));
        if folder {
            draw(st, k, &format!("{lead}{}", if last { "    " } else { "│   " }), out);
        }
    }
}

/// Paths drawn as a tree (`├── src/`, `│   └── a.ts`), each with its change and note.
pub fn tree(b: &Value, st: &Style) -> Vec<String> {
    let mut out = Vec::new();
    title(st, b, &mut out);
    let mut root = Node::default();
    for i in items(b) {
        let parts: Vec<&str> = s(i, "path").split('/').filter(|p| !p.is_empty()).collect();
        insert(&mut root, &parts, i);
    }
    draw(st, &root, "", &mut out);
    out
}

fn side<'a>(b: &'a Value, k: &str) -> (&'a str, Vec<&'a str>) {
    let v = b.get(k);
    let label = v.and_then(|x| x.get("label")).and_then(Value::as_str).unwrap_or(if k == "before" { "Before" } else { "After" });
    let list = v.and_then(|x| x.get("items")).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    (label, list)
}

pub fn compare(b: &Value, st: &Style) -> Vec<String> {
    let (bl, bi) = side(b, "before");
    let (al, ai) = side(b, "after");
    if st.width >= 60 {
        let col = (st.width - 3) / 2;
        let mut out = vec![format!("{}   {}", term::pad(&paint(st, BOLD, bl), col), paint(st, BOLD, al))];
        let left: Vec<String> = bi.iter().flat_map(|x| term::hang(&format!("{} ", paint(st, RED, "−")), x, col)).collect();
        let right: Vec<String> = ai.iter().flat_map(|x| term::hang(&format!("{} ", paint(st, GREEN, "+")), x, col)).collect();
        for n in 0..left.len().max(right.len()) {
            let l = left.get(n).cloned().unwrap_or_default();
            let r = right.get(n).cloned().unwrap_or_default();
            out.push(format!("{}   {r}", term::pad(&l, col)).trim_end().to_owned());
        }
        return out;
    }
    let mut out = vec![paint(st, BOLD, bl)];
    out.extend(bi.iter().flat_map(|x| term::hang(&format!("{} ", paint(st, RED, "−")), x, st.width)));
    out.push(paint(st, BOLD, al));
    out.extend(ai.iter().flat_map(|x| term::hang(&format!("{} ", paint(st, GREEN, "+")), x, st.width)));
    out
}

pub fn flow(b: &Value, st: &Style) -> Vec<String> {
    let mut out = Vec::new();
    title(st, b, &mut out);
    let nodes: Vec<&Value> = b.get("nodes").and_then(Value::as_array).into_iter().flatten().collect();
    let label = |id: &str| nodes.iter().find(|n| s(n, "id") == id).map_or(id.to_owned(), |n| s(n, "label").to_owned());
    let edges: Vec<&Value> = b.get("edges").and_then(Value::as_array).into_iter().flatten().collect();
    if edges.is_empty() {
        let chain: Vec<String> = nodes.iter().map(|n| paint(st, BOLD, s(n, "label"))).collect();
        out.extend(term::wrap(&chain.join(&format!(" {} ", paint(st, DIM, "→"))), st.width));
    } else {
        for e in edges {
            let a = e.as_array().map_or(&[][..], Vec::as_slice);
            let txt = |i: usize| a.get(i).and_then(Value::as_str).unwrap_or("");
            let via = if txt(2).is_empty() { String::new() } else { paint(st, DIM, &format!("  ({})", txt(2))) };
            out.extend(term::wrap(&format!("{} {} {}{via}", paint(st, BOLD, &label(txt(0))), paint(st, DIM, "→"), paint(st, BOLD, &label(txt(1)))), st.width));
        }
    }
    for n in &nodes {
        let note = s(n, "note");
        if !note.is_empty() {
            out.extend(term::hang(&format!("  {}: ", s(n, "label")), &paint(st, DIM, note), st.width));
        }
    }
    out
}

pub fn chart(b: &Value, st: &Style) -> Vec<String> {
    let mut out = Vec::new();
    title(st, b, &mut out);
    let unit = s(b, "unit");
    let rows: Vec<(&str, f64)> = items(b).iter().map(|i| (s(i, "label"), i.get("value").and_then(Value::as_f64).unwrap_or(0.0))).collect();
    let max = rows.iter().map(|r| r.1).fold(0.0_f64, f64::max);
    let lw = rows.iter().map(|r| term::width(r.0)).max().unwrap_or(0).min(st.width / 3);
    let vals: Vec<String> = rows.iter().map(|r| format!("{}{unit}", trim_num(r.1))).collect();
    let vw = vals.iter().map(|v| term::width(v)).max().unwrap_or(0);
    let room = st.width.saturating_sub(lw + vw + 4).max(4);
    for ((label, v), val) in rows.iter().zip(vals) {
        // whole cells of the room, rounded half up, at least one for a value above zero
        let cells = if max > 0.0 { (v / max * f64::from(u32::try_from(room).unwrap_or(u32::MAX))).round() } else { 0.0 };
        let n = if *v > 0.0 { format!("{cells:.0}").parse::<usize>().unwrap_or(0).max(1) } else { 0 };
        out.push(format!("{}  {} {}", term::pad(&term::truncate(label, lw), lw), paint(st, CYAN, &"█".repeat(n.min(room))), paint(st, DIM, &val)));
    }
    out
}

fn trim_num(v: f64) -> String {
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_owned()
}

fn file_url(path: &str) -> String {
    if path.contains("://") { path.to_owned() } else { format!("file://{}", path.replace(' ', "%20")) }
}

pub fn media(b: &Value, st: &Style) -> Vec<String> {
    let path = s(b, "path");
    let icon = if s(b, "type") == "video" { "▶" } else { "▣" };
    let mut out = Vec::new();
    if st.images != Images::None && s(b, "type") == "image" {
        out.push(format!("{IMAGE_MARK}{path}"));
    }
    out.push(term::truncate(&format!("{} {}", paint(st, MAGENTA, icon), term::link(st, path, &file_url(path))), st.width));
    caption(st, b, &mut out);
    out
}

fn pointer(st: &Style, icon: &str, label: &str, url: &str, note: &str, hint: &str) -> Vec<String> {
    let mut out = term::wrap(&format!("{} {}", paint(st, BLUE, icon), term::link(st, &paint(st, BOLD, label), url)), st.width);
    if !note.is_empty() {
        out.extend(term::hang("  ", note, st.width));
    }
    if !hint.is_empty() {
        out.push(paint(st, DIM, &term::truncate(&format!("  {hint}"), st.width)));
    }
    out
}

pub fn preview(b: &Value, st: &Style) -> Vec<String> {
    let url = s(b, "url");
    let t = if s(b, "title").is_empty() { url } else { s(b, "title") };
    let note = if s(b, "caption").is_empty() { url } else { s(b, "caption") };
    pointer(st, "◫", t, url, note, "")
}

pub fn doc(b: &Value, st: &Style) -> Vec<String> {
    let path = s(b, "path");
    let t = if s(b, "title").is_empty() { path } else { s(b, "title") };
    pointer(st, "▤", t, &file_url(path), s(b, "caption"), path)
}

pub fn task(b: &Value, st: &Style) -> Vec<String> {
    let id = s(b, "id");
    pointer(st, "↗", &format!("task {id}"), "", s(b, "note"), &format!("wisp attach {id}"))
}

pub fn stuff(b: &Value, st: &Style) -> Vec<String> {
    let id = s(b, "id");
    pointer(st, "▣", "My Stuff", "", s(b, "note"), &format!("wisp stuff get {id}"))
}

fn enc(x: &str) -> String {
    x.bytes().map(|c| if c.is_ascii_alphanumeric() || b"-_.~".contains(&c) { (c as char).to_string() } else { format!("%{c:02X}") }).collect()
}

pub fn map(b: &Value, st: &Style) -> Vec<String> {
    let mut out = Vec::new();
    title(st, b, &mut out);
    let places: Vec<&Value> = b.get("places").and_then(Value::as_array).into_iter().flatten().collect();
    for p in &places {
        let q = if s(p, "address").is_empty() { format!("{},{}", text_of(p.get("lat")), text_of(p.get("lng"))) } else { s(p, "address").to_owned() };
        let url = format!("https://www.google.com/maps/search/?api=1&query={}", enc(&q));
        out.extend(term::wrap(&format!("{} {}", paint(st, RED, "◉"), term::link(st, &paint(st, BOLD, s(p, "name")), &url)), st.width));
        out.extend(term::hang("  ", &q, st.width));
        let note = s(p, "note");
        if !note.is_empty() {
            out.extend(term::wrap(note, st.width.saturating_sub(2)).into_iter().map(|l| format!("  {}", paint(st, DIM, &l))));
        }
    }
    if b.get("route").and_then(Value::as_bool) == Some(true) && places.len() > 1 {
        let stops: Vec<String> = places.iter().map(|p| enc(if s(p, "address").is_empty() { s(p, "name") } else { s(p, "address") })).collect();
        out.push(term::link(st, "Directions", &format!("https://www.google.com/maps/dir/{}", stops.join("/"))));
    }
    out
}

pub fn app(b: &Value, st: &Style) -> Vec<String> {
    let t = if s(b, "title").is_empty() { "An app" } else { s(b, "title") };
    pointer(st, "▣", t, s(b, "url"), s(b, "description"), "Open it in wisp")
}
