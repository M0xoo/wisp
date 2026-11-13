//! DKIM (RFC 6376, RFC 8463), checked here (v1 grid/dkim.js). A mail provider's verdict never says which domain
//! signed, and an Authentication-Results line can be written by anyone, so who a message is from rests on a signature
//! this grid verified itself, against the key in the signer's own DNS (`Txt`, `hickory-resolver` in `mail.rs`).
//!
//! `verify` never fails and never lets a doubt through: a lookup that fails, a key it can't read or a tag it doesn't
//! like is `ok: false`, and the caller refuses what isn't proved. Bytes stay bytes: a message is read as latin1, one
//! char per byte, so a hash sees what was signed.

use std::collections::HashMap;

use base64::Engine as _;
use futures::future::BoxFuture;
use sha2::{Digest as _, Sha256};

const SIGNATURES_MAX: usize = 5;
const RSA_MIN_BITS: usize = 1024;
/// What wisp acts on: unsigned, a Subject could become the prompt, and a Date decide a message is fresh.
const MUST_SIGN: [&str; 3] = ["from", "subject", "date"];
pub const DNS_FAILED: &str = "DNS lookup failed";
const CRLF: &str = "\r\n";

/// Why a TXT lookup gave nothing: no such record is an answer; a failure (a timeout, SERVFAIL) is not.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lookup {
    NoSuchKey,
    Failed,
}

/// `name` → its TXT records, each as its strings.
pub type Txt = dyn Fn(String) -> BoxFuture<'static, Result<Vec<Vec<String>>, Lookup>> + Send + Sync;

/// One signature tried: its `d=`, whether it proves the message, why not, and whether DNS didn't answer (the one
/// failure a later try could turn out differently).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Checked {
    pub d: String,
    pub ok: bool,
    pub why: String,
    pub dns: bool,
}

/// latin1: one char per byte, both ways.
pub fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| char::from(c)).collect()
}

fn bytes(s: &str) -> Vec<u8> {
    s.chars().map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?')).collect()
}

/// A header field: its lower-case name and its raw text (folds kept).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Field {
    pub name: String,
    pub raw: String,
}

/// The one reading of a header section, for DKIM and for who a message is from: two parsers that split a section
/// differently are how a second From hides. A section ends at the first CRLFCRLF and nowhere else; None (unprovable)
/// for a bare CR or LF, a fold that's only whitespace, a line that's no header, or no end.
pub fn header_fields(s: &str) -> Option<(Vec<Field>, String)> {
    let end = s.find("\r\n\r\n")?;
    let head = &s[..end];
    let mut prev = '\0';
    for (i, c) in head.char_indices() {
        let next = head[i + c.len_utf8()..].chars().next();
        if (c == '\n' && prev != '\r') || (c == '\r' && next != Some('\n')) {
            return None;
        }
        prev = c;
    }
    let mut fields: Vec<Field> = Vec::new();
    if !head.is_empty() {
        for line in head.split(CRLF) {
            if line.starts_with([' ', '\t']) {
                let last = fields.last_mut()?;
                if line.trim().is_empty() {
                    return None;
                }
                last.raw.push_str(CRLF);
                last.raw.push_str(line);
            } else {
                let colon = line.find(':')?;
                let name = line[..colon].trim_end_matches([' ', '\t']);
                if name.is_empty() || !name.bytes().all(|b| (0x21..=0x7e).contains(&b) && b != b':') {
                    return None;
                }
                fields.push(Field { name: name.to_lowercase(), raw: line.to_owned() });
            }
        }
    }
    Some((fields, s[end + 4..].to_owned()))
}

