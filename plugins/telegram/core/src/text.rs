//! What a Telegram message says. Telegram counts a text's length in UTF-16 code units (4096 at
//! most), so that's what is counted here: an emoji is two, and a cut never halves one.
use wisp_channels_api::Msg;

/// `sendMessage`'s limit.
pub const CHUNK_MAX: usize = 4096;
/// At most this many messages for one report: past it the last one is cut.
pub const CHUNKS_MAX: usize = 3;
/// A button's label (v1: 60), an answer to a tap (Telegram: 200; v1 kept 190).
pub const LABEL_MAX: usize = 60;
pub const TAP_ANSWER_MAX: usize = 190;

const REPLY_HINT: &str = "↩ Reply to this message to answer or follow up.";

fn units(c: char) -> usize {
    c.len_utf16()
}

/// At most `max` UTF-16 units, with `…` when cut. v1 `truncate`, counted as Telegram counts.
pub fn truncate(s: &str, max: usize) -> String {
    if s.encode_utf16().count() <= max {
        return s.to_owned();
    }
    let mut out = String::new();
    let mut n = 0;
    for c in s.chars() {
        if n + units(c) > max.saturating_sub(1) {
            break;
        }
        n += units(c);
        out.push(c);
    }
    out.push('…');
    out
}

/// Pieces of at most `max` units, cut at the last line break, else the last space, in the second
/// half of a piece; else between characters. Nothing is lost and nothing is added but trimming at
/// the cuts.
pub fn split(text: &str, max: usize) -> Vec<String> {
    let max = max.max(2);
    let mut out = Vec::new();
    let mut rest = text;
    while rest.encode_utf16().count() > max {
        let (mut hard, mut n) = (0, 0);
        for (i, c) in rest.char_indices() {
            if n + units(c) > max {
                break;
            }
            n += units(c);
            hard = i + c.len_utf8();
        }
        let half = |i: usize| rest[..i].encode_utf16().count() > max / 2;
        let at = |sep: char| rest[..hard].rfind(sep).filter(|&i| half(i));
        let cut = at('\n').or_else(|| at(' ')).unwrap_or(hard);
        let (piece, tail) = rest.split_at(cut);
        out.push(piece.trim_end().to_owned());
        rest = tail.trim_start_matches(['\n', ' ']);
    }
    if !rest.is_empty() || out.is_empty() {
        out.push(rest.to_owned());
    }
    out
}

/// The texts a report goes as: title, text, and, about a task, how to answer. Long reports go in up
/// to `CHUNKS_MAX` messages; the last one is cut.
pub fn publish_text(msg: &Msg, about_a_task: bool) -> Vec<String> {
    let hint = if about_a_task { format!("\n\n{REPLY_HINT}") } else { String::new() };
    let whole = format!("{}\n\n{}{hint}", msg.title, msg.text);
    let mut parts = split(&whole, CHUNK_MAX);
    if parts.len() > CHUNKS_MAX {
        let tail = parts.split_off(CHUNKS_MAX - 1).join("\n");
        // The hint is what the reader acts on: it stays at the end, whatever was cut.
        let room = CHUNK_MAX.saturating_sub(hint.encode_utf16().count());
        parts.push(format!("{}{hint}", truncate(tail.strip_suffix(hint.as_str()).unwrap_or(&tail), room)));
    }
    parts
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::assert_is_empty)]
mod tests {
    use super::*;

    #[test]
    fn truncate_counts_utf16() {
        assert_eq!(truncate("hello", 5), "hello");
        assert_eq!(truncate("hello!", 5), "hell…");
        let e = "😀😀😀"; // six units
        assert_eq!(truncate(e, 6), e);
        assert_eq!(truncate(e, 5), "😀😀…");
    }

    #[test]
    fn split_prefers_lines_then_spaces() {
        let t = format!("{}\n{}", "a".repeat(60), "b".repeat(60));
        assert_eq!(split(&t, 100), vec!["a".repeat(60), "b".repeat(60)]);
        let t = format!("{} {}", "a".repeat(60), "b".repeat(60));
        assert_eq!(split(&t, 100), vec!["a".repeat(60), "b".repeat(60)]);
        let t = "c".repeat(250);
        assert_eq!(split(&t, 100).iter().map(String::len).collect::<Vec<_>>(), vec![100, 100, 50]);
        assert_eq!(split("", 100), vec![String::new()]);
    }

    #[test]
    fn a_report_keeps_its_hint() {
        let msg = Msg { title: "Done".into(), text: "x ".repeat(9000), actions: vec![] };
        let parts = publish_text(&msg, true);
        assert_eq!(parts.len(), CHUNKS_MAX);
        assert!(parts.iter().all(|p| p.encode_utf16().count() <= CHUNK_MAX));
        assert!(parts[CHUNKS_MAX - 1].ends_with(REPLY_HINT));
        let short = publish_text(&Msg { title: "Q".into(), text: "which?".into(), actions: vec![] }, false);
        assert_eq!(short, vec!["Q\n\nwhich?".to_owned()]);
    }

    /// Property: pieces fit, and joined back they hold every non-space character in order.
    #[test]
    fn property_split_loses_nothing() {
        let mut x: u64 = 0x2545_F491_4F6C_DD1D;
        let pool = ['a', 'é', '😀', ' ', '\n', 'z', '中'];
        for _ in 0..2000 {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            let len = usize::try_from(x % 600).unwrap();
            let max = 10 + usize::try_from(x % 90).unwrap();
            let text: String = (0..len).map(|i| pool[(usize::try_from(x >> (i % 50)).unwrap() + i) % pool.len()]).collect();
            let parts = split(&text, max);
            assert!(parts.iter().all(|p| p.encode_utf16().count() <= max), "max {max}");
            let squash = |s: &str| s.chars().filter(|c| !c.is_whitespace()).collect::<String>();
            assert_eq!(squash(&parts.concat()), squash(&text));
        }
    }
}
