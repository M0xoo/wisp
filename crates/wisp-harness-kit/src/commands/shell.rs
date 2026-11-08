//! Just enough shell to describe a command line: heredoc bodies dropped, the line split into pipelines,
//! stages and words, and each stage stripped down to the command that does the work.

use crate::js::is_space;

/// A command line: pipelines (split by `&& || ; &` and newlines), each a list of stages, each a list of words.
pub(super) type Pipeline = Vec<Vec<String>>;

/// A stage with its redirects read off: `out` is the file `>`/`>>` writes, `input` the file `<` reads.
#[derive(Debug, Default)]
pub(super) struct Stage {
    pub argv: Vec<String>,
    pub out: Option<String>,
    pub input: Option<String>,
}

#[derive(Default)]
struct Tokens {
    out: Vec<Pipeline>,
    pipe: Pipeline,
    words: Vec<String>,
    /// The word being read; None between words, so an empty quoted word ('') still counts as one.
    word: Option<String>,
}

impl Tokens {
    fn push(&mut self, s: &str) {
        self.word.get_or_insert_with(String::new).push_str(s);
    }
    fn end_word(&mut self) {
        if let Some(w) = self.word.take() {
            self.words.push(w);
        }
    }
    fn end_stage(&mut self) {
        self.end_word();
        if !self.words.is_empty() {
            self.pipe.push(std::mem::take(&mut self.words));
        }
    }
    fn end_pipe(&mut self) {
        self.end_stage();
        if !self.pipe.is_empty() {
            self.out.push(std::mem::take(&mut self.pipe));
        }
    }
}

fn text(s: &[char], from: usize, to: usize) -> String {
    s[from.min(s.len())..to.min(s.len())].iter().collect()
}

fn index_of(s: &[char], c: char, from: usize) -> Option<usize> {
    s.get(from..)?
        .iter()
        .position(|&x| x == c)
        .map(|j| j + from)
}

/// Split into pipelines → stages → words (v1 `segments`). Quotes are honoured; `$(…)` and `` `…` `` stay
/// inside the word they appear in. Indexing is by character: every character v1 compared is ASCII or a
/// space, so that agrees with its UTF-16 units.
pub(super) fn segments(line: &str) -> Vec<Pipeline> {
    let s: Vec<char> = line.chars().collect();
    let mut t = Tokens::default();
    let at = |j: usize| s.get(j).copied();
    let mut i = 0;
    while i < s.len() {
        let c = s[i];
        let next = at(i + 1);
        if let Some((add, end)) = quoted(&s, i) {
            if let Some(add) = add {
                t.push(&add);
            }
            i = end;
        } else if c == '|' && next != Some('|') {
            t.end_stage();
        } else if (c == '&' && next == Some('&')) || (c == '|' && next == Some('|')) {
            t.end_pipe();
            i += 1;
        } else if c == ';'
            || c == '\n'
            || (c == '&' && next != Some('>') && (i == 0 || s[i - 1] != '>'))
        {
            t.end_pipe();
        } else if c == '&' && next == Some('>') {
            t.end_word();
            let append = at(i + 2) == Some('>');
            t.words.push(if append { "&>>" } else { "&>" }.to_owned());
            i += if append { 2 } else { 1 };
        } else if c == '>' || c == '<' {
            i = redirect(&mut t, &s, i);
        } else if is_space(c) {
            t.end_word();
        } else if matches!(c, '(' | ')' | '{' | '}') && t.word.is_none() {
            t.end_word(); // subshells and groups: describe what's inside
        } else {
            t.word.get_or_insert_with(String::new).push(c);
        }
        i += 1;
    }
    t.end_pipe();
    t.out
}