/// `a=1; b=2` → tags, or None: a tag twice voids the list (RFC 6376, 3.2).
pub fn tag_list(s: &str) -> Option<HashMap<String, String>> {
    let mut tags = HashMap::new();
    for part in s.split(';') {
        if part.trim().is_empty() {
            continue;
        }
        let eq = part.find('=')?;
        let name = part[..eq].trim();
        let ok =
            name.chars().next().is_some_and(|c| c.is_ascii_alphabetic()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !ok || tags.contains_key(name) {
            return None;
        }
        tags.insert(name.to_owned(), part[eq + 1..].trim().to_owned());
    }
    Some(tags)
}

fn squeeze(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut ws = false;
    for c in s.chars() {
        if c == ' ' || c == '\t' {
            ws = true;
        } else {
            if ws {
                out.push(' ');
            }
            ws = false;
            out.push(c);
        }
    }
    if ws {
        out.push(' ');
    }
    out
}

fn relaxed_field(raw: &str) -> String {
    let c = raw.find(':').unwrap_or(raw.len());
    let unfolded = raw[c + 1..].replace("\r\n ", " ").replace("\r\n\t", "\t");
    let value = squeeze(&unfolded);
    let value = value.strip_prefix(' ').unwrap_or(&value);
    let value = value.strip_suffix(' ').unwrap_or(value);
    format!("{}:{value}", raw[..c].trim_end_matches([' ', '\t']).to_lowercase())
}

fn simple_body(body: &str) -> String {
    let mut b = body;
    while let Some(x) = b.strip_suffix(CRLF) {
        b = x;
    }
    format!("{b}{CRLF}")
}

fn relaxed_body(body: &str) -> String {
    let mut lines: Vec<String> = body.split(CRLF).map(|l| squeeze(l).trim_end_matches(' ').to_owned()).collect();
    while lines.last().is_some_and(String::is_empty) {
        lines.pop();
    }
    if lines.is_empty() { String::new() } else { format!("{}{CRLF}", lines.join(CRLF)) }
}

/// The signature's own field with `b=` emptied, and only `b=`: `bh=` stays.
fn without_b(raw: &str) -> String {
    let c = raw.find(':').map_or(0, |i| i + 1);
    let parts: Vec<String> = raw[c..]
        .split(';')
        .map(|p| {
            let t = p.trim_start_matches([' ', '\t', '\r', '\n']);
            let is_b = t.strip_prefix('b').is_some_and(|r| r.trim_start_matches([' ', '\t', '\r', '\n']).starts_with('='));
            if is_b { p[..=p.find('=').unwrap_or(0)].to_owned() } else { p.to_owned() }
        })
        .collect();
    format!("{}{}", &raw[..c], parts.join(";"))
}

fn no_ws(s: &str) -> String {
    s.chars().filter(|c| !matches!(c, ' ' | '\t' | '\r' | '\n')).collect()
}

fn b64(s: &str) -> Option<Vec<u8>> {
    let ok = !s.is_empty()
        && s.trim_end_matches('=').chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
        && s.len() - s.trim_end_matches('=').len() <= 2;
    ok.then(|| base64::engine::general_purpose::STANDARD.decode(s).ok()).flatten()
}

fn label_ok(l: &str) -> bool {
    !l.is_empty() && l.len() <= 63 && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') && !l.starts_with('-') && !l.ends_with('-')
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Rsa,
    Ed25519,
}

/// Why this key can't vouch for this signature, or None.
fn key_problem(tags: &HashMap<String, String>, kind: Kind, d: &str, i_domain: &str) -> Option<&'static str> {
    if tags.get("v").is_some_and(|v| v != "DKIM1") || !tags.contains_key("p") {
        return Some("no usable key");
    }
    let k = tags.get("k").map_or("rsa", String::as_str);
    if (k == "rsa") != (kind == Kind::Rsa) || !matches!(k, "rsa" | "ed25519") {
        return Some("key of another type");
    }
    let list = |n: &str| tags.get(n).map(|v| v.split(':').map(|x| x.trim().to_owned()).collect::<Vec<_>>());
    if list("h").is_some_and(|h| !h.iter().any(|x| x == "sha256")) {
        return Some("key not for sha256");
    }
    if list("s").is_some_and(|s| !s.iter().any(|x| x == "*" || x == "email")) {
        return Some("key not for email");
    }
    let flags = list("t").unwrap_or_default();
    if flags.iter().any(|f| f == "y") {
        return Some("key in testing mode: no better than unsigned"); // RFC 6376, 3.6.1
    }
    if flags.iter().any(|f| f == "s") && i_domain != d {
        return Some("t=s: i= has to be exactly d=");
    }
    None
}

