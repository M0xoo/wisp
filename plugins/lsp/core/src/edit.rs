//! A rename's `WorkspaceEdit`: which files it touches and the new text of each. Pure: the host reads and
//! writes the files.

use serde_json::Value;

/// A position as LSP counts it: 0-based line, UTF-16 code units into the line.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default)]
pub struct Pos {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextEdit {
    pub start: Pos,
    pub end: Pos,
    pub new_text: String,
}

fn pos(v: &Value) -> Pos {
    let n = |k: &str| v.get(k).and_then(Value::as_u64).and_then(|n| u32::try_from(n).ok()).unwrap_or(0);
    Pos { line: n("line"), character: n("character") }
}

fn text_edit(v: &Value) -> Option<TextEdit> {
    let range = v.get("range")?;
    let new_text = v.get("newText").and_then(Value::as_str).unwrap_or("").to_owned();
    Some(TextEdit { start: pos(range.get("start")?), end: pos(range.get("end")?), new_text })
}

/// Each file's edits, by URL, in the order the server listed them: `changes` first, then
/// `documentChanges` (text edits only; creates, renames and deletes of files are not applied).
pub fn workspace_edits(edit: &Value) -> Vec<(String, Vec<TextEdit>)> {
    let mut out: Vec<(String, Vec<TextEdit>)> = Vec::new();
    let mut add = |uri: &str, edits: &[Value]| {
        let edits = edits.iter().filter_map(text_edit);
        match out.iter_mut().find(|(u, _)| u == uri) {
            Some((_, list)) => list.extend(edits),
            None => out.push((uri.to_owned(), edits.collect())),
        }
    };
    if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
        for (uri, edits) in changes {
            add(uri, edits.as_array().map_or(&[], Vec::as_slice));
        }
    }
    for dc in edit.get("documentChanges").and_then(Value::as_array).map_or(&[][..], Vec::as_slice) {
        if let (Some(uri), Some(edits)) = (dc.pointer("/textDocument/uri").and_then(Value::as_str), dc.get("edits").and_then(Value::as_array)) {
            add(uri, edits);
        }
    }
    out
}

/// Byte offset of `p` in `text`, as v1 computed it: the line's start plus `character` UTF-16 units,
/// running on past the line's end, capped at the text's end.
fn offset(text: &str, line_starts: &[usize], p: Pos) -> usize {
    let Some(&start) = line_starts.get(p.line as usize) else { return text.len() };
    let mut units = 0u32;
    for (i, ch) in text[start..].char_indices() {
        if units >= p.character {
            return start + i;
        }
        units += u32::try_from(ch.len_utf16()).unwrap_or(1);
    }
    text.len()
}

