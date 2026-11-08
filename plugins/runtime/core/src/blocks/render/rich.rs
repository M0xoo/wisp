//! The block types whose stand-ins do more than fill a template (v1 `server/render.js`): diffs of the
//! captured edits, test runs, commits, branch graphs, flows, maps, interactive pages and spells.

use serde_json::Value;

use super::kinds::{lines, titled};
use super::{Context, Fields, Out, Thrown, blocks_to_markdown, fence, list};
use crate::blocks::diff::{Row, diff_lines, hunks};
use crate::blocks::js;
use crate::blocks::map_spec::{map_places, open_url, route_url};

/// `x.k` truthy, as a string, else ''.
fn truthy_s(x: Fields<'_>, k: &str) -> Option<String> {
    x.has(k).then(|| x.s(k))
}

fn unified(edits: &[(String, String)]) -> String {
    edits
        .iter()
        .map(|(before, after)| {
            hunks(&diff_lines(before, after), 3)
                .iter()
                .map(|row| match row {
                    Row::Gap(n) => {
                        format!("@@ {n} unchanged line{} @@", if *n > 1 { "s" } else { "" })
                    }
                    Row::Line(l) => format!("{}{}", l.op.sign(), l.text),
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .collect::<Vec<_>>()
        .join("\n@@ … @@\n")
}

/// v1's `findChange(turn, file)`: exact, else either path ending in the other.
fn captured(cx: &Context<'_>, file: &str) -> Option<Vec<(String, String)>> {
    if file.is_empty() {
        return None;
    }
    let tail = |a: &str, b: &str| a.ends_with(&format!("/{b}"));
    let c = cx.changes.iter().find(|c| c.file == file).or_else(|| {
        cx.changes
            .iter()
            .find(|c| tail(&c.file, file) || tail(file, &c.file))
    })?;
    Some(
        c.edits
            .iter()
            .map(|e| (e.before.clone(), e.after.clone()))
            .collect(),
    )
}

pub(super) fn diff(b: Fields<'_>, cx: &Context<'_>) -> String {
    let file = js::str_of(js::or(b.get("file"), b.get("path")));
    let edits = if b.get("before").is_some() || b.get("after").is_some() {
        Some(vec![(
            js::str_of(b.get("before")),
            js::str_of(b.get("after")),
        )])
    } else {
        captured(cx, &file)
    };
    let head = format!("**`{file}`**{}", b.opt("caption", " — ", ""));
    match edits {
        Some(e) if !e.is_empty() => format!("{head}\n\n{}", fence(&unified(&e), "diff")),
        _ => format!("{head} _(no captured edits)_"),
    }
}

pub(super) fn tests(b: Fields<'_>) -> Out {
    let n = |k: &str| {
        let x = js::to_number(b.get(k));
        if x.is_nan() { 0.0 } else { x }
    };
    let skipped = if n("skipped") == 0.0 {
        String::new()
    } else {
        format!(", {} skipped", js::number(n("skipped")))
    };
    let took = if b.has("durationMs") {
        format!(" ({}s)", js::to_fixed(n("durationMs") / 1000.0, 1))
    } else {
        String::new()
    };
    let head = format!(
        "**Tests** `{}` — {} passed, {} failed{skipped}{took}",
        b.s("command"),
        js::number(n("passed")),
        js::number(n("failed"))
    );
    let mut out = vec![head];
    for f in list(b.get("failures")) {
        let x = Fields::item(Some(f))?;
        out.push(format!(
            "- ❌ {}{}{}",
            x.s("name"),
            x.opt("message", ": ", ""),
            x.opt("file", " (`", "`)")
        ));
    }
    Ok(out.join("\n"))
}

fn short_hash(x: Fields<'_>) -> String {
    js::slice_utf16_lossy(&x.s("hash"), 7)
}

pub(super) fn commits(b: Fields<'_>) -> Out {
    let items = lines(list(b.get("items")), |_, c| {
        let x = Fields::item(Some(c))?;
        let counts = match x.get("additions") {
            None => String::new(),
            Some(a) => {
                let del = match x.get("deletions") {
                    None | Some(Value::Null) => "0".to_owned(),
                    Some(d) => js::string(d),
                };
                format!(" (+{}/−{del})", js::string(a))
            }
        };
        Ok(format!("- `{}` {}{counts}", short_hash(x), x.s("message")))
    })?;
    Ok(format!(
        "{}{items}",
        b.opt("branch", "**Branch** `", "`\n\n")
    ))
}

fn graph_head(b: Fields<'_>) -> String {
    let title = truthy_s(b, "title").unwrap_or_else(|| "Branches".to_owned());
    let into = if b.has("into") {
        format!(" → `{}`{}", b.s("into"), b.opt("merge", " (", ")"))
    } else {
        String::new()
    };
    format!(
        "**{title}**{}{}{into}",
        b.opt("ref", " ", ""),
        b.opt("state", " · ", "")
    )
}

fn conflict(i: usize, c: &Value) -> String {
    let file_only;
    let o = match c {
        Value::String(s) => {
            file_only = serde_json::json!({ "file": s });
            Fields::item(Some(&file_only)).unwrap_or(Fields(None))
        }
        Value::Object(m) => Fields::of(m),
        _ => Fields(None),
    };
    let at = js::or(o.get("line"), o.get("lines"));
    let at = if js::truthy(at) {
        format!(":{}", js::str_of(at))
    } else {
        String::new()
    };
    format!(
        "{}. `{}{at}`{}{}{}{}",
        i + 1,
        o.s("file"),
        o.opt("detail", " — ", ""),
        o.opt("ours", "\n   - ours: `", "`"),
        o.opt("theirs", "\n   - theirs: `", "`"),
        o.opt("resolution", "\n   - ✔︎ ", "")
    )
}

pub(super) fn graph(b: Fields<'_>) -> Out {
    let commits = lines(list(b.get("commits")), |_, c| {
        let x = Fields::item(Some(c))?;
        let warn = if x.has("conflict") { "⚠️ " } else { "" };
        let who = if x.has("author") {
            format!(" — {}{}", x.s("author"), x.opt("when", ", ", ""))
        } else {
            String::new()
        };
        Ok(format!(
            "- {warn}`{}` {}{}{who}",
            short_hash(x),
            x.s("message"),
            x.opt("branch", " [", "]")
        ))
    })?;
    let conflicts: Vec<String> = list(b.get("conflicts"))
        .iter()
        .enumerate()
        .map(|(i, c)| conflict(i, c))
        .collect();
    let mut checks = Vec::new();
    for c in list(b.get("checks")) {
        let x = Fields::item(Some(c))?;
        let mark = match x.get("status").and_then(Value::as_str) {
            Some("fail") => "❌",
            Some("pending") => "⏳",
            _ => "✅",
        };
        checks.push(format!(
            "{mark} {}{}",
            js::str_of(js::or(x.get("label"), Some(c))),
            x.opt("value", " ", "")
        ));
    }
    let conflicts = if conflicts.is_empty() {
        String::new()
    } else {
        format!("**Conflicts**\n{}", conflicts.join("\n"))
    };
    let parts = [
        graph_head(b),
        commits,
        conflicts,
        checks.join(" · "),
        truthy_s(b, "summary").unwrap_or_default(),
    ];
    Ok(parts
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// `[a, z, l]` destructured from an edge, as JavaScript does (a string gives its characters).
fn edge_parts(e: &Value) -> Result<[Option<Value>; 3], Thrown> {
    match e {
        Value::Array(a) => Ok([a.first().cloned(), a.get(1).cloned(), a.get(2).cloned()]),
        Value::String(s) => {
            let mut it = s.chars().map(|c| Value::String(c.to_string()));
            Ok([it.next(), it.next(), it.next()])
        }
        _ => Err(Thrown),
    }
}

pub(super) fn flow(b: Fields<'_>) -> Out {
    let nodes = list(b.get("nodes"));
    for n in nodes {
        if n.is_null() {
            return Err(Thrown);
        }
    }
    let label = |id: Option<&Value>| {
        let found = nodes
            .iter()
            .find(|n| js::strict_eq(n.get("id"), id))
            .and_then(|n| n.get("label"));
        if js::truthy(found) {
            js::str_of(found)
        } else {
            js::tpl(id)
        }
    };
    let given = list(b.get("edges"));
    let edges: Vec<[Option<Value>; 3]> = if given.is_empty() {
        nodes
            .windows(2)
            .map(|w| [w[0].get("id").cloned(), w[1].get("id").cloned(), None])
            .collect()
    } else {
        given.iter().map(edge_parts).collect::<Result<_, _>>()?
    };
    let items: Vec<String> = edges
        .iter()
        .map(|[a, z, l]| {
            let note = if js::truthy(l.as_ref()) {
                format!(" _({})_", js::tpl(l.as_ref()))
            } else {
                String::new()
            };
            format!("- {} → {}{note}", label(a.as_ref()), label(z.as_ref()))
        })
        .collect();
    Ok(format!("{}{}", titled(b), items.join("\n")))
}

pub(super) fn map(b: Fields<'_>) -> Out {
    let Some(m) = b.0 else {
        return Ok(format!("**📍 Places**\n{}", b.opt("caption", "\n\n", "")));
    };
    let ps = map_places(m);
    if ps.iter().any(|p| p.torn) {
        return Err(Thrown);
    }
    let route = if b.has("route") {
        route_url(&ps)
            .map(|r| format!(" · [Route]({r})"))
            .unwrap_or_default()
    } else {
        String::new()
    };
    let items: Vec<String> = ps
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let name = if p.name.is_empty() {
                String::new()
            } else {
                format!("**{}** — ", p.name)
            };
            let addr = if p.address.is_empty() {
                &p.q
            } else {
                &p.address
            };
            let note = if p.note.is_empty() {
                String::new()
            } else {
                format!(" — {}", p.note)
            };
            format!("{}. {name}[{addr}]({}){note}", i + 1, open_url(p))
        })
        .collect();
    let title = truthy_s(b, "title").unwrap_or_else(|| "Places".to_owned());
    Ok(format!(
        "**📍 {title}**{route}\n{}{}",
        items.join("\n"),
        b.opt("caption", "\n\n", "")
    ))
}

/// An interactive page only runs in wisp's page: its fallback blocks stand in for it here.
pub(super) fn app(b: Fields<'_>, cx: &Context<'_>) -> String {
    let fb: Vec<Value> = list(b.get("fallback"))
        .iter()
        .filter(|x| {
            js::truthy(x.get("type")) && x.get("type").and_then(Value::as_str) != Some("app")
        })
        .cloned()
        .collect();
    let rest = if fb.is_empty() {
        String::new()
    } else {
        format!("\n\n{}", blocks_to_markdown(&fb, cx))
    };
    let title = truthy_s(b, "title").unwrap_or_else(|| "Interactive".to_owned());
    format!("**🧩 {title}** _(interactive: open it in wisp)_{rest}")
}

pub(super) fn spell(b: Fields<'_>) -> String {
    let spell = b.get("spell");
    let own = |k: &str| spell.and_then(|s| s.get(k));
    let remove = if b.has("remove") {
        b.get("remove")
    } else if !js::truthy(own("wispSpell")) {
        own("remove")
    } else {
        None
    };
    if js::truthy(remove) {
        return format!("**🧙 Spell:** remove `{}`", js::str_of(remove));
    }
    let name = js::str_of(own("name"));
    let name = if name.is_empty() {
        js::str_of(own("id"))
    } else {
        name
    };
    let desc = own("description")
        .filter(|d| js::truthy(Some(d)))
        .map(|d| format!(" — {}", js::string(d)))
        .unwrap_or_default();
    format!("**🧙 Spell: {name}**{desc}\n\n_Keep it in wisp to turn it on._")
}