fn verify_sig(kind: Kind, der: &[u8], data: &[u8], sig: &[u8]) -> Result<bool, &'static str> {
    match kind {
        Kind::Ed25519 => {
            let k: [u8; 32] = der.try_into().map_err(|_| "no usable key")?;
            let key = ed25519_dalek::VerifyingKey::from_bytes(&k).map_err(|_| "no usable key")?;
            let s = ed25519_dalek::Signature::from_slice(sig).map_err(|_| "signature mismatch")?;
            Ok(key.verify_strict(&Sha256::digest(data), &s).is_ok())
        }
        Kind::Rsa => {
            use rsa::pkcs1::DecodeRsaPublicKey as _;
            use rsa::pkcs8::DecodePublicKey as _;
            use rsa::signature::Verifier as _;
            use rsa::traits::PublicKeyParts as _;
            let key = rsa::RsaPublicKey::from_public_key_der(der)
                .or_else(|_| rsa::RsaPublicKey::from_pkcs1_der(der))
                .map_err(|_| "no usable key")?;
            if key.size() * 8 < RSA_MIN_BITS {
                return Err("RSA key under 1024 bits");
            }
            let s = rsa::pkcs1v15::Signature::try_from(sig).map_err(|_| "signature mismatch")?;
            Ok(rsa::pkcs1v15::VerifyingKey::<Sha256>::new(key).verify(data, &s).is_ok())
        }
    }
}

