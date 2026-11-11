//! Reading a message and writing one (v1 grid/mail.js `parseMail`, `composeMail`). A message is read as latin1, one
//! char per byte, until a part says what its bytes are. Who it's from is strict on purpose: two parsers must not be
//! able to disagree on who that was.

use base64::Engine as _;

use crate::dkim::{header_fields, latin1};

pub const TEXT_MAX: usize = 64 * 1024;
pub const HTML_MAX: usize = 128 * 1024;
pub const REFS_MAX: usize = 20;
const LINE_MAX: usize = 78;
/// What wisp reads from a message appears once, or a copy added above a signed one could be read in its place.
const ONCE: [&str; 5] = ["subject", "date", "message-id", "in-reply-to", "references"];

/// What the rest of wisp reads of a message.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Mail {
    /// the one sender, lower case; '' when it can't be told for certain
    pub from: String,
    pub subject: String,
    pub message_id: String,
    pub date: String,
    pub in_reply_to: String,
    pub references: Vec<String>,
    /// written by a machine: never answered (or two of them mail each other all week)
    pub auto: bool,
    pub text: String,
    pub html: String,
    pub attachments: u32,
}

/// A Message-ID as one may be written.
pub fn msg_id_ok(s: &str) -> bool {
    s.len() >= 3 && s.len() <= 252 && s.starts_with('<') && s.ends_with('>') && s[1..s.len() - 1].bytes().all(|b| (0x21..=0x7e).contains(&b) && b != b'<' && b != b'>')
}

/// An address as wisp writes to one: lower case, a dotted domain.
pub fn address_ok(a: &str) -> bool {
    let Some((local, domain)) = a.split_once('@') else { return false };
    let lok = !local.is_empty() && local.len() <= 64 && local.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || "!#$%&'*+/=?^_`{|}~.-".contains(c));
    let parts: Vec<&str> = domain.split('.').collect();
    lok && parts.len() >= 2 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-'))
}

fn split_part(s: &str) -> (&str, &str) {
    if let Some(i) = s.find("\r\n\r\n") {
        return (&s[..i], &s[i + 4..]);
    }
    if let Some(i) = s.find("\n\n") {
        return (&s[..i], &s[i + 2..]);
    }
    if let Some(rest) = s.strip_prefix("\r\n").or_else(|| s.strip_prefix('\n')) {
        return ("", rest);
    }
    (s, "")
}

/// `[(lower-case name, value)]`, folded lines put back.
fn header_list(head: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in head.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)) {
        if line.starts_with([' ', '\t']) {
            if let Some(last) = out.last_mut() {
                last.1.push(' ');
                last.1.push_str(line.trim());
            }
        } else if let Some(c) = line.find(':').filter(|c| *c > 0) {
            out.push((line[..c].trim().to_lowercase(), line[c + 1..].trim().to_owned()));
        }
    }
    out
}

fn first<'a>(list: &'a [(String, String)], name: &str) -> &'a str {
    list.iter().find(|(n, _)| n == name).map_or("", |(_, v)| v.as_str())
}

/// `text/plain; charset="x"` → (value, params).
fn with_params(v: &str) -> (String, Vec<(String, String)>) {
    let mut parts = v.split(';');
    let value = parts.next().unwrap_or_default().trim().to_lowercase();
    let params = parts
        .filter_map(|p| {
            let (k, v) = p.split_once('=')?;
            let v = v.trim();
            let v = v.strip_prefix('"').and_then(|x| x.split('"').next()).unwrap_or_else(|| v.split_whitespace().next().unwrap_or_default());
            Some((k.trim().to_lowercase(), v.to_owned()))
        })
        .collect();
    (value, params)
}

fn param<'a>(p: &'a [(String, String)], k: &str) -> Option<&'a str> {
    p.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
}

fn unencode(s: &str, cte: &str) -> Vec<u8> {
    match cte.trim().to_lowercase().as_str() {
        "base64" => base64::engine::general_purpose::STANDARD.decode(s.chars().filter(|c| !c.is_whitespace()).collect::<String>()).unwrap_or_default(),
        "quoted-printable" => {
            let soft = s.replace("=\r\n", "").replace("=\n", "");
            let b = soft.as_bytes();
            let mut out = Vec::with_capacity(b.len());
            let mut i = 0;
            while i < b.len() {
                if b[i] == b'='
                    && let Some(h) = soft.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok())
                {
                    out.push(h);
                    i += 3;
                    continue;
                }
                out.push(u8::try_from(u32::from(soft[i..].chars().next().unwrap_or('?'))).unwrap_or(b'?'));
                i += soft[i..].chars().next().map_or(1, char::len_utf8);
            }
            out
        }
        _ => s.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?')).collect(),
    }
}

