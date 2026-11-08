//! wisp.settings: the user's way into the kernel's settings registry (`settings.list`, `.get`, `.set`),
//! and v1's `GET`/`PATCH /config` over the same values (`defaults` by v1's names, see `V1_ALIASES`). It
//! keeps nothing itself: values live in the registry, saved through the store; a v1 install's
//! `config.json` defaults are carried over once at start.

mod kind;

use std::sync::Arc;

use serde_json::{Map, Value, json};
use wisp_kernel::http::{Response, Route};
use wisp_kernel::{Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_settings_api::{self as api, V1_ALIASES, key_of};

/// The user's change is committed before the answer: the store runs writes in order, so an awaited
/// empty write lands after the settings' own.
async fn durable(ctx: &Ctx) {
    if let Ok(store) = ctx.service::<wisp_store::Store>() {
        let _ = store.write(|_| Ok(())).await;
    }
}

/// v1's `GET /config` view: `defaults` by v1's names, plus every setting by its own key.
fn config_view(ctx: &Ctx) -> Result<Value> {
    let list = ctx.settings_list()?;
    let mut defaults = Map::new();
    for (v1, key) in V1_ALIASES {
        if let Some(v) = list.iter().find(|s| s.key == *key).and_then(|s| s.value.clone()) {
            defaults.insert((*v1).into(), v);
        }
    }
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        o => o,
    };
    Ok(json!({ "defaults": defaults, "settings": list, "platform": os, "home": std::env::var("HOME").unwrap_or_default() }))
}

/// `PATCH /config {defaults}`: each name written, all or nothing (a refusal leaves the others unchanged).
fn patch(ctx: &Ctx, defaults: &Map<String, Value>) -> Result<()> {
    let list = ctx.settings_list()?;
    for k in defaults.keys() {
        let key = key_of(k);
        let Some(s) = list.iter().find(|s| s.key == key) else {
            return Err(WireError::invalid(format!("{k} is not a setting")));
        };
        if let Some(by) = &s.locked_by {
            return Err(WireError::conflict(format!("{k} is set by {by}. Turn it off in Settings → Plugins to change it.")));
        }
    }
    let before: Vec<(String, Option<Value>)> = defaults.keys().map(|k| (key_of(k).to_owned(), list.iter().find(|s| s.key == key_of(k)).and_then(|s| s.value.clone()))).collect();
    for (k, v) in defaults {
        if let Err(e) = ctx.set_setting(key_of(k), (!v.is_null()).then(|| v.clone())) {
            for (key, was) in &before {
                let _ = ctx.set_setting(key, was.clone());
            }
            return Err(e);
        }
    }
    Ok(())
}

#[derive(Debug, Default)]
pub struct SettingsPlugin;

impl Plugin for SettingsPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let k: Arc<dyn wisp_resources_api::ResourceKind> = Arc::new(kind::SettingKind { ctx: s.ctx() });
        s.contribute(&wisp_resources_api::RESOURCE_KIND, k);
        s.command::<api::List, _, _>(|ctx, _call, _a| async move { ctx.settings_list() });
        s.command::<api::Get, _, _>(|ctx, _call, a| async move { Ok(ctx.setting(&a.key).unwrap_or(Value::Null)) });
        s.command::<api::Set, _, _>(|ctx, _call, a| async move {
            let key = key_of(&a.key).to_owned();
            ctx.set_setting(&key, (!a.value.is_null()).then_some(a.value))?;
            durable(&ctx).await;
            ctx.settings_list()?.into_iter().find(|s| s.key == key).ok_or_else(|| WireError::not_found("No such setting."))
        });
        s.route(Route {
            method: "GET",
            pattern: "/config",
            permission: "settings:read",
            doc: true,
            summary: "Settings, with v1's defaults names",
            raw: false,
            max_body: None,
            handler: Arc::new(|ctx, _call, _req| Box::pin(async move { Response::ok(config_view(&ctx)?) })),
        });
        s.route(Route {
            method: "PATCH",
            pattern: "/config",
            permission: "settings:write",
            doc: true,
            summary: "Change settings (v1 body: { defaults: { name: value } })",
            raw: false,
            max_body: None,
            handler: Arc::new(|ctx, _call, req| {
                Box::pin(async move {
                    let b: Value = req.json()?;
                    if let Some(d) = b.get("defaults").and_then(Value::as_object) {
                        patch(&ctx, d)?;
                        durable(&ctx).await;
                    }
                    Response::ok(config_view(&ctx)?)
                })
            }),
        });
        // a v1 install: its config.json defaults, once (a value set since wins)
        s.on_start(|ctx| async move {
            let Ok(p) = ctx.service::<wisp_kernel::services::Paths>() else { return Ok(()) };
            let Ok(text) = tokio_free_read(&p.home().join("config.json")) else { return Ok(()) };
            let cfg: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            let list = ctx.settings_list().unwrap_or_default();
            for (v1, key) in V1_ALIASES {
                let (Some(v), Some(s)) = (cfg.pointer(&format!("/defaults/{v1}")), list.iter().find(|s| s.key == *key)) else { continue };
                if s.value.is_none() || s.value == s.decl.default {
                    let _ = ctx.set_setting(key, Some(v.clone()));
                }
            }
            Ok(())
        });
        Ok(())
    }
}

/// Startup only: the v1 file read once before anything else runs.
fn tokio_free_read(p: &std::path::Path) -> std::io::Result<String> {
    std::fs::read_to_string(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(SettingsPlugin.manifest().id, "wisp.settings");
        assert_eq!(key_of("timeZone"), api::TIME_ZONE);
        assert_eq!(key_of("review.harness"), "review.harness");
    }
}