/// Quotes, escapes, `$(…)` and `` `…` `` at `i`: the text they add to the current word (None: nothing,
/// not even an empty word) and the index of their last character. None when `i` starts none of them.
fn quoted(s: &[char], i: usize) -> Option<(Option<String>, usize)> {
    match s[i] {
        '\'' => {
            let end = index_of(s, '\'', i + 1).unwrap_or(s.len());
            Some((Some(text(s, i + 1, end)), end))
        }
        '"' => {
            let mut j = i + 1;
            let mut buf = String::new();
            while j < s.len() && s[j] != '"' {
                if s[j] == '\\' && j + 1 < s.len() {
                    j += 1;
                }
                buf.push(s[j]);
                j += 1;
            }
            Some((Some(buf), j))
        }
        // A line continuation joins, it adds nothing.
        '\\' if i + 1 < s.len() => Some(((s[i + 1] != '\n').then(|| s[i + 1].to_string()), i + 1)),
        '$' if s.get(i + 1) == Some(&'(') => {
            let mut depth = 0usize;
            let mut j = i + 1;
            while j < s.len() {
                if s[j] == '(' {
                    depth += 1;
                } else if s[j] == ')' {
                    depth = depth.saturating_sub(1);
                    if depth == 0 {
                        break;
                    }
                }
                j += 1;
            }
            Some((Some(text(s, i, j + 1)), j))
        }
        '`' => {
            let end = index_of(s, '`', i + 1).unwrap_or(s.len());
            Some((Some(text(s, i, end + 1)), end))
        }
        _ => None,
    }
}

/// Redirects become their own word (`>`, `>>`, `<`, `2>&1` …) so stages can read targets. Returns the
/// index of the operator's last character.
fn redirect(t: &mut Tokens, s: &[char], mut i: usize) -> usize {
    t.end_word();
    let mut op = String::new();
    // `2>`: a lone digit word right before the operator is its file descriptor.
    let fd = t
        .words
        .last()
        .is_some_and(|w| w.len() == 1 && w.as_bytes()[0].is_ascii_digit());
    if fd && (i == 0 || !is_space(s[i - 1])) {
        op = t.words.pop().unwrap_or_default();
    }
    op.push(s[i]);
    while matches!(s.get(i + 1), Some('>' | '&' | '<')) {
        i += 1;
        op.push(s[i]);
    }
    if op.ends_with('&') && s.get(i + 1).is_some_and(char::is_ascii_digit) {
        i += 1;
        op.push(s[i]);
    }
    t.words.push(op);
    i
}

fn digits_then(w: &str) -> &str {
    w.trim_start_matches(|c: char| c.is_ascii_digit())
}

/// `/^\d*[<>]+&?\d*$/` or a heredoc operator: a redirect with nothing to read off.
fn bare_redirect(w: &str) -> bool {
    let r = digits_then(w);
    let ops = r.trim_start_matches(['<', '>']);
    let tail = ops.strip_prefix('&').unwrap_or(ops);
    (ops.len() < r.len() && tail.bytes().all(|b| b.is_ascii_digit())) || w.starts_with("<<")
}

const WRAPPERS: &[&str] = &[
    "sudo",
    "time",
    "nohup",
    "command",
    "exec",
    "nice",
    "caffeinate",
    "stdbuf",
    "unbuffer",
];
const CONTROL: &[&str] = &["then", "else", "elif", "do", "done", "fi", "esac", "!"];

/// `/^[A-Za-z_]\w*=/`
fn assignment(w: &str) -> bool {
    let b = w.as_bytes();
    let Some((&first, rest)) = b.split_first() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return false;
    }
    let name = rest
        .iter()
        .take_while(|c| c.is_ascii_alphanumeric() || **c == b'_')
        .count();
    rest.get(name) == Some(&b'=')
}

