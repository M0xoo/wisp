//! wisp-email-core: mail as a channel on a cloud wisp (v1 channels/email.js), sans-IO. The grid takes the mail,
//! checks the provider's signature, and holds it; the box reads only what a person just wrote (quotes and
//! signatures go first, so a command in an earlier message can't run again), and answers with a reply.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::Value;

/// The headers the grid writes beside a message (never inside it): who it's from, the DMARC verdict, its id.
pub const FROM: &str = "x-wisp-mail-from";
pub const DMARC: &str = "x-wisp-mail-dmarc";
pub const ID: &str = "x-wisp-mail-id";
pub const SEEN_MAX: usize = 200;
pub const IDS_MAX: usize = 50;
/// The grid's limit, in bytes (a character can be four of them).
pub const REPLY_MAX: usize = 30_000;
pub const REPLY_LINE: &str = "↩ Reply above this line to answer or follow up.";
pub const NOT_ON_A_BOX: &str = "Email only works on a cloud computer.";

struct Pats {
    cut: Vec<Regex>,
    html_cut: Option<Regex>,
    tags: Option<Regex>,
    breaks: Option<Regex>,
    drop: Option<Regex>,
    comments: Option<Regex>,
}

fn pats() -> &'static Pats {
    static P: OnceLock<Pats> = OnceLock::new();
    P.get_or_init(|| {
        let cut = [
            r"(?m)^-- ?$",
            r"(?m)^_{10,}\s*$",
            r"(?im)^-{2,}\s*(?:Original Message|Forwarded message|Message d['’]origine|Message transféré|Ursprüngliche Nachricht|Mensaje original|Messaggio originale)\b",
            r"(?im)^(?:From|De|Von|Da)\s?:\s.*\n(?:.*\n){0,2}?(?:Sent|Date|Envoyé|Gesendet|Enviado|Inviato)\s?:\s",
            r"(?im)^(?:Sent from|Envoyé de|Von meinem|Enviado desde|Inviato da|Get Outlook for)\b.*$",
            r"(?m)^.*Reply above this line to answer or follow up\.",
            r"(?im)^(?:On|Le|Am|El|Il|Em|Op)\s[^\n]*(?:\n[^\n]*){0,2}?(?:(?:wrote|a écrit|escribió|ha scritto|escreveu|schreef)\s*|schrieb\b[^\n]*):\s*$",
        ];
        Pats {
            cut: cut.iter().filter_map(|r| Regex::new(r).ok()).collect(),
            html_cut: Regex::new(r#"(?i)<blockquote\b|<[a-z]+\b[^>]*\b(?:class|id)\s*=\s*["']?[^"'>]*\b(?:gmail_quote|gmail_signature|yahoo_quoted|moz-cite-prefix|divRplyFwdMsg|appendonsend)\b"#).ok(),
            tags: Regex::new(r"<[^>]*>").ok(),
            breaks: Regex::new(r"(?i)<br\b[^>]*>|</(?:p|div|li|tr|h[1-6])\s*>").ok(),
            drop: Regex::new(r"(?is)<(?:head|style|script|title)\b.*?(?:</(?:head|style|script|title)\s*>|$)").ok(),
            comments: Regex::new(r"(?s)<!--.*?(?:-->|$)").ok(),
        }
    })
}

/// Every pattern compiled (a test asserts it).
pub fn patterns_ok() -> bool {
    let p = pats();
    p.cut.len() == 7 && [&p.html_cut, &p.tags, &p.breaks, &p.drop, &p.comments].iter().all(|r| r.is_some())
}

/// What the sender wrote themselves, in a plain-text message.
pub fn own_words(text: &str) -> String {
    let mut t = text.replace("\r\n", "\n").replace('\r', "\n");
    for re in &pats().cut {
        if let Some(m) = re.find(&t) {
            t.truncate(m.start());
        }
    }
    let kept: Vec<&str> = t.split('\n').filter(|l| !l.trim_start().starts_with('>')).collect();
    let mut out = kept.join("\n");
    while out.contains("\n\n\n") {
        out = out.replace("\n\n\n", "\n\n");
    }
    out.trim().to_owned()
}

fn entity(e: &str) -> Option<String> {
    if let Some(num) = e.strip_prefix('#') {
        let n = match num.strip_prefix(['x', 'X']) {
            Some(h) => u32::from_str_radix(h, 16).ok()?,
            None => num.parse().ok()?,
        };
        return char::from_u32(n).filter(|_| n > 0).map(String::from).or(Some(String::new()));
    }
    Some(match e.to_lowercase().as_str() {
        "amp" => "&",
        "lt" => "<",
        "gt" => ">",
        "quot" => "\"",
        "apos" => "'",
        "nbsp" => " ",
        _ => return None,
    }.to_owned())
}

