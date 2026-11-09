//! The composer: multi-line (grows to 10 lines), Enter sends, Alt-Enter / Shift-Enter / Ctrl-J a newline, ↑ in an
//! empty box walks history, a large paste collapses to `[pasted N lines]` (sent whole), a pasted image path becomes
//! an attachment, and `@` / `/` open their pickers. Drafts are kept per task.

use std::collections::BTreeMap;

/// A paste this long collapses.
pub const PASTE_LINES: usize = 10;
pub const MAX_ROWS: usize = 10;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Composer {
    pub lines: Vec<String>,
    /// (row, column in chars)
    pub cur: (usize, usize),
    /// collapsed pastes: the token in the text → what it stands for
    pub pastes: BTreeMap<String, String>,
    pub attachments: Vec<String>,
    history: Vec<String>,
    walk: Option<usize>,
    drafts: BTreeMap<String, Vec<String>>,
}

/// What a key did to the composer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edit {
    Typed,
    /// `@` just typed: the picker opens
    At,
    /// `/` typed in an empty box: the command menu opens
    Slash,
}

fn byte_at(s: &str, col: usize) -> usize {
    s.char_indices().nth(col).map_or(s.len(), |(i, _)| i)
}

impl Composer {
    pub fn text(&self) -> String {
        self.lines.join("\n")
    }

    pub fn is_empty(&self) -> bool {
        self.lines.iter().all(String::is_empty)
    }

    pub fn clear(&mut self) {
        self.lines = vec![String::new()];
        self.cur = (0, 0);
        self.pastes.clear();
        self.attachments.clear();
        self.walk = None;
    }

    fn ensure(&mut self) {
        if self.lines.is_empty() {
            self.lines.push(String::new());
        }
    }

    /// How many rows it takes on screen.
    pub fn rows(&self) -> usize {
        self.lines.len().clamp(1, MAX_ROWS)
    }

    pub fn insert(&mut self, s: &str) {
        self.ensure();
        for (i, part) in s.split('\n').enumerate() {
            if i > 0 {
                self.newline();
            }
            let (r, c) = self.cur;
            let at = byte_at(&self.lines[r], c);
            self.lines[r].insert_str(at, part);
            self.cur.1 += part.chars().count();
        }
    }

    pub fn newline(&mut self) {
        self.ensure();
        let (r, c) = self.cur;
        let at = byte_at(&self.lines[r], c);
        let rest = self.lines[r].split_off(at);
        self.lines.insert(r + 1, rest);
        self.cur = (r + 1, 0);
    }

    pub fn backspace(&mut self) {
        self.ensure();
        let (r, c) = self.cur;
        if c > 0 {
            let start = byte_at(&self.lines[r], c - 1);
            let end = byte_at(&self.lines[r], c);
            self.lines[r].replace_range(start..end, "");
            self.cur.1 -= 1;
        } else if r > 0 {
            let line = self.lines.remove(r);
            let prev = self.lines[r - 1].chars().count();
            self.lines[r - 1].push_str(&line);
            self.cur = (r - 1, prev);
        }
    }

    pub fn left(&mut self) {
        if self.cur.1 > 0 {
            self.cur.1 -= 1;
        } else if self.cur.0 > 0 {
            self.cur.0 -= 1;
            self.cur.1 = self.lines[self.cur.0].chars().count();
        }
    }

    pub fn right(&mut self) {
        self.ensure();
        let n = self.lines[self.cur.0].chars().count();
        if self.cur.1 < n {
            self.cur.1 += 1;
        } else if self.cur.0 + 1 < self.lines.len() {
            self.cur = (self.cur.0 + 1, 0);
        }
    }

    /// ↑: a line up, or (an empty box, or walking already) the history.
    pub fn up(&mut self) {
        if self.cur.0 > 0 && self.walk.is_none() {
            self.cur.0 -= 1;
            self.cur.1 = self.cur.1.min(self.lines[self.cur.0].chars().count());
            return;
        }
        if !(self.is_empty() || self.walk.is_some()) || self.history.is_empty() {
            return;
        }
        let i = self.walk.map_or(self.history.len() - 1, |i| i.saturating_sub(1));
        self.walk = Some(i);
        self.set(&self.history[i].clone());
    }

    pub fn down(&mut self) {
        if let Some(i) = self.walk {
            if i + 1 < self.history.len() {
                self.walk = Some(i + 1);
                self.set(&self.history[i + 1].clone());
            } else {
                self.walk = None;
                self.clear();
            }
        } else if self.cur.0 + 1 < self.lines.len() {
            self.cur.0 += 1;
            self.cur.1 = self.cur.1.min(self.lines[self.cur.0].chars().count());
        }
    }

    pub fn set(&mut self, text: &str) {
        let walk = self.walk;
        self.clear();
        self.walk = walk;
        self.insert(text);
    }