/// Peel off redirects, env assignments and wrappers (v1 `parseStage`). `out` ignores /dev/null and fd
/// duplications.
pub(super) fn parse_stage(words: &[String]) -> Stage {
    let mut st = Stage::default();
    let mut i = 0;
    while i < words.len() {
        let w = words[i].as_str();
        let r = digits_then(w);
        if matches!(r, ">" | ">>" | "&>" | "&>>") {
            i += 1;
            if let Some(target) = words.get(i).filter(|t| !t.is_empty() && *t != "/dev/null") {
                st.out = Some(target.clone());
            }
        } else if r == "<" {
            i += 1;
            st.input = words.get(i).cloned();
        } else if bare_redirect(w) {
            if w == "<<" || w == "<<-" {
                i += 1; // heredoc delimiter
            }
        } else {
            st.argv.push(w.to_owned());
        }
        i += 1;
    }
    peel(&mut st.argv);
    st
}

fn drop_flags(argv: &mut Vec<String>, pairs: impl Fn(&str) -> bool) {
    let mut n = 0;
    while let Some(w) = argv.get(n).filter(|w| w.starts_with('-')) {
        n += if pairs(w) { 2 } else { 1 };
    }
    argv.drain(..n.min(argv.len()));
}

/// `/^-[IdLnPsE]$/`: xargs options that take the next word.
fn xargs_pair(w: &str) -> bool {
    matches!(
        w.as_bytes(),
        [b'-', b'I' | b'd' | b'L' | b'n' | b'P' | b's' | b'E']
    )
}

/// Drop what runs the command rather than being it: `FOO=1 sudo -E timeout 60 xargs -n 1 cmd` → `cmd`.
fn peel(argv: &mut Vec<String>) {
    while let Some(w) = argv.first() {
        let w = w.as_str();
        if assignment(w) || CONTROL.contains(&w) {
            argv.remove(0);
        } else if w == "env" {
            let n = 1 + argv[1..]
                .iter()
                .take_while(|a| a.starts_with('-') || assignment(a))
                .count();
            argv.drain(..n);
        } else if WRAPPERS.contains(&w) {
            argv.remove(0);
            drop_flags(argv, |_| false);
        } else if w == "timeout" || w == "gtimeout" {
            argv.remove(0);
            drop_flags(argv, |_| false);
            if !argv.is_empty() {
                argv.remove(0); // the duration
            }
        } else if w == "xargs" {
            argv.remove(0);
            drop_flags(argv, xargs_pair);
        } else {
            break;
        }
    }
}

/// Drop heredoc bodies so their lines aren't read as commands: `cat <<EOF > f\n…\nEOF` → `cat <<EOF > f`.
/// v1's regex (`/(<<-?\s*(['"]?)([\w-]+)\2)([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g`) needs
/// backreferences, so it is walked by hand in `heredoc.rs`, trying what the regex would, in its order.
pub(super) fn strip_heredocs(s: &str) -> std::borrow::Cow<'_, str> {
    super::heredoc::strip(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<Vec<Vec<String>>> {
        segments(s)
    }

    #[test]
    fn splits_pipes_and_redirects() {
        assert_eq!(
            words("a 'b c' | d 2>&1 && e>f"),
            vec![
                vec![
                    vec!["a".to_owned(), "b c".to_owned()],
                    vec!["d".to_owned(), "2>&1".to_owned()]
                ],
                vec![vec!["e".to_owned(), ">".to_owned(), "f".to_owned()]],
            ]
        );
        assert_eq!(
            words("x ''"),
            vec![vec![vec!["x".to_owned(), String::new()]]]
        );
    }

    #[test]
    fn peels_wrappers() {
        let w: Vec<String> = "FOO=1 sudo -E timeout 60 xargs -n 1 cmd > out 2> /dev/null"
            .split(' ')
            .map(str::to_owned)
            .collect();
        let st = parse_stage(&w);
        assert_eq!(st.argv, ["cmd"]);
        assert_eq!(st.out.as_deref(), Some("out"));
    }

    #[test]
    fn redirect_shapes() {
        assert!(bare_redirect("2>&1"));
        assert!(bare_redirect("<<EOF"));
        assert!(!bare_redirect("2"));
        assert!(!bare_redirect("&"));
        assert!(assignment("A_1=x"));
        assert!(!assignment("1A=x"));
    }
}
