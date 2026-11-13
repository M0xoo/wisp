//! The built-in block types' text stand-ins, one per type, as v1's `R` table.

use serde_json::Value;

use super::{Context, Fields, Out, fence, list, prop, rich};
use crate::blocks::js;

/// None: not a built-in type (the caller tries a contributed one, then JSON).
pub(super) fn render(ty: &str, b: Fields<'_>, cx: &Context<'_>) -> Option<Out> {
    Some(match ty {
        "hero" => Ok(hero(b)),
        "markdown" => Ok(b.s("text")),
        "steps" => steps(b),
        "stats" => stats(b),
        "files" => files(b),
        "tree" => tree(b),
        "diff" => Ok(rich::diff(b, cx)),
        "code" => Ok(code(b)),
        "tests" => rich::tests(b),
        "commits" => rich::commits(b),
        "graph" => rich::graph(b),
        "terminal" => Ok(terminal(b)),
        "compare" => Ok(compare(b)),
        "flow" => rich::flow(b),
        "chart" => chart(b),
        "checklist" => checklist(b),
        "callout" => Ok(callout(b)),
        "image" => Ok(media("🖼️", b)),
        "video" => Ok(media("🎬", b)),
        "preview" => Ok(preview(b)),
        "map" => rich::map(b),
        "doc" => Ok(doc(b)),
        "stuff" => Ok(pointer(b, "📦", "Something in My Stuff", "My Stuff")),
        "task" => Ok(pointer(b, "🔗", "A wisp task", "wisp task")),
        "question" => question(b),
        "blocked" => blocked(b, cx),
        "actions" => actions(b),
        "next" => Ok(format!("**Next**\n{}", bullets(list(b.get("items"))))),
        "app" => Ok(rich::app(b, cx)),
        _ => return None,
    })
}

/// Each item through `line`; the first item v1 would throw on fails the block.
pub(super) fn lines<'a>(items: &'a [Value], mut line: impl FnMut(usize, &'a Value) -> Out) -> Out {
    let mut out = Vec::with_capacity(items.len());
    for (i, x) in items.iter().enumerate() {
        out.push(line(i, x)?);
    }
    Ok(out.join("\n"))
}

fn bullets(items: &[Value]) -> String {
    items.iter().map(|i| format!("- {}", js::str_of(Some(i)))).collect::<Vec<_>>().join("\n")
}

/// `**title**\n\n` when the block has one.
pub(super) fn titled(b: Fields<'_>) -> String {
    b.opt("title", "**", "**\n\n")
}

fn or_default(s: String, default: &str) -> String {
    if s.is_empty() { default.to_owned() } else { s }
}

fn hero(b: Fields<'_>) -> String {
    let status = match b.get("status").and_then(Value::as_str) {
        Some("partial") => "🟡 Partly done",
        Some("blocked") => "⛔ Blocked",
        Some("info") => "ℹ️ Report",
        _ => "✅ Done",
    };
    format!("## {}\n\n**{status}**{}", or_default(b.s("title"), "Done"), b.opt("summary", " — ", ""))
}

fn steps(b: Fields<'_>) -> Out {
    let items = lines(list(b.get("items")), |i, s| {
        let x = Fields::item(Some(s))?;
        let mark = match x.get("status").and_then(Value::as_str) {
            Some("failed") => "❌",
            Some("skipped") => "⏭️",
            _ => "✔︎",
        };
        Ok(format!("{}. {mark} **{}**{}", i + 1, x.s("title"), x.opt("detail", " — ", "")))
    })?;
    Ok(format!("{}{items}", titled(b)))
}

fn stats(b: Fields<'_>) -> Out {
    lines(list(b.get("items")), |_, s| {
        let x = Fields::item(Some(s))?;
        Ok(format!("- **{}:** {}{}{}", x.s("label"), x.s("value"), x.s("unit"), x.opt("delta", " (", ")")))
    })
}

fn files(b: Fields<'_>) -> Out {
    lines(list(b.get("items")), |_, f| {
        let x = Fields::item(Some(f))?;
        let change = match x.get("change").and_then(Value::as_str) {
            Some("added") => "A",
            Some("deleted") => "D",
            Some("renamed") => "R",
            _ => "M",
        };
        Ok(format!("- `{change}` `{}`{}", x.s("path"), x.opt("note", " — ", "")))
    })
}

fn tree(b: Fields<'_>) -> Out {
    let items = lines(list(b.get("items")), |_, f| {
        let x = Fields::item(Some(f))?;
        Ok(format!("- `{}`{}{}", x.s("path"), x.opt("change", " (", ")"), x.opt("note", " — ", "")))
    })?;
    Ok(format!("{}{items}", titled(b)))
}

