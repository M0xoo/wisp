//! SES over SNS (v1 grid/mail.js `sesInbound`, `sesSender`). Trust comes from AWS's key (fetched from
//! `sns.<region>.amazonaws.com`, or pinned in grid.json `inbound.keys`) and from the topic: anyone can get SNS to
//! sign for their own topic, so a signature proves nothing until `TopicArn` is ours. Nothing is compared to a
//! shared secret. Sending: SES's v2 API, raw, signed by hand (`SigV4`), no SDK.

use base64::Engine as _;
use hmac::{Hmac, Mac as _};
use serde_json::{Value, json};
use sha2::{Digest as _, Sha256};

/// SNS's own retries are over in seconds.
pub const SIGNED_MAX_AGE_MS: i64 = 15 * 60_000;

/// What SNS brought.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inbound {
    /// a subscription to confirm (a GET of this URL)
    Confirm(String),
    Mail {
        recipients: Vec<String>,
        /// 'unproved' (SES didn't refuse it: still to be proved by DKIM here), or why not
        verdict: String,
        /// the envelope's sender ('<>' for a bounce)
        source: String,
        content: Vec<u8>,
        /// these are its bytes as sent (BASE64): only then can a signature over them be checked
        exact: bool,
        /// who SES read as its From, if it says
        named: Option<Vec<String>>,
    },
}

/// SES's verdict in one word, and it's never 'pass': SES can refuse a message, not prove one (GRAY for a domain
/// with no policy; its DMARC PASS can rest on SPF, whose domain is the envelope's).
pub fn verdict(receipt: &Value) -> &'static str {
    match receipt["dmarcVerdict"]["status"].as_str() {
        Some("PASS" | "GRAY") => "unproved",
        Some("FAIL") => "fail",
        Some(_) => "failed",
        None => "none",
    }
}

/// A URL on SNS in this region, https, nothing else in it.
pub fn on_sns(url: &str, region: &str) -> Option<url::Url> {
    let u = url::Url::parse(url).ok()?;
    let ok = u.scheme() == "https"
        && u.host_str() == Some(&format!("sns.{region}.amazonaws.com"))
        && u.port().is_none()
        && u.username().is_empty()
        && u.password().is_none();
    ok.then_some(u)
}

fn iso_ms(iso: &str) -> Option<i64> {
    crate::mail::iso_ms(iso)
}

/// What a signature covers, and where its key is: everything that costs nothing comes first, so a forged request
/// never gets as far as a fetch. None: not ours, too old, or not `SignatureVersion` 2.
pub fn signed_text(j: &Value, topic_arn: &str, now_ms: i64) -> Option<(String, String, Vec<u8>)> {
    let names: &[&str] = match j["Type"].as_str()? {
        "Notification" => &["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"],
        "SubscriptionConfirmation" => &["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"],
        _ => return None,
    };
    if j["TopicArn"].as_str() != Some(topic_arn) || j["SignatureVersion"].as_str() != Some("2") {
        return None;
    }
    let sig = base64::engine::general_purpose::STANDARD.decode(j["Signature"].as_str()?).ok()?;
    if (now_ms - iso_ms(j["Timestamp"].as_str()?)?).abs() > SIGNED_MAX_AGE_MS {
        return None;
    }
    let region = topic_arn.split(':').nth(3)?;
    let cert = on_sns(j["SigningCertURL"].as_str()?, region)?;
    if !std::path::Path::new(cert.path()).extension().is_some_and(|e| e.eq_ignore_ascii_case("pem")) {
        return None;
    }
    let mut text = String::new();
    for n in names {
        if *n == "Subject" && j.get("Subject").is_none() {
            continue;
        }
        text.push_str(n);
        text.push('\n');
        text.push_str(j[*n].as_str()?);
        text.push('\n');
    }
    Some((cert.to_string(), text, sig))
}

/// An RSA public key from a PEM: a certificate (AWS's) or a bare public key (pinned).
pub fn key_of(pem: &str) -> Option<rsa::RsaPublicKey> {
    use rsa::pkcs8::DecodePublicKey as _;
    use x509_cert::der::{DecodePem as _, Encode as _};
    if let Ok(k) = rsa::RsaPublicKey::from_public_key_pem(pem) {
        return Some(k);
    }
    let cert = x509_cert::Certificate::from_pem(pem.as_bytes()).ok()?;
    let spki = cert.tbs_certificate.subject_public_key_info.to_der().ok()?;
    rsa::RsaPublicKey::from_public_key_der(&spki).ok()
}

