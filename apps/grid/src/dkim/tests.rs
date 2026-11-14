//! v1 test/dkim.test.js: a message signed here and checked against the key in (fake) DNS.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::sync::Arc;

use ed25519_dalek::Signer as _;

use super::*;

const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

pub(crate) fn ed_key() -> ed25519_dalek::SigningKey {
    ed25519_dalek::SigningKey::from_bytes(&[7u8; 32])
}

/// A message signed relaxed/relaxed by `d`, with the header fields `h` lists (the last `h` instance of each).
pub(crate) fn signed(d: &str, head: &str, body: &str, h: &str, extra: &str) -> String {
    let bh = B64.encode(Sha256::digest(bytes(&relaxed_body(body))));
    let sig_field = format!("DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed; d={d}; s=sel; h={h};{extra} bh={bh}; b=");
    let (fields, _) = header_fields(&format!("{head}\r\n\r\n")).unwrap();
    let mut data = String::new();
    let mut left: HashMap<&str, Vec<&Field>> = HashMap::new();
    for f in &fields {
        left.entry(f.name.as_str()).or_default().push(f);
    }
    for name in h.split(':') {
        if let Some(f) = left.get_mut(name).and_then(Vec::pop) {
            data.push_str(&relaxed_field(&f.raw));
            data.push_str(CRLF);
        }
    }
    data.push_str(&relaxed_field(&sig_field));
    let sig = ed_key().sign(&Sha256::digest(bytes(&data)));
    format!("{sig_field}{}\r\n{head}\r\n\r\n{body}", B64.encode(sig.to_bytes()))
}

fn dns(record: Option<String>) -> Arc<Txt> {
    Arc::new(move |name: String| {
        let r = record.clone();
        Box::pin(async move {
            match (name.as_str(), r) {
                ("down._domainkey.example.com", _) => Err(Lookup::Failed),
                ("sel._domainkey.example.com", Some(r)) => Ok(vec![vec![r]]),
                _ => Err(Lookup::NoSuchKey),
            }
        })
    })
}

pub(crate) fn key_record() -> String {
    format!("v=DKIM1; k=ed25519; p={}", B64.encode(ed_key().verifying_key().to_bytes()))
}

const HEAD: &str = "From: Ada <ada@example.com>\r\nSubject: fix the  login\r\nDate: Tue, 2 Jan 2024 03:04:05 +0000";

#[tokio::test]
async fn a_message_signed_by_its_domain_is_proved_and_any_change_is_not() {
    let raw = signed("example.com", HEAD, "it 500s \r\n\r\n", "from:subject:date", "");
    let txt = dns(Some(key_record()));
    let ok = verify(raw.as_bytes(), txt.as_ref(), 1_704_164_645).await;
    assert_eq!(ok, vec![Checked { d: "example.com".into(), ok: true, why: String::new(), dns: false }]);
    let body_changed = raw.replace("it 500s", "it 501s");
    assert_eq!(verify(body_changed.as_bytes(), txt.as_ref(), 0).await[0].why, "body hash mismatch");
    let subject_changed = raw.replace("fix the  login", "delete it all");
    assert_eq!(verify(subject_changed.as_bytes(), txt.as_ref(), 0).await[0].why, "signature mismatch");
    // a second Subject added above the signed one: the signature covers the lowest, and still holds; who reads
    // the message refuses two (mail.rs); here it proves only what was signed
    let none = verify(raw.as_bytes(), dns(None).as_ref(), 0).await;
    assert_eq!((none[0].why.as_str(), none[0].dns), ("no such key", false), "no such key is an answer");
    let down = signed("example.com", HEAD, "x\r\n", "from:subject:date", "").replace("s=sel", "s=down");
    let d = verify(down.as_bytes(), txt.as_ref(), 0).await;
    assert_eq!((d[0].ok, d[0].dns), (false, true), "DNS not answering: a later try may differ");
}

#[tokio::test]
async fn what_leaves_doubt_is_refused() {
    let txt = dns(Some(key_record()));
    let why = |raw: String| {
        let txt = txt.clone();
        async move { verify(raw.as_bytes(), txt.as_ref(), 1_704_164_645).await.first().map(|c| c.why.clone()).unwrap_or_default() }
    };
    assert_eq!(why(signed("example.com", HEAD, "x\r\n", "from:date", "")).await, "subject is not in h=");
    assert_eq!(why(signed("example.com", HEAD, "x\r\n", "from:subject:date", " l=1;")).await, "l= leaves part of the body unsigned");
    assert_eq!(why(signed("example.com", HEAD, "x\r\n", "from:subject:date", " x=10;")).await, "expired");
    assert_eq!(why(signed("example.com", HEAD, "x\r\n", "from:subject:date", " i=@other.com;")).await, "i= is outside d=");
    let testing = dns(Some(format!("{}; t=y", key_record())));
    let raw = signed("example.com", HEAD, "x\r\n", "from:subject:date", "");
    assert!(verify(raw.as_bytes(), testing.as_ref(), 0).await[0].why.contains("testing mode"));
    let rsa_only = dns(Some(key_record().replace("k=ed25519", "k=rsa")));
    assert_eq!(verify(raw.as_bytes(), rsa_only.as_ref(), 0).await[0].why, "key of another type");
    assert_eq!(why(raw.replacen("a=ed25519-sha256", "a=rsa-sha1", 1)).await, "algorithm rsa-sha1 refused");
    // headers another parser could read another way: unprovable, so no signature is even tried
    assert!(verify(raw.replacen("\r\nSubject", "\nSubject", 1).as_bytes(), txt.as_ref(), 0).await.is_empty(), "a bare LF");
    assert_eq!(verify(b"From: a@b.c\r\nno end", txt.as_ref(), 0).await, Vec::new(), "no end to the headers");
    assert_eq!(tag_list("a=1; a=2"), None, "a tag twice voids the list");
}

#[tokio::test]
async fn an_rsa_signature_is_checked_too() {
    use rsa::pkcs8::EncodePublicKey as _;
    use rsa::signature::{SignatureEncoding as _, Signer as _};
    let key = rsa::RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 1024).unwrap();
    let der = key.to_public_key().to_public_key_der().unwrap();
    let bh = B64.encode(Sha256::digest(bytes(&relaxed_body("hi\r\n"))));
    let sig_field = format!("DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=sel; h=from:subject:date; bh={bh}; b=");
    let (fields, _) = header_fields(&format!("{HEAD}\r\n\r\n")).unwrap();
    let mut data = String::new();
    for f in &fields {
        data.push_str(&relaxed_field(&f.raw));
        data.push_str(CRLF);
    }
    data.push_str(&relaxed_field(&sig_field));
    let sig = rsa::pkcs1v15::SigningKey::<Sha256>::new(key).sign(&bytes(&data));
    let raw = format!("{sig_field}{}\r\n{HEAD}\r\n\r\nhi\r\n", B64.encode(sig.to_bytes()));
    let txt = dns(Some(format!("v=DKIM1; p={}", B64.encode(der.as_bytes()))));
    assert!(verify(raw.as_bytes(), txt.as_ref(), 0).await[0].ok);
}