fn code(b: Fields<'_>) -> String {
    let head = if b.has("file") {
        format!("**`{}{}`**{}\n\n", b.s("file"), b.opt("line", ":", ""), b.opt("caption", " — ", ""))
    } else {
        b.opt("caption", "", "\n\n")
    };
    format!("{head}{}", fence(&b.s("code"), &b.s("language")))
}

fn terminal(b: Fields<'_>) -> String {
    let exit = match b.get("exitCode") {
        None => String::new(),
        Some(Value::Number(n)) if n.as_f64() == Some(0.0) => String::new(),
        Some(v) => format!("\n[exit {}]", js::string(v)),
    };
    let command = if b.has("command") { format!("$ {}\n", b.s("command")) } else { String::new() };
    fence(&format!("{command}{}{exit}", b.s("output")), "console")
}

fn compare(b: Fields<'_>) -> String {
    [("before", "Before"), ("after", "After")]
        .map(|(k, default)| {
            let side = b.get(k);
            format!("**{}**\n{}", or_default(js::str_of(prop(side, "label")), default), bullets(list(prop(side, "items"))))
        })
        .join("\n\n")
}

fn chart(b: Fields<'_>) -> Out {
    let unit = b.s("unit");
    let items = lines(list(b.get("items")), |_, i| {
        let x = Fields::item(Some(i))?;
        Ok(format!("- {}: {}{unit}", x.s("label"), x.s("value")))
    })?;
    Ok(format!("{}{items}", titled(b)))
}

fn checklist(b: Fields<'_>) -> Out {
    let items = lines(list(b.get("items")), |_, i| {
        let x = Fields::item(Some(i))?;
        Ok(format!("- [{}] {}", if x.has("done") { 'x' } else { ' ' }, x.s("text")))
    })?;
    Ok(format!("{}{items}", titled(b)))
}

fn callout(b: Fields<'_>) -> String {
    let icon = match b.get("tone").and_then(Value::as_str) {
        Some("danger") => "⛔",
        Some("warn") => "⚠️",
        Some("success") => "✅",
        _ => "ℹ️",
    };
    format!("> **{icon} {}**\n> {}", b.s("title"), b.s("text").replace('\n', "\n> "))
}

fn media(icon: &str, b: Fields<'_>) -> String {
    format!("{icon} `{}`{}", js::str_of(js::or(b.get("path"), b.get("src"))), b.opt("caption", " — ", ""))
}

fn preview(b: Fields<'_>) -> String {
    let what = js::or(b.get("caption"), b.get("title"));
    let what = if js::truthy(what) { format!(" — {}", js::str_of(what)) } else { String::new() };
    format!("🌐 {}{}{what}", b.s("url"), b.opt("device", " (", ")"))
}

fn doc(b: Fields<'_>) -> String {
    let title = or_default(b.s("title"), &format!("`{}`", b.s("path")));
    let path = if b.has("title") && b.has("path") { format!(" `{}`", b.s("path")) } else { String::new() };
    let text = b.opt("text", "\n\n<details><summary>Show the file</summary>\n\n", "\n\n</details>");
    format!("📄 **{title}**{path}{}{text}", b.opt("caption", " — ", ""))
}

fn pointer(b: Fields<'_>, icon: &str, default: &str, what: &str) -> String {
    format!("{icon} **{}** ({what} `{}`){}", or_default(b.s("title"), default), b.s("id"), b.opt("note", " — ", ""))
}

fn question(b: Fields<'_>) -> Out {
    let options = lines(list(b.get("options")), |i, x| {
        let label = Fields::item(Some(x))?.get("label");
        Ok(format!("{}. {}", i + 1, js::str_of(js::or(label, Some(x)))))
    })?;
    Ok(format!("**❓ {}**\n{options}", b.s("question")))
}

fn blocked(b: Fields<'_>, cx: &Context<'_>) -> Out {
    let approval = cx.approval.filter(|a| !a.is_empty()).map(|a| format!(" _({a})_")).unwrap_or_default();
    let items = lines(list(b.get("items")), |_, i| {
        let x = Fields::item(Some(i))?;
        Ok(format!("- {}{}{}", x.s("tool"), x.opt("detail", ": `", "`"), x.opt("why", " — ", "")))
    })?;
    Ok(format!("**🔒 Blocked by permissions**{approval}\n{items}"))
}

fn actions(b: Fields<'_>) -> Out {
    let head = if b.has("title") { format!("**{}**\n", b.s("title")) } else { "**Actions**\n".to_owned() };
    let items = lines(list(b.get("items")), |_, a| {
        if let Value::String(s) = a {
            return Ok(format!("- {s}"));
        }
        let x = Fields::item(Some(a))?;
        let what = if x.has("command") { format!(" — `$ {}`", x.s("command")) } else { x.opt("reply", " — _", "_") };
        Ok(format!("- **{}**{what}{}", js::str_of(js::or(x.get("label"), x.get("command"))), x.opt("detail", " (", ")")))
    })?;
    Ok(format!("{head}{items}"))
}
