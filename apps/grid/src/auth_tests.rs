//! Sign-in with a provider (v1 grid/test/auth.test.js's intent): PKCE and state, GitHub's identity, ID-token checks,
//! and who signs in as whom.
#![allow(clippy::unwrap_used, clippy::panic, clippy::many_single_char_names, clippy::unreadable_literal, clippy::needless_pass_by_value)]

use std::sync::{Arc, Mutex};

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use serde_json::{Value, json};

use super::*;
use crate::accounts::{Accounts, allowed};
use crate::clock::ManualClock;
use crate::db::Db;

/// A test-only RSA key (2048 bits), as its numbers.
const N: &str = "\
    cda108a9b580f5cd121e25765ffc6b998523fb1f5b91625c953e645669cf1a711c8beef47e9bf093f37bcbe323445f233de2\
    ea930ae1377de227701d02cdd2382adb549a3486e33f7d51e57ca36b8e5317b0e2d5c7459218cd4b620647acaa87dc01f1ae\
    712161b646fc6ab80e08d4edd0c14951dc182b7e33886627cb2cefbec3a3b0efa4c9df928fd955a46befbf385d1fa2cd00f3\
    99e60060170ea57929df414d9d0c43e445f1abe841d61d9033c8a48bb814038eb1d49eb62e2ffcf10067f29484cc23873429\
    541c3a691b69df67e68d136fc121aa8ba4977048fbffbc37c5f4d5d48b8ecd7d60203e7f68a050a08c5d144ce52a319f46e3\
    b501d6aa9cd1";
const D: &str = "\
    018cfe99fb0cb12dddfe5cb577155a016323e993abb6ddb94985da2f5da66a72626efabb1cce53c2e5e1efe07366635a4a6f\
    f0e9717a4fd712f2cdb16651438dd962e4913226b745860e2d4f22935fd4281855299c125dfef2636866983948e2f3e98ed7\
    4c329e8047aa452ac4ae53dec44584e64964e4451421e9f5505eb32327741f4a085ddae1ac20f344150c6c8139d53628be55\
    199d1d3b8f092f54244354cf48015da5b0f178663653226c7c89386e7827a936552b4f2baa354e773dfc125e3fe2903f85a9\
    59f70823eff45df38a48ddcd92fd3af20e14eb16c39e9923fc0db4e85973c0babde957c6a413a146ef85748bcc4c55c543cf\
    1c07365a5401";
const P: &str = "\
    e6740fc5561a8df0ce34869d68a21c44c4354255d3fc838f5d0c9abd55dc1068e725807e4b4c6f04370d2b6a4376ab7afef5\
    dad2d6cbfc5ae7a40cff7fc738809414a5b290146cab3e03ecf56d6c7bd1a20ec9449f5c2c1842f8bf9a5f30b3c82d08fe3a\
    6e351c69b2ed49247fe40ceb614f4d7fe8b67ad6172fe94714ac8bd1";
const Q: &str = "\
    e46c7e40a0d6d0633536cc296c71fecfaef608f444398b06d2a12b63e5e9310b18f7218749c0d73b7d91088411331007bd50\
    27838ac5e0c7e14c341c11a97b9a02c8c5aff92eb6fbc135e6a74bf03ad892c0cd3e03f5f4ea3cfcffd5bd61bd28ecdc52d8\
    bb03e036b1f23f0af60fdc57649a7f0fe218c6eb96d73b0d901e4101";

fn rsa_key() -> rsa::RsaPrivateKey {
    let big = |h: &str| rsa::BigUint::parse_bytes(h.as_bytes(), 16).unwrap();
    rsa::RsaPrivateKey::from_components(big(N), big("10001"), big(D), vec![big(P), big(Q)]).unwrap()
}

fn rsa_jwks(kid: &str) -> Value {
    use rsa::traits::PublicKeyParts as _;
    let k = rsa_key().to_public_key();
    json!({ "keys": [{ "kty": "RSA", "kid": kid, "alg": "RS256", "n": B64URL.encode(k.n().to_bytes_be()), "e": B64URL.encode(k.e().to_bytes_be()) }] })
}

fn rs256_token(kid: &str, claims: &Value) -> String {
    use rsa::signature::{SignatureEncoding as _, Signer as _};
    let h = B64URL.encode(json!({ "alg": "RS256", "kid": kid, "typ": "JWT" }).to_string());
    let p = B64URL.encode(claims.to_string());
    let sig = rsa::pkcs1v15::SigningKey::<Sha256>::new(rsa_key()).sign(format!("{h}.{p}").as_bytes());
    format!("{h}.{p}.{}", B64URL.encode(sig.to_bytes()))
}

fn es_key() -> p256::ecdsa::SigningKey {
    p256::ecdsa::SigningKey::from_bytes(&[7u8; 32].into()).unwrap()
}