/// UTF-8, ASCII and Latin-1 by name; anything else read as UTF-8, its bad bytes replaced.
fn decode_text(b: &[u8], charset: &str) -> String {
    match charset.trim().to_lowercase().as_str() {
        "iso-8859-1" | "latin1" | "latin-1" | "windows-1252" | "cp1252" => latin1(b),
        _ => String::from_utf8_lossy(b).into_owned(),
    }
}

/// `=?charset?B|Q?…?=` in a subject; spaces between two of them are folding.
fn encoded_words(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    let mut last_was_word = false;
    while let Some(i) = rest.find("=?") {
        let (before, at) = rest.split_at(i);
        let word = at[2..].splitn(4, '?').collect::<Vec<_>>();
        let end = (word.len() == 4 && word[3].starts_with('=')).then(|| 2 + word[0].len() + 1 + word[1].len() + 1 + word[2].len() + 2);
        let (Some(end), [cs, how, data, _]) = (end, word.as_slice()) else {
            out.push_str(before);
            out.push_str("=?");
            rest = &at[2..];
            last_was_word = false;
            continue;
        };
        if !(last_was_word && before.trim().is_empty()) {
            out.push_str(before);
        }
        let raw = if how.eq_ignore_ascii_case("b") { base64::engine::general_purpose::STANDARD.decode(data).unwrap_or_default() } else { unencode(&data.replace('_', " "), "quoted-printable") };
        out.push_str(&decode_text(&raw, cs));
        rest = &at[end..];
        last_was_word = true;
    }
    out.push_str(rest);
    out
}

#[derive(Default)]
struct Found {
    text: Option<String>,
    html: Option<String>,
    attachments: u32,
}

/// One part and what's inside it. Text in a part with a filename is an attachment, whatever its type.
fn walk_part(list: &[(String, String)], body: &str, out: &mut Found, depth: u32) {
    let ct = first(list, "content-type");
    let (ty, tp) = with_params(if ct.is_empty() { "text/plain" } else { ct });
    let (place, pp) = with_params(first(list, "content-disposition"));
    if ty.starts_with("multipart/")
        && let Some(boundary) = param(&tp, "boundary")
        && depth < 8
    {
        let mark = format!("--{boundary}");
        let end = format!("{mark}--");
        let mut parts: Vec<String> = Vec::new();
        let mut cur: Option<String> = None;
        for line in body.split_inclusive('\n') {
            let t = line.trim_end();
            if t == mark || t == end {
                if let Some(c) = cur.take() {
                    parts.push(c);
                }
                if t == end {
                    break;
                }
                cur = Some(String::new());
            } else if let Some(c) = cur.as_mut() {
                c.push_str(line);
            }
        }
        if let Some(c) = cur {
            parts.push(c);
        }
        for p in parts.iter().take(50) {
            let p = p.strip_suffix("\r\n").or_else(|| p.strip_suffix('\n')).unwrap_or(p);
            let (head, b) = split_part(p);
            walk_part(&header_list(head), b, out, depth + 1);
        }
        return;
    }
    let attached = place == "attachment" || param(&pp, "filename").is_some() || param(&tp, "name").is_some();
    if attached || !(ty == "text/plain" || ty == "text/html") {
        out.attachments += 1;
        return;
    }
    let text = decode_text(&unencode(body, first(list, "content-transfer-encoding")), param(&tp, "charset").unwrap_or("utf-8"));
    let slot = if ty == "text/plain" { &mut out.text } else { &mut out.html };
    if slot.is_none() {
        *slot = Some(text);
    }
}

/// The one mailbox in a From's value, or ''. One address, no groups, no comments; a quoted name is only ever a
/// name, and one with an angle bracket in it reads as an address to somebody, so that's nobody.
pub fn mailbox(from: &str) -> String {
    let mut value = String::new();
    let mut names = Vec::new();
    let mut chars = from.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            let mut name = String::new();
            while let Some(n) = chars.next() {
                if n == '\\' {
                    name.extend(chars.next());
                } else if n == '"' {
                    break;
                } else {
                    name.push(n);
                }
            }
            names.push(name);
        } else {
            value.push(c);
        }
    }
    if names.iter().any(|n| n.contains(['<', '>'])) {
        return String::new();
    }
    let value = value.trim();
    let addr = if let Some(open) = value.find('<') {
        let (name, rest) = value.split_at(open);
        let inner = rest.strip_prefix('<').and_then(|r| r.strip_suffix('>'));
        match inner {
            Some(a) if !name.contains(['<', '>', ',', ';', ':', '(', ')', '@', '"']) && !a.contains(['<', '>']) && !a.contains(char::is_whitespace) => a.to_lowercase(),
            _ => return String::new(),
        }
    } else if !value.is_empty() && !value.contains(char::is_whitespace) && !value.contains(['<', '>']) {
        value.to_lowercase()
    } else {
        return String::new();
    };
    if address_ok(&addr) { addr } else { String::new() }
}