/// One signature: why it fails, or "". What costs nothing comes first, and the DNS lookup last of all.
#[allow(
    clippy::too_many_lines,
    clippy::many_single_char_names,
    reason = "RFC 6376's checks in its order, its tags by their names (d=, c=, i=, x=, b=)"
)]
async fn problem(
    field: &Field,
    fields: &[Field],
    body: &str,
    tags: Option<&HashMap<String, String>>,
    d: &str,
    txt: &Txt,
    now_s: i64,
) -> (String, bool) {
    let say = |s: &str| (s.to_owned(), false);
    let Some(tags) = tags else { return say("bad tag list") };
    for t in ["a", "b", "bh", "d", "h", "s"] {
        if tags.get(t).is_none_or(String::is_empty) {
            return say(&format!("missing tag {t}="));
        }
    }
    if tags.get("v").map(String::as_str) != Some("1") {
        return say("v= is not 1");
    }
    let kind = match tags["a"].as_str() {
        "rsa-sha256" => Kind::Rsa,
        "ed25519-sha256" => Kind::Ed25519,
        a => return say(&format!("algorithm {a} refused")),
    };
    if tags.contains_key("l") {
        return say("l= leaves part of the body unsigned");
    }
    let c = tags.get("c").map_or("simple", String::as_str);
    let (head_how, body_how) = c.split_once('/').unwrap_or((c, "simple"));
    if !matches!(head_how, "simple" | "relaxed") || !matches!(body_how, "simple" | "relaxed") {
        return say("unknown canonicalization");
    }
    if tags.get("q").is_some_and(|q| !q.split(':').any(|x| x.trim() == "dns/txt")) {
        return say("q= is not dns/txt");
    }
    let names: Vec<String> = tags["h"].split(':').map(|n| n.trim().to_lowercase()).collect();
    if let Some(m) = MUST_SIGN.iter().find(|m| !names.iter().any(|n| n == *m)) {
        return say(&format!("{m} is not in h="));
    }
    let selector = tags["s"].to_lowercase();
    let domain_ok = d.len() <= 253 && d.split('.').count() >= 2 && d.split('.').all(label_ok);
    if !domain_ok || !selector.split('.').all(label_ok) {
        return say("bad d= or s=");
    }
    let i = tags.get("i").cloned().unwrap_or_else(|| format!("@{d}"));
    let i_domain = i.rsplit_once('@').map(|(_, x)| x.to_lowercase()).unwrap_or_default();
    if !i.contains('@') || !(i_domain == d || i_domain.ends_with(&format!(".{d}"))) {
        return say("i= is outside d=");
    }
    if let Some(x) = tags.get("x") {
        let Ok(xs) = x.parse::<i64>() else { return say("bad x=") };
        if tags.get("t").and_then(|t| t.parse::<i64>().ok()).is_some_and(|t| xs < t) {
            return say("bad x=");
        }
        if now_s > xs {
            return say("expired");
        }
    }
    let (Some(bh), Some(b)) = (b64(&no_ws(&tags["bh"])), b64(&no_ws(&tags["b"]))) else { return say("bad base64") };
    let canon_body = if body_how == "relaxed" { relaxed_body(body) } else { simple_body(body) };
    if Sha256::digest(bytes(&canon_body)).as_slice() != bh.as_slice() {
        return say("body hash mismatch");
    }
    let records = match txt(format!("{selector}._domainkey.{d}")).await {
        Ok(r) => r,
        Err(Lookup::NoSuchKey) => return say("no such key"),
        Err(Lookup::Failed) => return (DNS_FAILED.to_owned(), true),
    };
    let [record] = records.as_slice() else { return say("no usable key") };
    let Some(rec) = tag_list(&record.concat()) else { return say("no usable key") };
    if let Some(w) = key_problem(&rec, kind, d, &i_domain) {
        return say(w);
    }
    let p = no_ws(&rec["p"]);
    if p.is_empty() {
        return say("key revoked");
    }
    let Some(der) = b64(&p) else { return say("no usable key") };
    // each name in h= takes the lowest instance left of it; a name with none left adds nothing
    let mut left: HashMap<&str, Vec<&Field>> = HashMap::new();
    for f in fields.iter().filter(|f| *f != field) {
        left.entry(f.name.as_str()).or_default().push(f);
    }
    let canon = |raw: &str| if head_how == "relaxed" { relaxed_field(raw) } else { raw.to_owned() };
    let mut data = String::new();
    for name in &names {
        if let Some(f) = left.get_mut(name.as_str()).and_then(Vec::pop) {
            data.push_str(&canon(&f.raw));
            data.push_str(CRLF);
        }
    }
    data.push_str(&canon(&without_b(&field.raw)));
    match verify_sig(kind, &der, &bytes(&data), &b) {
        Ok(true) => (String::new(), false),
        Ok(false) => say("signature mismatch"),
        Err(e) => say(e),
    }
}

/// `raw`: the message's bytes. One `Checked` per signature tried, from the top: none for a message with none, or
/// whose headers can't be read one way. Lookups run together.
pub async fn verify(raw: &[u8], txt: &Txt, now_s: i64) -> Vec<Checked> {
    let Some((fields, body)) = header_fields(&latin1(raw)) else { return Vec::new() };
    let sigs: Vec<&Field> = fields.iter().filter(|f| f.name == "dkim-signature").take(SIGNATURES_MAX).collect();
    let checks = sigs.into_iter().map(|field| {
        let (fields, body) = (&fields, &body);
        async move {
            let tags = tag_list(&field.raw[field.raw.find(':').map_or(0, |i| i + 1)..]);
            let d = tags.as_ref().and_then(|t| t.get("d")).map(|d| d.to_lowercase()).unwrap_or_default();
            let (why, dns) = problem(field, fields, body, tags.as_ref(), &d, txt, now_s).await;
            Checked { ok: why.is_empty(), d, why, dns }
        }
    });
    futures::future::join_all(checks).await
}

#[cfg(test)]
#[path = "dkim/tests.rs"]
pub(crate) mod tests;
