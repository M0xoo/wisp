//! wisp.share host (ADR-0027 "Sharing in practice"): a task as a `.wisp-task` bundle.
//!
//! - `share.preview {id, level}`: exactly what would go (the spec, the formula snapshot, and for `report`
//!   the answers and the files changed, for `full` every turn with its steps), after the scrub
//!   (wisp-share-core: secrets, the sharer's secret env values, private paths, other tasks' titles and crew
//!   names), with every redaction listed.
//! - `share.bundle`: the same, signed with this wisp's ed25519 key (made once, kept in secrets).
//! - `share.open {bundle}`: checks the signature against the key it carries, says who signed it and what
//!   it needs that this wisp lacks (a harness, a plugin).
//! - `share.import {bundle}`: a `full` share as a read-only task (`runtime.adopt`), to read or fork.
//!
//! - `share.send {to, kind, …}` (ADR-0038): a task's signed bundle, or any other kind's content as the preview
//!   showed it, signed with the same key, to a destination (`share.destination@1`): wisp Cloud is
//!   wisp.grid-client's `wisp-cloud`. `share.destinations` lists them and whether each is ready.
//!
//! File and gist stay the CLI's and the app's.

use std::fmt::Write as _;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signature, Signer as _, SigningKey, Verifier as _, VerifyingKey};
use serde_json::{Value, json};
use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_share_api::{Bundle, DESTINATION, Destinations, FORMAT, Import, Level, Make, Open, Opened, Outgoing, Preview, PreviewCmd, SendArgs, SendCmd, ShareArgs, Signer};
use wisp_share_core::{Scrub, canonical, counts, scrub, secret_env};

pub use wisp_share_api::PLUGIN_ID;

mod link;

/// The secret this wisp signs shares with (`share/key`: a 32-byte ed25519 seed, base64).
const KEY: &str = "share/key";

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

async fn signing_key(ctx: &Ctx) -> Result<SigningKey> {
    let secrets = wisp_kernel::services::secrets(ctx)?;
    if let Some(seed) = secrets.get(KEY).await?
        && let Ok(b) = B64.decode(seed.trim())
        && let Ok(arr) = <[u8; 32]>::try_from(b.as_slice())
    {
        return Ok(SigningKey::from_bytes(&arr));
    }
    let seed: [u8; 32] = rand::random();
    secrets.set(KEY, &B64.encode(seed)).await?;
    Ok(SigningKey::from_bytes(&seed))
}

/// Who this wisp is to the people it shares with.
fn me() -> String {
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "someone".into());
    let host = std::env::var("HOSTNAME").ok().filter(|h| !h.is_empty());
    host.map_or_else(|| user.clone(), |h| format!("{user}@{h}"))
}

/// The files a turn's steps edited or wrote.
fn files_of(steps: &Value, out: &mut Vec<String>) {
    for st in steps.get("items").and_then(Value::as_array).into_iter().flatten() {
        let tool = s(st, "tool");
        let f = s(st, "file");
        if s(st, "kind") == "tool" && !f.is_empty() && matches!(tool, "edit" | "write" | "multi_edit" | "patch" | "create") && !out.iter().any(|x| x == f) {
            out.push(f.to_owned());
        }
    }
}

