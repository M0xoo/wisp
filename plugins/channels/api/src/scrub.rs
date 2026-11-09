//! What may leave: secrets out, mentions defused, names you didn't type hidden, no image or tag that
//! renders. Every outbound message of every transport goes through these.
use crate::{Action, AskView, ChannelCtx, Msg};

use crate::secrets;

const ZWSP: char = '\u{200b}';

/// At most `n` characters, the last one an ellipsis when it was cut.
pub fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_owned();
    }
    let mut out: String = s.chars().take(n.saturating_sub(1)).collect();
    out.push('…');
    out
}

/// Whitespace runs as one space, trimmed.
pub fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scrubbed {
    pub text: String,
    pub hits: usize,
}

fn note_of(hits: usize) -> String {
    let what = if hits == 1 { "a secret".to_owned() } else { format!("{hits} secrets") };
    format!("(wisp took {what} out of this message: open the task in wisp to see it.)")
}

/// Secrets out of what's about to leave. A private key is cut to its end, not just its first line.
/// When there were any, the text says so (`note` false for a title or a label).
pub fn scrub_out(text: &str, note: bool) -> Scrubbed {
    if !secrets::any(text) {
        return Scrubbed { text: text.to_owned(), hits: 0 };
    }
    let keys = cut_keys(text);
    let (out, hits) = secrets::redact(&keys);
    let text = if note { format!("{out}\n\n{}", note_of(hits)) } else { out };
    Scrubbed { text, hits }
}

/// `-----BEGIN … PRIVATE KEY-----` through its END line (or the end of the text) → the bare BEGIN line.
fn cut_keys(text: &str) -> String {
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut last) = (0, 0);
    while i < b.len() {
        let Some(head_end) = secrets::key_marker(b, i, b"-----BEGIN ") else {
            i += 1;
            continue;
        };
        let end = (head_end..b.len()).find_map(|j| secrets::key_marker(b, j, b"-----END ")).unwrap_or(b.len());
        out.push_str(&text[last..i]);
        out.push_str("-----BEGIN PRIVATE KEY-----");
        last = end;
        i = end.max(i + 1);
    }
    out.push_str(&text[last..]);
    out
}

/// The scrub note back off the end of a text, so a channel that has to shorten it can keep it.
/// → (body, note); the note is "" when there is none.
pub fn split_note(text: &str) -> (&str, &str) {
    const OPEN: &str = "\n\n(wisp took ";
    const CLOSE: &str = " out of this message: open the task in wisp to see it.)";
    let Some(at) = text.rfind(OPEN) else { return (text, "") };
    let Some(what) = text[at + OPEN.len()..].strip_suffix(CLOSE) else { return (text, "") };
    let counted = what.strip_suffix(" secrets").is_some_and(|n| !n.is_empty() && n.bytes().all(|c| c.is_ascii_digit()));
    if what == "a secret" || counted { (&text[..at], &text[at + 2..]) } else { (text, "") }
}

/// So a report can't ping anyone: `@name`, `@everyone`, `@here`, and Slack's `<!channel>` and `<@U1>`.
/// A zero-width space keeps them readable and stops them working. An email address stays.
pub fn defuse(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 8);
    for (i, &c) in chars.iter().enumerate() {
        out.push(c);
        let next = chars.get(i + 1).copied();
        if c == '@' {
            let prev_ok = i == 0 || !(chars[i - 1].is_ascii_alphanumeric() || matches!(chars[i - 1], '_' | '@' | '.' | '+' | '-'));
            if prev_ok && next.is_some_and(|n| n.is_alphanumeric() || n == '_') {
                out.push(ZWSP);
            }
        } else if c == '<' && next.is_some_and(|n| matches!(n, '!' | '@' | '#')) {
            out.push(ZWSP);
        }
    }
    out
}

/// A renderer fetches an image as soon as it shows it, so an agent could carry data out in its URL.
/// `![…]` becomes a plain link and no tag is a tag.
pub fn no_media(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + 8);
    for (i, &c) in chars.iter().enumerate() {
        out.push(c);
        let next = chars.get(i + 1).copied();
        let breaks = match c {
            '!' => next == Some('['),
            '<' => next.is_some_and(|n| n.is_ascii_alphabetic() || matches!(n, '/' | '!' | '?')),
            _ => false,
        };
        if breaks {
            out.push(ZWSP);
        }
    }
    out
}