/// `text` with `edits` applied from the end of the file back, so each edit's offsets still point where
/// the server meant. Edits at the same place keep the server's order (a stable sort, as v1's).
pub fn apply_edits(text: &str, edits: &[TextEdit]) -> String {
    let mut starts = vec![0];
    starts.extend(text.match_indices('\n').map(|(i, _)| i + 1));
    let mut at: Vec<(usize, usize, &str)> = edits
        .iter()
        .map(|e| {
            let a = offset(text, &starts, e.start);
            (a, offset(text, &starts, e.end).max(a), e.new_text.as_str())
        })
        .collect();
    at.sort_by(|x, y| y.0.cmp(&x.0));
    let mut out = text.to_owned();
    for (a, b, new) in at {
        // Overlapping edits are the server's mistake: clamp so it can't cut outside the text.
        let b = b.min(out.len());
        let a = a.min(b);
        if out.is_char_boundary(a) && out.is_char_boundary(b) {
            out.replace_range(a..b, new);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testrng::Rng;
    use serde_json::json;

    fn e(l0: u32, c0: u32, l1: u32, c1: u32, t: &str) -> TextEdit {
        TextEdit { start: Pos { line: l0, character: c0 }, end: Pos { line: l1, character: c1 }, new_text: t.into() }
    }

    #[test]
    fn rename_in_a_file() {
        let text = "import { add } from './math.js';\nconst twice = (x) => add(x, x);\n";
        let out = apply_edits(text, &[e(0, 9, 0, 12, "sum"), e(1, 21, 1, 24, "sum")]);
        assert_eq!(out, "import { sum } from './math.js';\nconst twice = (x) => sum(x, x);\n");
    }

    #[test]
    fn utf16_columns() {
        // 🦀 is two UTF-16 units: the name after it starts at character 3
        let out = apply_edits("a🦀add", &[e(0, 3, 0, 6, "sum")]);
        assert_eq!(out, "a🦀sum");
    }

    #[test]
    fn past_the_end_is_capped() {
        assert_eq!(apply_edits("ab\ncd", &[e(9, 0, 9, 0, "!")]), "ab\ncd!");
        assert_eq!(apply_edits("ab\ncd", &[e(0, 9, 0, 9, "!")]), "ab\ncd!");
        // character runs on into the next line, as v1's offsets did
        assert_eq!(apply_edits("ab\ncd", &[e(0, 4, 0, 5, "X")]), "ab\ncX");
    }

    #[test]
    fn same_place_keeps_order() {
        assert_eq!(apply_edits("x", &[e(0, 0, 0, 0, "1"), e(0, 0, 0, 0, "2")]), "21x");
    }

    #[test]
    fn changes_then_document_changes() {
        let edit = json!({
            "changes": { "file:///r/a.ts": [{ "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } }, "newText": "b" }] },
            "documentChanges": [
                { "textDocument": { "uri": "file:///r/a.ts", "version": 1 }, "edits": [{ "range": { "start": { "line": 1, "character": 0 }, "end": { "line": 1, "character": 1 } }, "newText": "c" }] },
                { "textDocument": { "uri": "file:///r/b.ts", "version": 1 }, "edits": [] },
                { "kind": "create", "uri": "file:///r/new.ts" }
            ]
        });
        let w = workspace_edits(&edit);
        assert_eq!(w.iter().map(|(u, e)| (u.as_str(), e.len())).collect::<Vec<_>>(), [("file:///r/a.ts", 2), ("file:///r/b.ts", 0)]);
        assert!(workspace_edits(&Value::Null).is_empty());
    }

    /// Property: non-overlapping edits give the same text in any order, and that text is what writing
    /// the file front to back would give.
    #[test]
    fn edits_apply_from_the_end() {
        let mut rng = Rng::new(0xed17);
        let words = ["add", "x", "🦀", "é", " ", "\n", "sum(", ")", "\n\n"];
        for round in 0..400 {
            let text: String = (0..rng.below(30)).map(|_| words[rng.below(words.len())]).collect();
            // cut points on char boundaries, as (line, utf16 char) positions
            let mut cuts: Vec<usize> = (0..rng.below(8) * 2).map(|_| rng.below(text.len() + 1)).filter(|i| text.is_char_boundary(*i)).collect();
            cuts.sort_unstable();
            cuts.dedup();
            if cuts.len() % 2 == 1 {
                cuts.pop();
            }
            let to_pos = |b: usize| {
                let before = &text[..b];
                let line = before.matches('\n').count();
                let col: usize = before.rsplit('\n').next().unwrap_or("").encode_utf16().count();
                Pos { line: u32::try_from(line).unwrap_or(0), character: u32::try_from(col).unwrap_or(0) }
            };
            let mut edits: Vec<TextEdit> = cuts.chunks(2).map(|c| TextEdit { start: to_pos(c[0]), end: to_pos(c[1]), new_text: format!("<{}>", rng.below(99)) }).collect();
            let mut want = String::new();
            let mut last = 0;
            for (c, ed) in cuts.chunks(2).zip(&edits) {
                want.push_str(&text[last..c[0]]);
                want.push_str(&ed.new_text);
                last = c[1];
            }
            want.push_str(&text[last..]);
            assert_eq!(apply_edits(&text, &edits), want, "round {round}");
            edits.reverse();
            let n = edits.len();
            if n > 2 {
                edits.swap(0, rng.below(n));
            }
            assert_eq!(apply_edits(&text, &edits), want, "round {round}, shuffled");
        }
    }
}