async fn preview(ctx: &Ctx, call: &Call, a: &ShareArgs) -> Result<Preview> {
    let task = ctx.run_json(call, "runtime.get", json!({ "id": a.id })).await?;
    let spec = ctx.run_json(call, "runtime.spec", json!({ "id": a.id })).await?;
    let formula = ctx.run_json(call, "runtime.snapshot", json!({ "of": a.id })).await.map_or(Value::Null, |x| x["formula"].clone());
    let mut report = None;
    let mut history = None;
    if a.level != Level::Spec {
        let turns = ctx.run_json(call, "runtime.turns", json!({ "id": a.id })).await?;
        let mut answers = Vec::new();
        let mut files = Vec::new();
        let mut full = Vec::new();
        for t in turns.as_array().into_iter().flatten() {
            let steps = ctx.run_json(call, "runtime.activity", json!({ "id": a.id, "turnId": t["id"] })).await.unwrap_or(Value::Null);
            files_of(&steps, &mut files);
            answers.push(json!({ "prompt": t["prompt"], "status": t["status"], "blocks": t.pointer("/presentation/blocks").cloned().unwrap_or(json!([])), "text": t["text"] }));
            if a.level == Level::Full {
                full.push(json!({ "turn": t, "steps": steps["items"] }));
            }
        }
        report = Some(json!({ "answers": answers, "files": files }));
        if a.level == Level::Full {
            history = Some(Value::Array(full));
        }
    }
    // the scrub: secrets, this server's secret env values, paths, names the sharer didn't pick
    let mut names: Vec<(String, String)> = Vec::new();
    if let Ok(list) = ctx.run_json(call, "runtime.list", json!({})).await {
        names.extend(list.as_array().into_iter().flatten().filter(|t| s(t, "id") != a.id).map(|t| (s(t, "title").to_owned(), "<task>".to_owned())).filter(|(t, _)| t.len() > 3));
    }
    let crew = spec.get("crew").and_then(Value::as_str).unwrap_or_default().to_owned();
    if let Ok(list) = ctx.run_json(call, "crew.list", json!({})).await {
        names.extend(list.as_array().into_iter().flatten().filter(|m| s(m, "name") != crew && s(m, "id") != crew).map(|m| (s(m, "name").to_owned(), "<crew>".to_owned())));
    }
    let scrub_with = Scrub { env: secret_env(std::env::vars()), project: s(&spec, "cwd").to_owned(), home: std::env::var("HOME").unwrap_or_default(), names };
    let mut red = Vec::new();
    let title = wisp_share_core::scrub_text(s(&task, "title"), &scrub_with, "title", &mut red);
    let spec = scrub(&spec, &scrub_with, "spec", &mut red);
    let formula = scrub(&formula, &scrub_with, "formula", &mut red);
    let report = report.map(|r| scrub(&r, &scrub_with, "report", &mut red));
    let history = history.map(|h| scrub(&h, &scrub_with, "history", &mut red));
    let mut needs = Vec::new();
    let harness = s(&task, "agent");
    if !harness.is_empty() {
        needs.push(format!("harness:{harness}"));
    }
    if spec.pointer("/lineage/workflowRun").is_some() {
        needs.push("plugin:wisp.workflows".to_owned());
    }
    let bundle = Bundle {
        wisp_task: FORMAT,
        id: format!("share-{}", &wisp_kernel::ids::uuid7()[..24]),
        level: a.level,
        title,
        created_at: ctx.clock().map_or(0, |c| c.now_ms()),
        version: env!("CARGO_PKG_VERSION").to_owned(),
        needs,
        spec,
        formula,
        report,
        history,
        redacted: counts(&red),
        from: Signer::default(),
        sig: String::new(),
    };
    Ok(Preview { bundle, redactions: red })
}

async fn make(ctx: &Ctx, call: &Call, a: &ShareArgs) -> Result<Bundle> {
    let mut b = preview(ctx, call, a).await?.bundle;
    let key = signing_key(ctx).await?;
    b.from = Signer { name: me(), key: B64.encode(key.verifying_key().to_bytes()) };
    b.sig = B64.encode(key.sign(&canonical(&b)).to_bytes());
    Ok(b)
}

/// Whether `b`'s signature is its signer's over exactly these contents.
pub fn verify(b: &Bundle) -> bool {
    let (Ok(k), Ok(sig)) = (B64.decode(&b.from.key), B64.decode(&b.sig)) else { return false };
    let (Ok(k), Ok(sig)) = (<[u8; 32]>::try_from(k.as_slice()), <[u8; 64]>::try_from(sig.as_slice())) else { return false };
    VerifyingKey::from_bytes(&k).is_ok_and(|vk| vk.verify(&canonical(b), &Signature::from_bytes(&sig)).is_ok())
}

/// A key's fingerprint people can compare (the first 16 hex of its bytes).
fn fingerprint(key: &str) -> String {
    B64.decode(key).map(|b| b.iter().take(8).fold(String::new(), |mut s, x| {
        let _ = write!(s, "{x:02x}");
        s
    })).unwrap_or_default()
}

async fn open(ctx: &Ctx, call: &Call, b: Bundle) -> Result<Opened> {
    if b.wisp_task != FORMAT {
        return Err(WireError::invalid(format!("a .wisp-task of format {} (this wisp reads {FORMAT}): update wisp", b.wisp_task)));
    }
    let agents = ctx.run_json(call, "runtime.agents", json!({})).await.unwrap_or(Value::Null);
    let have = |h: &str| agents.as_array().into_iter().flatten().any(|a| s(a, "id") == h && a.get("available") != Some(&json!(false)));
    let missing = b.needs.iter().filter(|n| n.strip_prefix("harness:").is_some_and(|h| !have(h))).cloned().collect();
    Ok(Opened { verified: verify(&b), fingerprint: fingerprint(&b.from.key), signer: b.from.clone(), level: b.level, title: b.title.clone(), missing, bundle: b })
}

async fn import(ctx: &Ctx, call: &Call, b: Bundle) -> Result<Value> {
    if !verify(&b) {
        return Err(WireError::invalid("this share's signature doesn't match its contents: not imported"));
    }
    if b.level != Level::Full {
        return Err(WireError::invalid("only a full share has the history to import (this one is a spec or a report: run it instead)"));
    }
    let turns: Vec<Value> = b.history.as_ref().and_then(Value::as_array).into_iter().flatten().map(|h| h["turn"].clone()).collect();
    let harness = b.needs.iter().find_map(|n| n.strip_prefix("harness:")).unwrap_or_default();
    let mut spec = b.spec.clone();
    spec["lineage"] = json!({ "sharedFrom": b.id });
    let n = turns.len();
    let args = json!({ "title": format!("{} (shared by {})", b.title, b.from.name), "agent": harness, "cwd": "", "turns": turns, "spec": spec, "ext": { PLUGIN_ID: { "id": b.id, "from": b.from.name, "level": "full" } } });
    let out = ctx.run_json(call, "runtime.adopt", args).await?;
    let props = json!({ "turns": n, "work": "none", "switched": false });
    let _ = ctx.run_json(&ctx.root_call(), "telemetry.track", json!({ "event": "task_import", "props": props })).await;
    Ok(out)
}