    /// A paste: long ones collapse; a path to an image becomes an attachment.
    pub fn paste(&mut self, text: &str) {
        let t = text.trim_end_matches('\n');
        let one = t.trim();
        let image = ["png", "jpg", "jpeg", "gif", "webp"].iter().any(|e| one.to_ascii_lowercase().ends_with(&format!(".{e}"))) && !one.contains('\n') && std::path::Path::new(one.trim_matches(['\'', '"'])).is_file();
        if image {
            self.attachments.push(one.trim_matches(['\'', '"']).to_owned());
            self.insert(&format!("[image {}]", self.attachments.len()));
            return;
        }
        let n = t.lines().count();
        if n > PASTE_LINES {
            let token = format!("[pasted {n} lines]");
            let token = if self.pastes.contains_key(&token) { format!("[pasted {n} lines #{}]", self.pastes.len() + 1) } else { token };
            self.pastes.insert(token.clone(), t.to_owned());
            self.insert(&token);
        } else {
            self.insert(t);
        }
    }

    /// What goes: the text with every collapsed paste put back.
    pub fn take(&mut self) -> String {
        let mut t = self.text();
        for (token, whole) in &self.pastes {
            t = t.replace(token, whole);
        }
        let t = t.trim().to_owned();
        if !t.is_empty() {
            self.history.push(self.text().trim().to_owned());
        }
        self.clear();
        t
    }

    /// A typed character.
    pub fn char(&mut self, ch: char) -> Edit {
        let empty = self.is_empty();
        let before = self.lines.get(self.cur.0).and_then(|l| l.chars().nth(self.cur.1.wrapping_sub(1)));
        self.insert(&ch.to_string());
        match ch {
            '/' if empty => Edit::Slash,
            '@' if before.is_none_or(char::is_whitespace) => Edit::At,
            _ => Edit::Typed,
        }
    }

    /// Takes off the `@…` or `/…` word being typed (a picker chose), and puts `with` instead.
    pub fn replace_word(&mut self, lead: char, with: &str) {
        self.ensure();
        let (r, c) = self.cur;
        let line: Vec<char> = self.lines[r].chars().collect();
        let start = (0..c).rev().find(|i| line[*i] == lead).unwrap_or(c);
        let s = byte_at(&self.lines[r], start);
        let e = byte_at(&self.lines[r], c);
        self.lines[r].replace_range(s..e, with);
        self.cur.1 = start + with.chars().count();
    }

    /// The word after the last `@` (or `/`) before the cursor: what the picker filters with.
    pub fn word(&self, lead: char) -> String {
        let Some(line) = self.lines.get(self.cur.0) else { return String::new() };
        let before: String = line.chars().take(self.cur.1).collect();
        before.rsplit_once(lead).map(|(_, w)| w.to_owned()).unwrap_or_default()
    }

    /// Switching tasks: this one's draft kept, that one's back.
    pub fn switch(&mut self, from: &str, to: &str) {
        let walk = self.walk;
        if self.is_empty() {
            self.drafts.remove(from);
        } else {
            self.drafts.insert(from.to_owned(), self.lines.clone());
        }
        self.clear();
        self.walk = walk;
        if let Some(d) = self.drafts.remove(to) {
            self.lines = d;
            let last = self.lines.len() - 1;
            self.cur = (last, self.lines[last].chars().count());
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn the_composer_edits_lines_and_sends_pastes_whole() {
        let mut c = Composer::default();
        for ch in "fix it".chars() {
            c.char(ch);
        }
        c.newline();
        c.insert("and test");
        assert_eq!((c.text().as_str(), c.rows()), ("fix it\nand test", 2));
        c.backspace();
        assert_eq!(c.text(), "fix it\nand tes");
        let big: String = (0..40).fold(String::new(), |acc, i| acc + &format!("line {i}\n"));
        c.paste(&big);
        assert!(c.text().ends_with("[pasted 40 lines]"), "{}", c.text());
        let sent = c.take();
        assert!(sent.contains("line 39") && !sent.contains("[pasted"), "the paste goes whole");
        assert!(c.is_empty());
        // history with ↑ in an empty box
        c.up();
        assert_eq!(c.text(), "fix it\nand tes[pasted 40 lines]");
        c.down();
        assert!(c.is_empty());
    }

    #[test]
    fn at_and_slash_open_their_pickers_and_a_choice_replaces_the_word() {
        let mut c = Composer::default();
        assert_eq!(c.char('/'), Edit::Slash, "/ in an empty box");
        c.clear();
        for ch in "ask ".chars() {
            c.char(ch);
        }
        assert_eq!(c.char('@'), Edit::At);
        c.char('a');
        c.char('d');
        assert_eq!(c.word('@'), "ad");
        c.replace_word('@', "@[Ada](crew:m1) ");
        assert_eq!(c.text(), "ask @[Ada](crew:m1) ");
        assert_eq!(Composer::default().char('x'), Edit::Typed);
        let mut e = Composer::default();
        e.insert("mail me@x.io");
        assert_eq!(e.char('@'), Edit::Typed, "an @ inside a word is just a letter");
    }

    #[test]
    fn drafts_stay_with_their_task() {
        let mut c = Composer::default();
        c.insert("half a thought");
        c.switch("t1", "t2");
        assert!(c.is_empty());
        c.insert("other");
        c.switch("t2", "t1");
        assert_eq!(c.text(), "half a thought");
        c.switch("t1", "t2");
        assert_eq!(c.text(), "other");
    }
}