pub fn verify(key: &rsa::RsaPublicKey, text: &str, sig: &[u8]) -> bool {
    use rsa::signature::Verifier as _;
    rsa::pkcs1v15::Signature::try_from(sig)
        .is_ok_and(|s| rsa::pkcs1v15::VerifyingKey::<Sha256>::new(key.clone()).verify(text.as_bytes(), &s).is_ok())
}

/// A verified notification, read. None: anything that isn't a received message sent to SNS whole.
pub fn read(j: &Value, region: &str) -> Option<Inbound> {
    if j["Type"] == "SubscriptionConfirmation" {
        let url = j["SubscribeURL"].as_str()?;
        return on_sns(url, region).map(|_| Inbound::Confirm(url.to_owned()));
    }
    let m: Value = serde_json::from_str(j["Message"].as_str()?).ok()?;
    let action = &m["receipt"]["action"];
    if m["notificationType"] != "Received" || action["type"] != "SNS" {
        return None;
    }
    let content = m["content"].as_str()?;
    let recipients: Vec<String> = m["receipt"]["recipients"].as_array()?.iter().filter_map(|r| r.as_str().map(str::to_owned)).collect();
    // UTF8 may have changed bytes a signature covers
    let exact = action["encoding"] == "BASE64";
    let content = if exact { base64::engine::general_purpose::STANDARD.decode(content).ok()? } else { content.as_bytes().to_vec() };
    Some(Inbound::Mail {
        recipients,
        verdict: verdict(&m["receipt"]).to_owned(),
        source: m["mail"]["source"].as_str().unwrap_or_default().to_owned(),
        content,
        exact,
        named: m["mail"]["commonHeaders"]["from"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_owned)).collect()),
    })
}

fn hex(b: &[u8]) -> String {
    b.iter().fold(String::new(), |mut s, x| {
        use std::fmt::Write as _;
        let _ = write!(s, "{x:02x}");
        s
    })
}

fn hmac(key: &[u8], s: &str) -> Vec<u8> {
    let Ok(mut m) = Hmac::<Sha256>::new_from_slice(key) else { return Vec::new() };
    m.update(s.as_bytes());
    m.finalize().into_bytes().to_vec()
}

/// Who signs for SES.
#[derive(Debug, Clone, Copy)]
pub struct Creds<'a> {
    pub region: &'a str,
    pub key_id: &'a str,
    pub secret: &'a str,
    pub endpoint: Option<&'a str>,
}

