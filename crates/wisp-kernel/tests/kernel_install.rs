//! ADR-0046: a user's plugin installed while the kernel runs. It starts off until switched on (the consent to what
//! it asks for), a built-in id or a bad manifest is refused, and uninstall takes it off and out.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod common;

use std::sync::{Arc, Mutex};

use serde_json::json;
use wisp_kernel::{Caller, Ctx, PluginGroup};

cmd!(Hello, "user.hello.say", (), String);

/// The plugin manager: it holds `plugins:manage`, and keeps its context for the test.
fn manager(slot: Arc<Mutex<Option<Ctx>>>) -> common::P {
    common::plugin("wisp.plugins", json!({ "permissions": ["plugins:manage"] }), move |s| {
        let slot = slot.clone();
        s.on_start(move |ctx| {
            *slot.lock().unwrap() = Some(ctx);
            async { Ok(()) }
        });
    })
}

fn hello() -> Arc<dyn wisp_kernel::Plugin> {
    Arc::new(common::plugin(
        "user.hello",
        json!({ "contributes": { "commands": [{ "id": "user.hello.say", "title": "Say hello" }] } }),
        |s| {
            s.command::<Hello, _, _>(|_ctx, _call, ()| async { Ok("hello".to_owned()) });
        },
    ))
}

async fn kernel() -> (wisp_kernel::Kernel, Ctx) {
    let slot = Arc::new(Mutex::new(None));
    let k = common::start(PluginGroup::new().add(manager(slot.clone()))).await;
    let ctx = slot.lock().unwrap().clone().expect("the manager started");
    (k, ctx)
}

#[tokio::test]
async fn an_installed_plugin_starts_off_until_switched_on() {
    let (k, ctx) = kernel().await;
    ctx.install_plugin(hello()).await.unwrap();
    let st = k.status().into_iter().find(|s| s.id == "user.hello").unwrap();
    assert_eq!(st.state, "off", "{st:?}");
    assert!(st.reason.as_deref().unwrap_or_default().contains("not switched on yet"));
    assert!(k.call(Caller::user(), "user.hello.say", json!(null)).await.is_err(), "nothing it adds runs before the yes");
    k.set_enabled("user.hello", true).await.unwrap();
    assert_eq!(k.call(Caller::user(), "user.hello.say", json!(null)).await.unwrap(), json!("hello"));
    // the same id again is refused while it's here
    assert!(ctx.install_plugin(hello()).await.is_err());
}

#[tokio::test]
async fn uninstall_takes_a_user_plugin_off_and_removes_it() {
    let (k, ctx) = kernel().await;
    ctx.install_plugin(hello()).await.unwrap();
    k.set_enabled("user.hello", true).await.unwrap();
    ctx.uninstall_plugin("user.hello").await.unwrap();
    assert!(!k.status().iter().any(|s| s.id == "user.hello"));
    assert!(k.call(Caller::user(), "user.hello.say", json!(null)).await.is_err(), "its command went with it");
    // a built-in is switched off, never removed
    assert!(ctx.uninstall_plugin("wisp.plugins").await.is_err());
    // and it can come back
    ctx.install_plugin(hello()).await.unwrap();
}

#[tokio::test]
async fn an_invalid_manifest_is_refused_and_nothing_is_kept() {
    let (k, ctx) = kernel().await;
    let bad = Arc::new(common::bare("invalid.manifest", json!({ "description": "broken" })));
    assert!(ctx.install_plugin(bad).await.is_err());
    assert!(!k.status().iter().any(|s| s.id == "invalid.manifest"));
}