fn name_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-'
}

fn eq_ci(a: char, b: char) -> bool {
    a == b || a.to_lowercase().eq(b.to_lowercase())
}

/// Every whole, case-insensitive occurrence of `name` → `…`.
fn replace_name(text: &[char], name: &[char]) -> Vec<char> {
    let mut out = Vec::with_capacity(text.len());
    let mut i = 0;
    while i < text.len() {
        let fits = !name.is_empty()
            && i + name.len() <= text.len()
            && text[i..i + name.len()].iter().zip(name).all(|(a, b)| eq_ci(*a, *b))
            && (i == 0 || !name_char(text[i - 1]))
            && text.get(i + name.len()).is_none_or(|c| !name_char(*c));
        if fits {
            out.push('…');
            i += name.len();
        } else {
            out.push(text[i]);
            i += 1;
        }
    }
    out
}

/// Where others can read: no name of yours that you didn't write there yourself (a project, a folder,
/// a machine, a crew member). `typed`: what this message said, and anything already known there.
pub fn hide_names(text: &str, ctx: &ChannelCtx, typed: &str) -> String {
    let said = typed.to_lowercase();
    let mut names: Vec<&str> = ctx
        .projects
        .iter()
        .flat_map(|p| [p.name.as_str(), p.path.as_str()])
        .chain(ctx.machines.iter().map(|m| m.name.as_str()))
        .chain(ctx.crew.iter().flat_map(|m| [Some(m.name.as_str()), m.cwd.as_deref()].into_iter().flatten()))
        .filter(|n| !n.is_empty() && !said.contains(&n.to_lowercase()))
        .collect();
    names.sort_by_key(|n| std::cmp::Reverse(n.chars().count()));
    let mut out: Vec<char> = text.chars().collect();
    for n in names {
        let name: Vec<char> = n.chars().collect();
        out = replace_name(&out, &name);
    }
    tidy_hidden(&out.into_iter().collect::<String>())
}

/// ` · …` and ` · on …` go; a line that began `▶ … · ` keeps its arrow.
fn tidy_hidden(s: &str) -> String {
    let s = s.replace(" · on …", "").replace(" · …", "");
    s.split('\n').map(|l| l.strip_prefix("▶ … · ").map_or_else(|| l.to_owned(), |r| format!("▶ {r}"))).collect::<Vec<_>>().join("\n")
}

const WAITING: &str = "Waiting for your OK in wisp";
const WAITING_MAX: usize = 300;

/// What an ask wants, as its card in wisp names it. The whole command is checked: the summary is
/// clipped, and half a secret no longer reads as one, so one in there shows the command redacted.
fn asked_for(ask: &AskView) -> String {
    let clean = |t: Option<&str>| scrub_out(t.unwrap_or_default(), false);
    let Some(p) = &ask.permission else { return one_line(&clean(ask.question.as_deref()).text) };
    let detail = clean(p.detail.as_deref());
    if detail.hits > 0 {
        return one_line(&detail.text);
    }
    let action = one_line(&clean(p.action.as_deref()).text);
    let more = one_line(p.detail.as_deref().unwrap_or_default());
    let head: String = more.chars().take(40).collect();
    if !more.is_empty() && !action.contains(&head) { format!("{action}: {more}") } else { action }
}

/// The line for a task stalled on an ask this channel can't answer. `bare`: where others can read,
/// the fixed words with nothing of the ask.
pub fn waiting_line(ask: &AskView, bare: bool) -> String {
    let what = if bare { String::new() } else { truncate(&asked_for(ask), WAITING_MAX) };
    if what.is_empty() { format!("{WAITING}.") } else { format!("{WAITING}: {what}") }
}

/// A message made safe to leave: title, text and labels scrubbed (the note on the text only) and,
/// for a channel layer, defused.
pub fn safe_msg(msg: &Msg, layer: bool) -> Msg {
    let clean = |t: &str, note: bool| {
        let s = scrub_out(t, note).text;
        if layer { defuse(&s) } else { s }
    };
    Msg {
        title: clean(&msg.title, false),
        text: clean(&msg.text, true),
        actions: msg.actions.iter().map(|a| Action { label: clean(&a.label, false), ..a.clone() }).collect(),
    }
}