fn ids(v: &str) -> Vec<String> {
    v.split(|c: char| c.is_whitespace() || c == ',').filter(|x| msg_id_ok(x)).map(str::to_owned).collect()
}

fn automatic(list: &[(String, String)]) -> bool {
    let auto = first(list, "auto-submitted").to_lowercase();
    (!auto.is_empty() && auto != "no") || matches!(first(list, "precedence").to_lowercase().as_str(), "bulk" | "junk" | "list" | "auto_reply") || list.iter().any(|(n, _)| matches!(n.as_str(), "list-id" | "x-autoreply" | "x-autorespond"))
}

/// The message's bytes → what wisp reads of it.
pub fn parse_mail(raw: &[u8]) -> Mail {
    let section = header_fields(&latin1(raw));
    let list: Vec<(String, String)> = section.as_ref().map(|(fields, _)| fields.iter().map(|f| (f.name.clone(), f.raw[f.raw.find(':').map_or(0, |i| i + 1)..].split("\r\n").map(str::trim).collect::<Vec<_>>().join(" ").trim().to_owned())).collect()).unwrap_or_default();
    let mut found = Found::default();
    if let Some((_, body)) = &section {
        walk_part(&list, body, &mut found, 0);
    }
    let froms: Vec<&str> = list.iter().filter(|(n, _)| n == "from").map(|(_, v)| v.as_str()).collect();
    let twice = ONCE.iter().any(|name| list.iter().filter(|(n, _)| n == name).count() > 1);
    let from = if froms.len() == 1 && !twice { mailbox(froms[0]) } else { String::new() };
    let claimed: Vec<&str> = list.iter().filter(|(n, _)| n == "message-id").map(|(_, v)| v.as_str()).collect();
    let subject: String = encoded_words(first(&list, "subject")).chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().split(' ').filter(|w| !w.is_empty()).collect::<Vec<_>>().join(" ");
    let refs = ids(first(&list, "references"));
    Mail {
        from,
        subject: subject.chars().take(500).collect(),
        message_id: claimed.first().filter(|m| claimed.len() == 1 && msg_id_ok(m)).map(|m| (*m).to_owned()).unwrap_or_default(),
        date: first(&list, "date").to_owned(),
        in_reply_to: ids(first(&list, "in-reply-to")).into_iter().next().unwrap_or_default(),
        references: refs[refs.len().saturating_sub(REFS_MAX)..].to_vec(),
        auto: automatic(&list),
        text: found.text.unwrap_or_default().chars().take(TEXT_MAX).collect(),
        html: found.html.unwrap_or_default().chars().take(HTML_MAX).collect(),
        attachments: found.attachments,
    }
}

fn ascii_header(s: &str) -> String {
    if s.bytes().all(|b| (0x20..=0x7e).contains(&b)) { s.to_owned() } else { format!("=?UTF-8?B?{}?=", base64::engine::general_purpose::STANDARD.encode(s)) }
}

/// `Name: <id> <id>`, wrapped so no line gets long.
fn fold_ids(name: &str, list: &[String]) -> String {
    let head = format!("{name}:");
    let mut lines = vec![head.clone()];
    for id in list {
        let last = lines.last_mut().map_or(0, |l| l.len());
        if last + 1 + id.len() > LINE_MAX && lines.last().is_some_and(|l| *l != head) {
            lines.push(format!(" {id}"));
        } else if let Some(l) = lines.last_mut() {
            l.push(' ');
            l.push_str(id);
        }
    }
    lines.join("\r\n")
}

/// A reply to write.
#[derive(Debug, Clone, Default)]
pub struct Out<'a> {
    pub from: &'a str,
    pub to: &'a str,
    pub subject: &'a str,
    pub text: &'a str,
    pub message_id: &'a str,
    pub in_reply_to: &'a str,
    pub references: &'a [String],
    /// RFC 5322's date
    pub date: &'a str,
}