/// SES v2 `SendEmail` with a raw message: (url, body, headers), signed with `SigV4`. `stamp`: `YYYYMMDDTHHMMSSZ`.
pub fn send_request(c: Creds<'_>, from: &str, to: &str, raw: &str, stamp: &str) -> (String, String, Vec<(String, String)>) {
    let Creds { region, key_id, secret, endpoint } = c;
    let base = endpoint.map_or_else(|| format!("https://email.{region}.amazonaws.com"), |e| e.trim_end_matches('/').to_owned());
    let host = url::Url::parse(&base)
        .ok()
        .and_then(|u| u.host_str().map(|h| u.port().map_or_else(|| h.to_owned(), |p| format!("{h}:{p}"))))
        .unwrap_or_default();
    let path = "/v2/email/outbound-emails";
    let body = json!({ "FromEmailAddress": from, "Destination": { "ToAddresses": [to] }, "Content": { "Raw": { "Data": base64::engine::general_purpose::STANDARD.encode(raw) } } }).to_string();
    let day = &stamp[..8.min(stamp.len())];
    let scope = format!("{day}/{region}/ses/aws4_request");
    let signed = "content-type;host;x-amz-date";
    let canon = [
        "POST",
        path,
        "",
        "content-type:application/json",
        &format!("host:{host}"),
        &format!("x-amz-date:{stamp}"),
        "",
        signed,
        &hex(&Sha256::digest(body.as_bytes())),
    ]
    .join("\n");
    let key = [day, region, "ses", "aws4_request"].iter().fold(format!("AWS4{secret}").into_bytes(), |k, s| hmac(&k, s));
    let to_sign = ["AWS4-HMAC-SHA256", stamp, &scope, &hex(&Sha256::digest(canon.as_bytes()))].join("\n");
    let signature = hex(&hmac(&key, &to_sign));
    let auth = format!("AWS4-HMAC-SHA256 Credential={key_id}/{scope}, SignedHeaders={signed}, Signature={signature}");
    (
        format!("{base}{path}"),
        body,
        vec![("content-type".into(), "application/json".into()), ("x-amz-date".into(), stamp.to_owned()), ("authorization".into(), auth)],
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const ARN: &str = "arn:aws:sns:eu-west-1:123456789012:wisp-mail";

    fn note(message: &Value, ts: &str) -> Value {
        json!({ "Type": "Notification", "MessageId": "n1", "TopicArn": ARN, "Message": message.to_string(), "Timestamp": ts, "SignatureVersion": "2", "Signature": "", "SigningCertURL": "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-x.pem" })
    }

    /// v1 test/mail.test.js "SES": the topic is ours, it's fresh, the key's own; then what it carries.
    #[test]
    fn only_our_topic_signed_by_awss_key_and_fresh_is_read() {
        use rsa::pkcs8::EncodePublicKey as _;
        use rsa::signature::{SignatureEncoding as _, Signer as _};
        let key = rsa::RsaPrivateKey::new(&mut rsa::rand_core::OsRng, 1024).unwrap();
        let pem = key.to_public_key().to_public_key_pem(rsa::pkcs8::LineEnding::LF).unwrap();
        let pinned = key_of(&pem).unwrap();
        let msg = json!({ "notificationType": "Received", "receipt": { "action": { "type": "SNS", "encoding": "BASE64" }, "recipients": ["k@grid.dev"], "dmarcVerdict": { "status": "PASS" } }, "mail": { "source": "ada@x.io", "commonHeaders": { "from": ["Ada <ada@x.io>"] } }, "content": base64::engine::general_purpose::STANDARD.encode("From: ada@x.io\r\n\r\nhi") });
        let mut j = note(&msg, "2024-01-02T03:04:05.000Z");
        let now = crate::mail::iso_ms("2024-01-02T03:05:00Z").unwrap();
        let (_, text, _) = signed_text(
            &{
                let mut x = j.clone();
                x["Signature"] = json!("AA==");
                x
            },
            ARN,
            now,
        )
        .unwrap();
        let sig = rsa::pkcs1v15::SigningKey::<Sha256>::new(key).sign(text.as_bytes());
        j["Signature"] = json!(base64::engine::general_purpose::STANDARD.encode(sig.to_bytes()));
        let (cert, text, sig) = signed_text(&j, ARN, now).unwrap();
        assert!(cert.starts_with("https://sns.eu-west-1.amazonaws.com/"));
        assert!(verify(&pinned, &text, &sig));
        let Some(Inbound::Mail { recipients, verdict, content, exact, .. }) = read(&j, "eu-west-1") else { panic!() };
        assert_eq!(
            (recipients, verdict.as_str(), content, exact),
            (vec!["k@grid.dev".to_owned()], "unproved", b"From: ada@x.io\r\n\r\nhi".to_vec(), true)
        );
        let other = {
            let mut x = j.clone();
            x["TopicArn"] = json!("arn:aws:sns:eu-west-1:666:theirs");
            x
        };
        assert!(signed_text(&other, ARN, now).is_none(), "another topic: nothing, not even a fetch");
        assert!(signed_text(&j, ARN, now + 16 * 60_000).is_none(), "too old");
        let elsewhere = {
            let mut x = j.clone();
            x["SigningCertURL"] = json!("https://evil.example/x.pem");
            x
        };
        assert!(signed_text(&elsewhere, ARN, now).is_none(), "a key from anywhere but SNS");
        let changed = text.replace("n1", "n2");
        assert!(!verify(&pinned, &changed, &sig));
        assert_eq!((verdict_of("FAIL"), verdict_of("GRAY"), verdict_of("X")), ("fail", "unproved", "failed"));
    }

    fn verdict_of(s: &str) -> &'static str {
        verdict(&json!({ "dmarcVerdict": { "status": s } }))
    }

    /// `SigV4` as AWS documents it: the credential scope, the signed headers, a 64-hex signature, deterministic.
    #[test]
    fn a_reply_goes_to_ses_signed_and_raw() {
        let (url, body, h) = send_request(
            Creds { region: "eu-west-1", key_id: "AKID", secret: "SECRET", endpoint: None },
            "k@grid.dev",
            "ada@x.io",
            "From: k@grid.dev\r\n\r\nhi",
            "20240102T030405Z",
        );
        assert_eq!(url, "https://email.eu-west-1.amazonaws.com/v2/email/outbound-emails");
        let b: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(b["Destination"]["ToAddresses"], json!(["ada@x.io"]));
        let auth = &h.iter().find(|(k, _)| k == "authorization").unwrap().1;
        assert!(auth.starts_with(
            "AWS4-HMAC-SHA256 Credential=AKID/20240102/eu-west-1/ses/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature="
        ));
        assert_eq!(auth.rsplit('=').next().unwrap().len(), 64);
        let (_, _, again) = send_request(
            Creds { region: "eu-west-1", key_id: "AKID", secret: "SECRET", endpoint: None },
            "k@grid.dev",
            "ada@x.io",
            "From: k@grid.dev\r\n\r\nhi",
            "20240102T030405Z",
        );
        assert_eq!(h, again, "deterministic for the same stamp");
    }
}