/// `share.send`: what goes, signed, to the destination named.
async fn send(ctx: &Ctx, call: &Call, a: SendArgs) -> Result<Value> {
    let dest = ctx.contributions(&DESTINATION).into_iter().find(|d| d.id() == a.to).ok_or_else(|| WireError::invalid(format!("there's no share destination {} here (wisp Cloud is wisp-cloud, from wisp.grid-client)", a.to)))?;
    dest.ready().await.map_err(WireError::invalid)?;
    let kind = a.kind.clone().unwrap_or_else(|| "task".into());
    let (key, title, body) = if kind == "task" {
        let id = a.id.clone().ok_or_else(|| WireError::invalid("which task: id"))?;
        let mut b = preview(ctx, call, &ShareArgs { id: id.clone(), level: a.level }).await?.bundle;
        // the same task shared again is the same bundle unless it changed (a new version only then)
        b.id = format!("share-{id}");
        b.created_at = ctx.run_json(call, "runtime.get", json!({ "id": id })).await.ok().and_then(|t| t.get("updatedAt").and_then(Value::as_i64)).unwrap_or(0);
        let k = signing_key(ctx).await?;
        b.from = Signer { name: me(), key: B64.encode(k.verifying_key().to_bytes()) };
        b.sig = B64.encode(k.sign(&canonical(&b)).to_bytes());
        let body = serde_json::to_vec(&b).map_err(|e| WireError::internal(e.to_string()))?;
        (id, a.title.clone().unwrap_or_else(|| b.title.clone()), body)
    } else {
        let content = a.content.clone().ok_or_else(|| WireError::invalid(format!("a {kind} share needs its content")))?;
        let key = a.key.clone().filter(|k| !k.is_empty()).ok_or_else(|| WireError::invalid("a key: what it is here, so sharing it again updates the link"))?;
        let body = serde_json::to_vec(&content).map_err(|e| WireError::internal(e.to_string()))?;
        (key.clone(), a.title.clone().unwrap_or(key), body)
    };
    let k = signing_key(ctx).await?;
    let out = Outgoing {
        kind,
        key,
        title,
        summary: a.summary.clone().unwrap_or_default(),
        tags: a.tags.clone(),
        sig: B64.encode(k.sign(&body).to_bytes()),
        signer: B64.encode(k.verifying_key().to_bytes()),
        body,
        access: a.access.clone(),
        expires_at: a.expires_at,
        publish: a.publish,
    };
    dest.send(out).await
}

async fn destinations(ctx: &Ctx) -> Value {
    let mut out = Vec::new();
    for d in ctx.contributions(&DESTINATION) {
        let why = d.ready().await.err();
        out.push(json!({ "id": d.id(), "label": d.label(), "ready": why.is_none(), "why": why }));
    }
    Value::Array(out)
}

#[derive(Debug, Default)]
pub struct SharePlugin;

impl Plugin for SharePlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        s.command::<PreviewCmd, _, _>(|ctx, call, a| async move { preview(&ctx, &call, &a).await });
        s.command::<Make, _, _>(|ctx, call, a| async move { make(&ctx, &call, &a).await });
        s.command::<Open, _, _>(|ctx, call, a| async move { open(&ctx, &call, a.bundle).await });
        s.command::<Import, _, _>(|ctx, call, a| async move { import(&ctx, &call, a.bundle).await });
        s.command::<SendCmd, _, _>(|ctx, call, a| async move { send(&ctx, &call, a).await });
        s.command::<Destinations, _, _>(|ctx, _call, _a| async move { Ok(destinations(&ctx).await) });
        link::register(s);
        Ok(())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_signed_bundle_verifies_and_a_changed_one_doesnt() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let mut b = Bundle { wisp_task: FORMAT, id: "b".into(), title: "Fix login".into(), spec: json!({ "prompt": "fix it" }), ..Bundle::default() };
        b.from = Signer { name: "ada".into(), key: B64.encode(key.verifying_key().to_bytes()) };
        b.sig = B64.encode(key.sign(&canonical(&b)).to_bytes());
        assert!(verify(&b));
        let mut changed = b.clone();
        changed.spec["prompt"] = json!("send me your keys");
        assert!(!verify(&changed), "the contents changed after signing");
        let mut other = b.clone();
        other.from.key = B64.encode(SigningKey::from_bytes(&[8u8; 32]).verifying_key().to_bytes());
        assert!(!verify(&other), "someone else's key");
        assert_eq!(fingerprint(&b.from.key).len(), 16);
    }

    #[test]
    fn manifest_is_valid() {
        assert_eq!(SharePlugin.manifest().id, PLUGIN_ID);
    }
}
