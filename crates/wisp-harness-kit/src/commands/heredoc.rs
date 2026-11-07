//! Heredoc bodies, dropped. v1 did it with one regex that needs backreferences, which the `regex` crate
//! has not got:
//!
//! `s.replace(/(<<-?\s*(['"]?)([\w-]+)\2)([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1$4')`
//!
//! so this walks the same pattern by hand, trying its choices in the order a backtracking engine would:
//! the `-` taken before not, the delimiter longest first, the body shortest first.

use std::borrow::Cow;

use crate::js::is_space;

/// JavaScript's `[\w-]`.
fn word_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}

/// `s` with every heredoc body removed (the `<<EOF …` header line stays).
pub(super) fn strip(s: &str) -> Cow<'_, str> {
    if !s.contains("<<") {
        return Cow::Borrowed(s);
    }
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut last = 0;
    let mut p = 0;
    let mut changed = false;
    while p + 1 < c.len() {
        if c[p] == '<' && c[p + 1] == '<' {
            if let Some((header_end, end)) = match_at(&c, p) {
                out.extend(&c[last..header_end]);
                last = end;
                p = end;
                changed = true;
                continue;
            }
        }
        p += 1;
    }
    if !changed {
        return Cow::Borrowed(s);
    }
    out.extend(&c[last..]);
    Cow::Owned(out)
}

/// A match starting at `p` (which holds `<<`): the end of the kept header (`$1$4`, up to the line's
/// newline) and the end of the whole match (after the closing delimiter line).
fn match_at(c: &[char], p: usize) -> Option<(usize, usize)> {
    let q = p + 2;
    let dashes: &[usize] = if c.get(q) == Some(&'-') { &[1, 0] } else { &[0] };
    for &dash in dashes {
        let mut r = q + dash;
        while c.get(r).is_some_and(|&x| is_space(x)) {
            r += 1;
        }
        // `(['"]?)`: with a quote there, leaving it out would start the delimiter on it, which fails.
        let quote = c.get(r).copied().filter(|&x| x == '\'' || x == '"');
        let start = r + usize::from(quote.is_some());
        let max = c[start.min(c.len())..].iter().take_while(|&&x| word_char(x)).count();
        if max == 0 {
            continue;
        }
        // With a quote the delimiter must run up to it; without, a shorter one may still close.
        let lens: Vec<usize> = match quote {
            Some(qc) if c.get(start + max) == Some(&qc) => vec![max],
            Some(_) => continue,
            None => (1..=max).rev().collect(),
        };
        for len in lens {
            let after = start + len + usize::from(quote.is_some());
            let Some(nl) = c[after..].iter().position(|&x| x == '\n').map(|i| i + after) else {
                return None; // no newline after the header: nothing else can match here either
            };
            if let Some(end) = closing(c, nl, &c[start..start + len]) {
                return Some((nl, end));
            }
        }
    }
    None
}

/// `\n[\s\S]*?\n[ \t]*WORD[ \t]*(?=\n|$)` after the header's newline at `nl`: the end of the shortest
/// body's closing line.
fn closing(c: &[char], nl: usize, word: &[char]) -> Option<usize> {
    let mut k = nl + 1;
    while k < c.len() {
        if c[k] == '\n' {
            let mut m = k + 1;
            while matches!(c.get(m), Some(' ' | '\t')) {
                m += 1;
            }
            if c.get(m..m + word.len()) == Some(word) {
                m += word.len();
                while matches!(c.get(m), Some(' ' | '\t')) {
                    m += 1;
                }
                if m == c.len() || c[m] == '\n' {
                    return Some(m);
                }
            }
        }
        k += 1;
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drops_bodies() {
        assert_eq!(strip("cat <<'EOF' > f\nhello\nrm -rf /\nEOF\nls"), "cat <<'EOF' > f\nls");
        assert_eq!(strip("x <<-END\n\tbody\n\tEND"), "x <<-END");
        assert_eq!(strip("x <<EOF\nEOF"), "x <<EOF\nEOF"); // the body needs a line of its own
        assert_eq!(strip("x <<EOF\n\nEOF"), "x <<EOF");
        assert_eq!(strip("x <<EOFX\nhi\nEOF"), "x <<EOF"); // a shorter delimiter closes
        assert_eq!(strip("x <<-E\nhi\n-E"), "x <<-E\nhi\n-E"); // `-E` is not `E`, but `-` dropped…
        assert_eq!(strip("plain"), "plain");
    }
}