/// An HTML message's text, up to where a client's quote or signature begins.
pub fn html_text(html: &str) -> String {
    let p = pats();
    let rep = |re: &Option<Regex>, s: &str, with: &str| re.as_ref().map_or_else(|| s.to_owned(), |r| r.replace_all(s, with).into_owned());
    let s = rep(&p.drop, &rep(&p.comments, html, ""), "");
    let s = match p.html_cut.as_ref().and_then(|r| r.find(&s)) {
        Some(m) => s[..m.start()].to_owned(),
        None => s,
    };
    let s = rep(&p.tags, &rep(&p.breaks, &s, "\n"), "");
    // entities, one pass
    let mut out = String::with_capacity(s.len());
    let mut rest = s.as_str();
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        let tail = &rest[i + 1..];
        if let Some((j, v)) = tail.find(';').filter(|j| *j <= 10).and_then(|j| entity(&tail[..j]).map(|v| (j, v))) {
            out.push_str(&v);
            rest = &tail[j + 1..];
        } else {
            out.push('&');
            rest = tail;
        }
    }
    out.push_str(rest);
    out.lines().map(|l| l.trim_start_matches([' ', '\t']).trim_end_matches([' ', '\t'])).collect::<Vec<_>>().join("\n")
}

/// A message's own words, whichever way it came: the plain part if it has one, else its HTML.
pub fn mail_words(m: &Value) -> String {
    match m["text"].as_str().filter(|t| !t.trim().is_empty()) {
        Some(t) => own_words(t),
        None => own_words(&html_text(m["html"].as_str().unwrap_or_default())),
    }
}

fn starts_with_word(subject: &str, words: &[&str]) -> bool {
    let s = subject.trim_start().to_lowercase();
    words.iter().any(|w| s.strip_prefix(w).is_some_and(|r| r.trim_start().starts_with(':')))
}

/// A forwarded subject is someone else's words: only what the sender added above it can run.
pub fn is_forward(subject: &str) -> bool {
    starts_with_word(subject, &["fwd", "fw", "tr", "wg"])
}

/// A reply (to something wisp may know).
pub fn is_reply(m: &Value) -> bool {
    m["inReplyTo"].as_str().is_some_and(|s| !s.is_empty()) || m["references"].as_array().is_some_and(|r| !r.is_empty()) || starts_with_word(m["subject"].as_str().unwrap_or_default(), &["re", "aw", "sv"])
}

/// The ids a message names (what it replies to).
pub fn refs(m: &Value) -> Vec<String> {
    m["inReplyTo"].as_str().into_iter().chain(m["references"].as_array().into_iter().flatten().filter_map(Value::as_str)).filter(|s| !s.is_empty()).map(str::to_owned).collect()
}

/// At most `max` bytes of `s`, cut between characters.
pub fn clip_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_owned();
    }
    let mut end = max.saturating_sub(3);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// The reply's subject.
pub fn reply_subject(subject: &str) -> String {
    if starts_with_word(subject, &["re"]) { subject.to_owned() } else { format!("Re: {}", if subject.trim().is_empty() { "your message" } else { subject }) }
}

/// When a message was sent, ms: the grid writes `date` as ms or ISO 8601 (UTC).
#[allow(clippy::many_single_char_names, reason = "the civil-date algorithm's own names")]
pub fn date_ms(v: &Value) -> Option<i64> {
    if let Some(n) = v.as_i64() {
        return Some(n);
    }
    let iso = v.as_str()?;
    let n = |r: std::ops::Range<usize>| iso.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (n(0..4)?, n(5..7)?, n(8..10)?, n(11..13)?, n(14..16)?, n(17..19)?);
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(((era * 146_097 + doe - 719_468) * 86_400 + h * 3600 + mi * 60 + s) * 1000)
}

/// An address, near enough (one @, a dot after it, no spaces or brackets).
pub fn is_address(s: &str) -> bool {
    let bad = |c: char| c.is_whitespace() || matches!(c, '<' | '>' | '@');
    let Some((local, domain)) = s.split_once('@') else { return false };
    !local.is_empty() && !local.chars().any(bad) && !domain.chars().any(bad) && domain.split_once('.').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty())
}