fn es256_token(claims: &Value) -> (String, Value) {
    use p256::ecdsa::signature::Signer as _;
    let k = es_key();
    let pt = k.verifying_key().to_encoded_point(false);
    let jwks = json!({ "keys": [{ "kty": "EC", "kid": "e1", "crv": "P-256", "x": B64URL.encode(pt.x().unwrap()), "y": B64URL.encode(pt.y().unwrap()) }] });
    let h = B64URL.encode(json!({ "alg": "ES256", "kid": "e1" }).to_string());
    let p = B64URL.encode(claims.to_string());
    let sig: p256::ecdsa::Signature = k.sign(format!("{h}.{p}").as_bytes());
    (format!("{h}.{p}.{}", B64URL.encode(sig.to_bytes())), jwks)
}

const NOW: i64 = 1_800_000_000_000;

fn claims() -> Value {
    json!({ "iss": "https://accounts.google.com", "aud": "client-1", "sub": "1093", "nonce": "n-1", "exp": NOW / 1000 + 600, "iat": NOW / 1000, "email": "Ada@Example.com", "email_verified": true, "name": "Ada" })
}

fn iss() -> Vec<String> {
    vec!["https://accounts.google.com".into()]
}

#[test]
fn pkce_s256_matches_rfc_7636() {
    // RFC 7636 appendix B
    assert_eq!(challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
}

#[test]
fn state_binds_the_callback_to_its_browser_once() {
    let flows = Flows::default();
    let f = flows.begin("github", "/account", None, NOW);
    assert!(f.verifier.len() >= 43, "a PKCE verifier is 43+ characters");
    assert!(flows.finish("github", &f.state, "another-browser", NOW).is_err(), "a callback without this browser's cookie");
    assert!(flows.finish("github", &f.state, "", NOW).is_err());
    assert!(flows.finish("google", &f.state, &f.state, NOW).is_err(), "another provider's callback");
    let f = flows.begin("github", "/", None, NOW);
    assert_eq!(flows.finish("github", &f.state, &f.state, NOW + 1_000).unwrap().ret, "/");
    assert!(flows.finish("github", &f.state, &f.state, NOW + 2_000).is_err(), "used once");
    let f = flows.begin("github", "/", None, NOW);
    assert!(flows.finish("github", &f.state, &f.state, NOW + FLOW_TTL_MS + 1).is_err(), "10 minutes at most");
}

#[test]
fn github_identity_is_the_numeric_id_and_a_verified_email() {
    let user = json!({ "id": 583231, "login": "Octocat", "name": "", "avatar_url": "https://a/x.png" });
    let emails = json!([{ "email": "fake@evil.com", "primary": true, "verified": false }, { "email": "Octo@GitHub.com", "primary": false, "verified": true }]);
    let i = github_identity(&user, &emails, Some(&json!([{ "login": "WispAgents" }]))).unwrap();
    assert_eq!(
        (i.subject.as_str(), i.login.as_str(), i.name.as_str()),
        ("583231", "Octocat", "Octocat"),
        "the id, never the login; the login when there's no name"
    );
    assert_eq!((i.email.as_str(), i.email_verified), ("octo@github.com", true), "an unverified primary is never taken");
    assert_eq!(i.orgs, Some(vec!["wispagents".to_owned()]));
    let none = github_identity(&user, &json!([{ "email": "a@b.c", "verified": false }]), None).unwrap();
    assert_eq!((none.email.as_str(), none.email_verified, none.orgs), ("", false, None));
    assert!(github_identity(&json!({ "login": "x" }), &json!([]), None).is_err(), "no id: who is it?");
}

#[test]
fn id_token_signature_issuer_audience_nonce_and_expiry_are_checked() {
    let jwks = rsa_jwks("k1");
    let ok = verify_id_token(&rs256_token("k1", &claims()), &jwks, &iss(), "client-1", "n-1", NOW).unwrap();
    assert_eq!(ok["sub"], "1093");
    let (es, es_jwks) = es256_token(&claims());
    assert_eq!(verify_id_token(&es, &es_jwks, &iss(), "client-1", "n-1", NOW).unwrap()["sub"], "1093", "ES256 too");
    let refused = |t: &str, why: &str| {
        let e = verify_id_token(t, &jwks, &iss(), "client-1", "n-1", NOW).unwrap_err().to_string();
        assert!(e.contains(why), "{why}: {e}");
    };
    // a token whose claims were changed after signing
    let good = rs256_token("k1", &claims());
    let mut parts: Vec<String> = good.split('.').map(str::to_owned).collect();
    let mut forged = claims();
    forged["sub"] = json!("admin");
    parts[1] = B64URL.encode(forged.to_string());
    refused(&parts.join("."), "signature");
    let with = |k: &str, v: Value| {
        let mut c = claims();
        c[k] = v;
        rs256_token("k1", &c)
    };
    refused(&with("iss", json!("https://evil.example")), "issuer");
    refused(&with("aud", json!("someone-else")), "another app");
    refused(&with("nonce", json!("replayed")), "nonce");
    refused(&with("exp", json!(NOW / 1000 - 3600)), "expired");
    refused(&rs256_token("k9", &claims()), "key");
    let none = format!("{}.{}.", B64URL.encode(r#"{"alg":"none"}"#), B64URL.encode(claims().to_string()));
    refused(&none, "none");
    // an audience list naming it is fine
    verify_id_token(&with("aud", json!(["x", "client-1"])), &jwks, &iss(), "client-1", "n-1", NOW).unwrap();
}

/// A fake GitHub: answers by URL, and keeps what was asked.
#[derive(Default)]
struct FakeHttp {
    asked: Mutex<Vec<(String, String, Option<String>)>>,
    answers: Vec<(&'static str, u16, Value)>,
}

impl AuthHttp for FakeHttp {
    fn call(
        &self,
        method: &str,
        url: &str,
        _h: Vec<(String, String)>,
        body: Option<(String, Vec<u8>)>,
    ) -> futures::future::BoxFuture<'static, std::result::Result<(u16, Vec<u8>), String>> {
        self.asked.lock().unwrap().push((method.to_owned(), url.to_owned(), body.map(|(_, b)| String::from_utf8_lossy(&b).into_owned())));
        let a = self.answers.iter().find(|(u, _, _)| url.ends_with(u)).map(|(_, s, v)| (*s, v.to_string().into_bytes()));
        Box::pin(async move { a.ok_or_else(|| "no route".to_owned()) })
    }
}

#[tokio::test]
async fn github_sign_in_sends_state_and_pkce_and_reads_the_user() {
    let p = Provider {
        id: "github".into(),
        label: "GitHub".into(),
        client_id: "cid".into(),
        client_secret: "sec".into(),
        kind: Kind::Github { auth_base: "https://gh.test".into(), api_base: "https://api.gh.test".into(), want_orgs: false },
    };
    let http = FakeHttp {
        answers: vec![
            ("/login/oauth/access_token", 200, json!({ "access_token": "gho_1" })),
            ("/user", 200, json!({ "id": 9, "login": "ada" })),
            ("/user/emails", 200, json!([{ "email": "ada@x.io", "primary": true, "verified": true }])),
        ],
        ..FakeHttp::default()
    };
    let flows = Flows::default();
    let f = flows.begin("github", "/", None, NOW);
    let to = p.start(&http, "https://grid.test/auth/github/callback", &f).await.unwrap();
    let u = url::Url::parse(&to).unwrap();
    let q: std::collections::HashMap<String, String> = u.query_pairs().into_owned().collect();
    assert_eq!((q["state"].as_str(), q["code_challenge_method"].as_str()), (f.state.as_str(), "S256"));
    assert_eq!(q["code_challenge"], challenge(&f.verifier));
    assert_eq!(q["scope"], "read:user user:email", "no org scope unless an allow list names orgs");
    let i = p.finish(&http, "the-code", "https://grid.test/auth/github/callback", &f, NOW).await.unwrap();
    assert_eq!((i.subject.as_str(), i.email.as_str()), ("9", "ada@x.io"));
    let token_call = http.asked.lock().unwrap().iter().find(|(_, u, _)| u.ends_with("/access_token")).cloned().unwrap();
    assert!(token_call.2.as_deref().unwrap().contains(&f.verifier), "the verifier goes with the code");
    // a GitHub that refuses the code says why
    let bad_code = FakeHttp {
        answers: vec![(
            "/login/oauth/access_token",
            200,
            json!({ "error": "bad_verification_code", "error_description": "The code passed is incorrect or expired." }),
        )],
        ..FakeHttp::default()
    };
    let e = p.finish(&bad_code, "old", "x", &f, NOW).await.unwrap_err().to_string();
    assert!(e.contains("incorrect or expired"), "{e}");
}

fn auth_cfg(extra: Value) -> crate::config::AuthConfig {
    let mut v = json!({ "dev": false, "providers": {}, "signup": "open", "allow": {}, "admins": [], "seats": { "min": 1, "cap": 1, "target": 0.5, "everyHours": 1, "holdDays": 0 } });
    if let (Some(o), Some(e)) = (v.as_object_mut(), extra.as_object()) {
        o.extend(e.clone());
    }
    serde_json::from_value(v).unwrap()
}

fn idn(provider: &str, subject: &str, email: &str, login: &str) -> Identity {
    Identity {
        provider: provider.into(),
        subject: subject.into(),
        email: email.into(),
        email_verified: true,
        name: login.into(),
        login: login.into(),
        ..Identity::default()
    }
}

fn accounts() -> Accounts {
    Accounts { db: Arc::new(Db::memory().unwrap()), clock: ManualClock::new(NOW) }
}

#[test]
fn sign_in_never_links_by_email() {
    let a = accounts();
    let cfg = auth_cfg(json!({}));
    let ada = a.sign_in(&cfg, &idn("github", "1", "ada@x.io", "ada"), None).unwrap();
    assert_eq!(a.sign_in(&cfg, &idn("github", "1", "ada@x.io", "ada"), None).unwrap().id, ada.id, "the same identity: the same user");
    // someone at another provider claiming the same address is someone else
    let other = a.sign_in(&cfg, &idn("oidc:corp", "zz", "ada@x.io", "ada"), None).unwrap();
    assert_ne!(other.id, ada.id);
    assert_eq!(other.handle, "ada-2", "a handle that's taken gets a number");
}

#[test]
fn allow_lists_by_account_verified_email_domain_and_org() {
    let cfg = auth_cfg(
        json!({ "allow": { "emails": ["Bo@x.io"], "domains": ["@corp.com"], "githubOrgs": ["WispAgents"], "accounts": ["github:octocat"] } }),
    );
    assert!(allowed(&cfg, &idn("github", "5", "", "octocat")), "by login");
    assert!(allowed(&cfg, &idn("github", "5", "bo@x.io", "bo")));
    assert!(allowed(&cfg, &idn("google", "7", "cy@corp.com", "")));
    assert!(
        !allowed(&cfg, &Identity { email_verified: false, ..idn("google", "7", "cy@corp.com", "") }),
        "an unverified email counts for nothing"
    );
    assert!(allowed(&cfg, &Identity { orgs: Some(vec!["wispagents".into()]), ..idn("github", "8", "", "dee") }));
    assert!(!allowed(&cfg, &idn("github", "9", "eve@evil.com", "eve")));
    let a = accounts();
    let e = a.sign_in(&cfg, &idn("github", "9", "eve@evil.com", "eve"), None).unwrap_err().to_string();
    assert!(e.contains("invited"), "{e}");
    assert!(allowed(&auth_cfg(json!({})), &idn("github", "9", "", "eve")), "no list: everyone");
}

#[test]
fn closed_signup_lets_existing_users_in_and_refuses_new_ones() {
    let a = accounts();
    let ada = a.sign_in(&auth_cfg(json!({})), &idn("github", "1", "", "ada"), None).unwrap();
    let closed = auth_cfg(json!({ "signup": "closed" }));
    assert_eq!(a.sign_in(&closed, &idn("github", "1", "", "ada"), None).unwrap().id, ada.id);
    assert!(a.sign_in(&closed, &idn("github", "2", "", "bo"), None).unwrap_err().to_string().contains("closed"));
    a.db.with(|c| c.execute("UPDATE users SET disabled = 1 WHERE id = ?1", [&ada.id])).unwrap();
    assert!(a.sign_in(&closed, &idn("github", "1", "", "ada"), None).unwrap_err().to_string().contains("turned off"));
}

#[test]
fn linking_someone_elses_identity_is_refused() {
    let a = accounts();
    let cfg = auth_cfg(json!({}));
    let ada = a.sign_in(&cfg, &idn("github", "1", "", "ada"), None).unwrap();
    let bo = a.sign_in(&cfg, &idn("github", "2", "", "bo"), None).unwrap();
    assert_eq!(a.sign_in(&cfg, &idn("google", "g1", "", ""), Some(&ada.id)).unwrap().id, ada.id, "a second way in for ada");
    assert_eq!(a.sign_in(&cfg, &idn("google", "g1", "", ""), None).unwrap().id, ada.id, "which then signs her in");
    let e = a.sign_in(&cfg, &idn("github", "2", "", "bo"), Some(&ada.id)).unwrap_err().to_string();
    assert!(e.contains("another user"), "{e}");
    assert_ne!(bo.id, ada.id);
}

#[test]
fn handles_are_unique_and_never_reserved() {
    let a = accounts();
    let cfg = auth_cfg(json!({}));
    assert_eq!(a.sign_in(&cfg, &idn("github", "1", "", "Ada Lovelace!!"), None).unwrap().handle, "ada-lovelace");
    let admin = a.sign_in(&cfg, &idn("github", "2", "", "admin"), None).unwrap().handle;
    assert!(admin.starts_with("admin-") && admin != "admin", "{admin}");
    let short = a.sign_in(&cfg, &idn("github", "3", "", "x"), None).unwrap().handle;
    assert!(short.starts_with("x-") && short.len() == 6, "{short}");
    let by_email = a.sign_in(&cfg, &idn("google", "4", "grace.hopper@navy.mil", ""), None).unwrap().handle;
    assert_eq!(by_email, "grace-hopper");
}
