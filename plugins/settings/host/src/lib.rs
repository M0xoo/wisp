//! wisp.settings: the user's way into the kernel's settings registry (`settings.list`, `.get`, `.set`).
//! It keeps nothing itself: values live in the registry, saved through the store. A v1 install's settings
//! come in through `wisp import` (ADR-0031), not here.

mod ui;
mod kind;

use std::sync::Arc;

use serde_json::Value;
use wisp_kernel::{Ctx, Manifest, Plugin, Result, Setup, WireError};
use wisp_settings_api::{self as api, key_of};

/// The user's change is committed before the answer: the store runs writes in order, so an awaited
/// empty write lands after the settings' own.
async fn durable(ctx: &Ctx) {
    if let Ok(store) = ctx.service::<wisp_store::Store>() {
        let _ = store.write(|_| Ok(())).await;
    }
}

#[derive(Debug, Default)]
pub struct SettingsPlugin;

impl Plugin for SettingsPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        crate::ui::register(s);
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
        Ok(())
    }
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