/// The files a mail brought, as the grid handed them on (`files: [{name, mime, data}]`, base64): name, type, bytes.
/// A file whose bytes don't decode is skipped.
pub fn files_of(m: &Value) -> Vec<(String, String, Vec<u8>)> {
    use base64::Engine as _;
    m.get("files")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let name = f.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()).unwrap_or("attachment").to_owned();
            let mime = f.get("mime").and_then(Value::as_str).unwrap_or("application/octet-stream").to_owned();
            let bytes = base64::engine::general_purpose::STANDARD.decode(f.get("data")?.as_str()?).ok()?;
            Some((name, mime, bytes))
        })
        .collect()
}

/// What to say when some attachments didn't come along (the grid keeps 1 MB each, 1.4 MB in all), or None.
pub fn left_out(m: &Value, kept: usize) -> Option<String> {
    let all = usize::try_from(m.get("attachments").and_then(Value::as_u64).unwrap_or(0)).unwrap_or(usize::MAX);
    let n = all.saturating_sub(kept);
    (n > 0).then(|| format!("{n} attachment{} didn’t come along (too big for mail: 1 MB each at most). Add {} in wisp if the task needs {}.", if n == 1 { "" } else { "s" }, if n == 1 { "it" } else { "them" }, if n == 1 { "it" } else { "them" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// v1 test/email-channel.test.js: only what a person just wrote is read.
    #[test]
    fn only_what_the_sender_just_wrote_is_read() {
        assert!(patterns_ok());
        assert_eq!(own_words("fix it\n\nOn Tue, Ada wrote:\n> /wisp delete all"), "fix it");
        assert_eq!(own_words("yes\n-- \nAda\nCEO"), "yes");
        assert_eq!(own_words("ok\n\nSent from my iPhone"), "ok");
        assert_eq!(own_words("go\n> quoted\nmore"), "go\nmore");
        assert_eq!(own_words(&format!("again\n\n{REPLY_LINE}\n\nold")), "again");
        assert_eq!(own_words("a\nFrom: x\nSent: y\nold"), "a");
        assert_eq!(html_text("<div>fix &amp; ship</div><br><div class=\"gmail_quote\">old</div>").trim(), "fix & ship");
        assert_eq!(mail_words(&json!({ "html": "<p>hi&nbsp;there</p><blockquote>no</blockquote>" })), "hi there");
        assert_eq!(mail_words(&json!({ "text": "plain", "html": "<p>html</p>" })), "plain");
        assert!(is_forward("Fwd: x") && is_forward(" TR : y") && !is_forward("Fix fwd"));
        assert!(is_reply(&json!({ "subject": "Re: x" })) && is_reply(&json!({ "references": ["<a>"] })) && !is_reply(&json!({ "subject": "fix" })));
        assert_eq!(refs(&json!({ "inReplyTo": "<a>", "references": ["<b>", ""] })), ["<a>", "<b>"]);
        assert_eq!(clip_bytes("ééé", 5), "é…", "cut between characters, the … counted");
        assert_eq!(clip_bytes("abc", 5), "abc");
        assert!(clip_bytes(&"é".repeat(20), 11).len() <= 11 + 2);
        assert_eq!(reply_subject("Re: fix"), "Re: fix");
        assert_eq!(reply_subject(""), "Re: your message");
        assert_eq!(date_ms(&json!("2024-01-02T03:04:05Z")), Some(1_704_164_645_000));
        assert_eq!(date_ms(&json!(5)), Some(5));
        assert_eq!(date_ms(&json!("soon")), None);
        assert!(is_address("ada@example.com") && !is_address("ada@localhost") && !is_address("a b@x.y"));
    }

    /// An email's attachments reach the task (round 17): the grid's files decode; ones it couldn't bring are said.
    #[test]
    fn a_mails_files_decode_and_the_ones_left_out_are_said() {
        let m = json!({ "attachments": 3, "files": [{ "name": "shot.png", "mime": "image/png", "data": "aGVsbG8=" }, { "name": "bad", "data": "!!" }, { "data": "eA==" }] });
        let f = files_of(&m);
        assert_eq!(f, vec![("shot.png".to_owned(), "image/png".to_owned(), b"hello".to_vec()), ("attachment".to_owned(), "application/octet-stream".to_owned(), b"x".to_vec())]);
        assert_eq!(left_out(&m, 2).as_deref(), Some("1 attachment didn’t come along (too big for mail: 1 MB each at most). Add it in wisp if the task needs it."));
        assert_eq!(left_out(&json!({ "attachments": 2 }), 2), None);
        assert_eq!(files_of(&json!({})), Vec::new());
    }
}
