//! @Name mentions of crew members in a text (v1 server/channels/mentions.js `CREW_MENTION`, `handleOf`,
//! `crewMentions`; crew.js `plainCrew`). Stored `@[Ada](crew:<id>)` tokens are matched first, then plain
//! names, longest first, never inside a word or an email. A mention is leading (the text is for that
//! member) only when nothing but spaces, commas or colons come before it.

use wisp_crew_api::Member;

use crate::text::{clip, is_word};

/// Something with an id and a name: a member, or a test's stand-in.
pub trait Named {
    fn id(&self) -> &str;
    fn name(&self) -> &str;
}

impl Named for Member {
    fn id(&self) -> &str {
        &self.id
    }
    fn name(&self) -> &str {
        &self.name
    }
}

/// A member's @handle: "Bo Lee" → "bo-lee" (letters and digits of any script, at most 24).
pub fn handle_of(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.chars().flat_map(char::to_lowercase) {
        if is_word(c) {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    clip(&out, 24)
}

/// A stored mention token at `start..end` (byte offsets).
struct Token<'a> {
    start: usize,
    end: usize,
    name: &'a str,
    id: &'a str,
}

/// Every `@[name](crew:id)` in `src`, in order.
fn tokens(src: &str) -> Vec<Token<'_>> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = src[from..].find("@[").map(|i| i + from) {
        from = i + 2;
        let rest = &src[i + 2..];
        let Some(close) = rest.find(']') else { continue };
        let name = &rest[..close];
        let n = name.chars().count();
        if n == 0 || n > 200 || name.contains('\n') {
            continue;
        }
        let Some(after) = rest[close..].strip_prefix("](crew:") else { continue };
        let id_len = after.bytes().take_while(|b| b.is_ascii_lowercase() || b.is_ascii_digit()).count();
        if !(6..=40).contains(&id_len) || after.as_bytes().get(id_len) != Some(&b')') {
            continue;
        }
        let end = i + 2 + close + "](crew:".len() + id_len + 1;
        out.push(Token { start: i, end, name, id: &after[..id_len] });
        from = end;
    }
    out
}

/// Bytes of `text` that equal `pat` ignoring case, from its start; `None` when it doesn't.
fn prefix_ci(text: &str, pat: &str) -> Option<usize> {
    let mut t = text.char_indices();
    for p in pat.chars() {
        let (_, c) = t.next()?;
        if !c.to_lowercase().eq(p.to_lowercase()) {
            return None;
        }
    }
    Some(t.next().map_or(text.len(), |(i, _)| i))
}

/// Where a plain `@name` (or `@handle`) first stands on its own in `src`: `(at, len)` from the `@`.
fn plain_hit(src: &str, name: &str, handle: &str) -> Option<(usize, usize)> {
    let mut from = 0;
    while let Some(at) = src[from..].find('@').map(|i| i + from) {
        from = at + 1;
        // Not inside a word or an email, and not right after another mention token.
        let before = src[..at].chars().next_back();
        if before.is_some_and(|c| is_word(c) || c == '_' || c == '@' || c == ']') {
            continue;
        }
        for cand in [name, handle] {
            if cand.is_empty() {
                continue;
            }
            let Some(n) = prefix_ci(&src[at + 1..], cand) else { continue };
            let next = src[at + 1 + n..].chars().next();
            if !next.is_some_and(|c| is_word(c) || c == '_' || c == '-') {
                return Some((at, 1 + n));
            }
        }
    }
    None
}

/// Who a text names.
#[derive(Debug)]
pub struct Mentions<'a, M> {
    /// every member named, in the order they appear
    pub all: Vec<&'a M>,
    /// the ones the text starts with: it is addressed to them
    pub lead: Vec<&'a M>,
    /// the text without the leading mentions (the whole text when there are none)
    pub rest: String,
}

/// The members a text names: stored tokens or a plain `@Ada` / `@ada`, leading or in passing.
pub fn crew_mentions<'a, M: Named>(src: &str, members: &'a [M]) -> Mentions<'a, M> {
    let mut hits: Vec<(usize, usize, &'a M)> = Vec::new();
    let toks = tokens(src);
    for t in &toks {
        if let Some(m) = members.iter().find(|m| m.id() == t.id)
            && !hits.iter().any(|h| h.2.id() == m.id())
        {
            hits.push((t.start, t.end - t.start, m));
        }
    }
    // Plain names are looked for with the tokens blanked out (same byte length, so offsets hold).
    let mut blanked = src.to_owned();
    for t in &toks {
        blanked.replace_range(t.start..t.end, &" ".repeat(t.end - t.start));
    }
    let mut by_len: Vec<&'a M> = members.iter().collect();
    by_len.sort_by_key(|m| std::cmp::Reverse(m.name().chars().count()));
    for m in by_len {
        if hits.iter().any(|h| h.2.id() == m.id()) {
            continue;
        }
        if let Some((at, len)) = plain_hit(&blanked, m.name(), &handle_of(m.name())) {
            hits.push((at, len, m));
        }
    }
    hits.sort_by_key(|h| h.0);
    let mut at = src.len() - src.trim_start().len();
    let mut lead = Vec::new();
    for &(start, len, m) in &hits {
        if start != at {
            break;
        }
        lead.push(m);
        at = start + len;
        at += src[at..].len() - src[at..].trim_start_matches(|c: char| c.is_whitespace() || c == ',' || c == ':').len();
    }
    let rest = if lead.is_empty() { src.to_owned() } else { src[at..].trim().to_owned() };
    Mentions { all: hits.iter().map(|h| h.2).collect(), lead, rest }
}

/// Stored mentions as an agent or a person reads them: `@Ada`.
pub fn plain_crew(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for t in tokens(text) {
        out.push_str(&text[last..t.start]);
        out.push('@');
        out.push_str(t.name);
        last = t.end;
    }
    out.push_str(&text[last..]);
    out
}

/// A mention as the page's @ picker writes it.
pub fn mention_of(m: &impl Named) -> String {
    let name: String = m.name().chars().filter(|c| *c != ']' && *c != '\n').collect();
    format!("@[{name}](crew:{})", m.id())
}

/// The members a message starts with (it's for them, not the task's agent), and the message without them.
pub fn addressed_to<'a, M: Named>(text: &str, members: &'a [M]) -> (Vec<&'a M>, String) {
    let t = crew_mentions(text.trim_start(), members);
    if t.lead.is_empty() { (t.lead, text.trim().to_owned()) } else { (t.lead, t.rest) }
}

/// New task with a member picked on the rail: what goes out is `@Ada …`. A typed @Other wins and a
/// slash command isn't a job: `None`, it goes as typed.
pub fn picked_prompt<M: Named>(text: &str, picked: Option<&M>, members: &[M]) -> Option<String> {
    let t = text.trim();
    let m = picked?;
    if t.starts_with('/') || !addressed_to(t, members).0.is_empty() {
        return None;
    }
    Some(format!("{} {t}", mention_of(m)))
}
