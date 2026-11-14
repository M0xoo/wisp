//! @names in a text (v1 channels/mentions.js): the page's `@[Ada](crew:<id>)` or a plain `@Ada` / `@ada`.
//! Pure; the grammar reads them, and so does wisp Grid's router.

use wisp_channels_api::MemberView;

/// v1 `handleOf`: `Ada Lovelace` → `ada-lovelace` (24 characters at most).
pub fn handle_of(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.to_lowercase().chars() {
        if c.is_alphanumeric() {
            if dash && !out.is_empty() {
                out.push('-');
            }
            dash = false;
            out.push(c);
        } else {
            dash = true;
        }
    }
    out.chars().take(24).collect::<String>().trim_end_matches('-').to_owned()
}

/// The members a text names. `lead`: those it starts with (it's addressed to them), in order; `rest`: the text
/// without them.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Mentions {
    pub all: Vec<MemberView>,
    pub lead: Vec<MemberView>,
    pub rest: String,
}

struct Hit {
    member: MemberView,
    at: usize,
    len: usize,
}

/// `@[name](crew:id)` at char `i`: (id, length in chars).
fn page_form(c: &[char], i: usize) -> Option<(String, usize)> {
    if c.get(i) != Some(&'@') || c.get(i + 1) != Some(&'[') {
        return None;
    }
    let close = (i + 2..c.len().min(i + 203)).find(|&j| c[j] == ']' || c[j] == '\n')?;
    if c[close] != ']' || close == i + 2 {
        return None;
    }
    let tag: String = c.get(close + 1..close + 7)?.iter().collect();
    if tag != "(crew:" {
        return None;
    }
    let start = close + 7;
    let end = (start..c.len()).find(|&j| !(c[j].is_ascii_lowercase() || c[j].is_ascii_digit()))?;
    if c[end] != ')' || !(6..=40).contains(&(end - start)) {
        return None;
    }
    Some((c[start..end].iter().collect(), end + 1 - i))
}

fn starts_with_ci(c: &[char], i: usize, needle: &[char]) -> bool {
    needle.len() <= c.len().saturating_sub(i)
        && c[i..i + needle.len()].iter().zip(needle).all(|(a, b)| a.to_lowercase().eq(b.to_lowercase()))
}

/// A plain `@name` (or its handle) in `c`, not inside a word on either side, nor inside a longer name already
/// found (`taken`): (at, len) in chars. v1 let `@Ada` match inside `@Ada Lovelace`, at the same place, which
/// ended the leading mentions there (docs/v1-bugs-fixed.md).
fn plain(c: &[char], names: &[Vec<char>], taken: &[(usize, usize)]) -> Option<(usize, usize)> {
    for i in 0..c.len() {
        if taken.iter().any(|&(at, len)| (at..at + len).contains(&i)) {
            continue;
        }
        if c[i] != '@' || i > 0 && (c[i - 1].is_alphanumeric() || matches!(c[i - 1], '_' | '@' | ']')) {
            continue;
        }
        for n in names.iter().filter(|n| !n.is_empty()) {
            let end = i + 1 + n.len();
            if starts_with_ci(c, i + 1, n) && c.get(end).is_none_or(|x| !(x.is_alphanumeric() || matches!(x, '_' | '-'))) {
                return Some((i, 1 + n.len()));
            }
        }
    }
    None
}

/// v1 `crewMentions`.
pub fn crew_mentions(text: &str, members: &[MemberView]) -> Mentions {
    let src: Vec<char> = text.chars().collect();
    let mut hits: Vec<Hit> = Vec::new();
    let mut masked = src.clone();
    let mut i = 0;
    while i < src.len() {
        if let Some((id, len)) = page_form(&src, i) {
            if let Some(m) = members.iter().find(|m| m.id == id)
                && !hits.iter().any(|h| h.member.id == m.id)
            {
                hits.push(Hit { member: m.clone(), at: i, len });
            }
            masked[i..i + len].iter_mut().for_each(|x| *x = ' ');
            i += len;
        } else {
            i += 1;
        }
    }
    let mut by_len: Vec<&MemberView> = members.iter().collect();
    by_len.sort_by_key(|m| std::cmp::Reverse(m.name.chars().count()));
    for m in by_len {
        if hits.iter().any(|h| h.member.id == m.id) {
            continue;
        }
        let names = [m.name.chars().collect::<Vec<_>>(), handle_of(&m.name).chars().collect()];
        let taken: Vec<(usize, usize)> = hits.iter().map(|h| (h.at, h.len)).collect();
        if let Some((at, len)) = plain(&masked, &names, &taken) {
            hits.push(Hit { member: m.clone(), at, len });
        }
    }
    hits.sort_by_key(|h| h.at);
    let mut at = src.iter().take_while(|c| c.is_whitespace()).count();
    let mut lead = Vec::new();
    for h in &hits {
        if h.at != at {
            break;
        }
        lead.push(h.member.clone());
        at = h.at + h.len;
        at += src[at..].iter().take_while(|c| c.is_whitespace() || matches!(c, ',' | ':')).count();
    }
    let rest = if lead.is_empty() { text.to_owned() } else { src[at..].iter().collect::<String>().trim().to_owned() };
    Mentions { all: hits.into_iter().map(|h| h.member).collect(), lead, rest }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(id: &str, name: &str) -> MemberView {
        MemberView { id: id.into(), name: name.into(), ..MemberView::default() }
    }

    #[test]
    fn a_leading_mention_addresses_the_member_and_the_rest_is_the_task() {
        let crew = [m("ada001", "Ada Lovelace"), m("ada002", "Ada"), m("bob001", "Bob")];
        let x = crew_mentions("@Ada Lovelace, @bob: look at the build with @ada", &crew);
        assert_eq!(x.lead.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["ada001", "bob001"], "the longest name first");
        assert_eq!(x.rest, "look at the build with @ada");
        assert_eq!(x.all.len(), 3);
        let page = crew_mentions("@[Bob](crew:bob001) fix it", &crew);
        assert_eq!((page.lead[0].id.as_str(), page.rest.as_str()), ("bob001", "fix it"));
        assert!(crew_mentions("mail bob@bob.com", &crew).all.is_empty(), "inside a word isn't a mention");
        assert_eq!(crew_mentions("@ada-lovelace go", &crew).lead[0].id, "ada001", "the handle works too");
        assert_eq!(handle_of("  Ada Lovelace!! "), "ada-lovelace");
    }
}