/// A plain-text message, every line decided here. A stray line break in a header would write a header of the
/// sender's choosing, so what can't hold one is refused, and a subject is flattened.
pub fn compose_mail(o: &Out<'_>) -> Option<String> {
    let headers = [o.from, o.to, o.message_id, o.in_reply_to, o.date];
    if headers.iter().chain(o.references.iter().map(String::as_str).collect::<Vec<_>>().iter()).any(|h| h.contains(['\r', '\n'])) {
        return None;
    }
    let flat: String = o.subject.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().to_owned();
    let body = base64::engine::general_purpose::STANDARD.encode(o.text);
    let wrapped: Vec<&str> = body.as_bytes().chunks(76).filter_map(|c| std::str::from_utf8(c).ok()).collect();
    Some(
        [
            format!("From: {}", o.from),
            format!("To: {}", o.to),
            format!("Subject: {}", ascii_header(&flat)),
            format!("Date: {}", o.date),
            format!("Message-ID: {}", o.message_id),
            format!("In-Reply-To: {}", o.in_reply_to),
            fold_ids("References", o.references),
            "MIME-Version: 1.0".into(),
            "Content-Type: text/plain; charset=utf-8".into(),
            "Content-Transfer-Encoding: base64".into(),
            "Auto-Submitted: auto-replied".into(),
            "X-Auto-Response-Suppress: All".into(),
            String::new(),
            wrapped.join("\r\n"),
        ]
        .join("\r\n"),
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    /// v1 test/mail.test.js `parseMail`: who it's from, strictly; the text whichever way it came.
    #[test]
    fn a_message_is_read_strictly_and_its_text_whichever_way_it_came() {
        let raw = "From: \"Ada L\" <Ada@Example.com>\r\nSubject: =?UTF-8?B?Zml4IMOp?= =?UTF-8?Q?_now?=\r\nMessage-ID: <m1@x.y>\r\nIn-Reply-To: <r1@w>\r\nReferences: <a@b> <r1@w>\r\nDate: Tue, 2 Jan 2024\r\nContent-Type: multipart/alternative; boundary=\"B\"\r\n\r\n--B\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\ncaf=C3=A9 =\r\nok\r\n--B\r\nContent-Type: text/html\r\n\r\n<p>hi</p>\r\n--B\r\nContent-Type: application/pdf; name=x.pdf\r\n\r\nPDF\r\n--B--\r\n";
        let m = parse_mail(raw.as_bytes());
        assert_eq!((m.from.as_str(), m.subject.as_str(), m.message_id.as_str()), ("ada@example.com", "fix é now", "<m1@x.y>"));
        assert_eq!((m.in_reply_to.as_str(), m.references.len()), ("<r1@w>", 2));
        assert_eq!((m.text.as_str(), m.html.as_str(), m.attachments), ("café ok", "<p>hi</p>", 1));
        assert!(!m.auto);
        let two = raw.replacen("Subject:", "Subject: other\r\nSubject:", 1);
        assert_eq!(parse_mail(two.as_bytes()).from, "", "a second Subject: nobody it's certainly from");
        assert!(parse_mail(b"From: a@b.co\r\nAuto-Submitted: auto-replied\r\n\r\nx").auto);
        for (f, want) in [("Ada <ada@x.io>", "ada@x.io"), ("ada@x.io", "ada@x.io"), ("\"evil <eve@x.io>\" <ada@x.io>", ""), ("a@x.io, b@x.io", ""), ("Ada <ada@localhost>", ""), ("(c) ada@x.io", "")] {
            assert_eq!(mailbox(f), want, "{f}");
        }
    }

    #[test]
    fn a_reply_is_written_line_by_line_and_a_line_break_in_a_header_is_refused() {
        let refs = vec!["<a@b>".to_owned()];
        let o = Out { from: "wisp <k@grid.dev>", to: "ada@x.io", subject: "Re: fix\nBcc: eve@x.io", text: "done ✓", message_id: "<n@grid.dev>", in_reply_to: "<m1@x.y>", references: &refs, date: "Tue, 02 Jan 2024 03:04:05 GMT" };
        let raw = compose_mail(&o).unwrap();
        assert!(raw.contains("\r\nSubject: Re: fix Bcc: eve@x.io\r\n"), "the subject is flattened: {raw}");
        assert!(raw.contains("Auto-Submitted: auto-replied"));
        let back = parse_mail(raw.as_bytes());
        assert_eq!((back.text.as_str(), back.in_reply_to.as_str()), ("done ✓", "<m1@x.y>"));
        assert!(compose_mail(&Out { to: "ada@x.io\r\nBcc: eve@x.io", ..o }).is_none());
    }
}
