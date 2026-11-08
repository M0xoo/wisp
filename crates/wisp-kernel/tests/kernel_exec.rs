//! The exec tier (plan §6.7 tier 3): a plugin as a child process over JSON-RPC on stdio. Same commands,
//! interceptors, subscribers, contributions, permissions and traces; a dead child is a plugin off with
//! the reason, then back after a backoff.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::needless_pass_by_value,
    clippy::type_complexity,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::many_single_char_names
)]
mod common;

use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use wisp_kernel::{
    Caller, Code, Event, ExecOptions, ExecPlugin, Hook, Kernel, Manifest, PluginGroup,
};

cmd!(Read, "host.read", (), u32, read_only);
cmd!(Record, "host.record", Value, ());
cmd!(Ping, "host.ping", Value, ());
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Pinged(Value);
impl Event for Pinged {
    const TYPE: &'static str = "host.ping";
}
struct Go;
impl Hook for Go {
    const ID: &'static str = "before:go";
    type Ctx = Value;
}

fn echo(mode: &str) -> Manifest {
    let cmds: Vec<Value> = ["say", "nested", "deep", "hook", "setting", "crash"]
        .iter()
        .map(|c| json!({ "id": format!("echo.{c}"), "title": c }))
        .collect();
    common::manifest(
        "acme.echo",
        json!({
            "server": { "exec": [env!("CARGO_BIN_EXE_wisp-kernel-exec-echo"), mode] },
            "permissions": ["host:read", "host:record"],
            "contributes": { "commands": cmds, "events": ["echo.said"], "settings": [{ "key": "echo.greeting", "type": "string", "default": "hi" }] }
        }),
    )
}

struct World {
    k: Kernel,
    records: Arc<Mutex<Vec<Value>>>,
    events: Arc<Mutex<Vec<(String, String)>>>,
}

async fn world(mode: &str, opts: ExecOptions) -> World {
    let records: Arc<Mutex<Vec<Value>>> = Arc::default();
    let events: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
    let (r, e) = (records.clone(), events.clone());
    let host = common::plugin(
        "wisp.host",
        json!({ "contributes": { "points": [{ "id": "host.list", "version": 1, "kind": "list" }] } }),
        move |s| {
            s.command::<Read, _, _>(|_, call, ()| async move { Ok(call.depth()) });
            let r = r.clone();
            s.command::<Record, _, _>(move |_, _, v| {
                let r = r.clone();
                async move {
                    r.lock().unwrap().push(v);
                    Ok(())
                }
            });
            s.command::<Ping, _, _>(|ctx, call, v| async move {
                ctx.emit(&call, &Pinged(v));
                Ok(())
            });
            let e = e.clone();
            s.on_raw("echo.*", move |_, env| {
                let e = e.clone();
                async move {
                    e.lock().unwrap().push((env.ty.clone(), env.plugin.clone()));
                    Ok(())
                }
            });
        },
    );
    let k = common::start(
        PluginGroup::new()
            .add(host)
            .add(ExecPlugin::new(echo(mode), None).with_options(opts)),
    )
    .await;
    World { k, records, events }
}

async fn until(f: impl Fn() -> bool) {
    for _ in 0..400 {
        if f() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("condition never held");
}

#[tokio::test]
async fn an_exec_plugin_registers_and_answers_over_rpc() {
    let w = world("ok", ExecOptions::default()).await;
    let k = &w.k;
    assert_eq!(common::state(k, "acme.echo"), ("active".into(), None));
    assert!(
        !k.status()
            .iter()
            .find(|s| s.id == "acme.echo")
            .unwrap()
            .builtin
    );
    let u = Caller::user();
    assert_eq!(
        k.call(u.clone(), "echo.say", json!({ "a": 1 }))
            .await
            .unwrap(),
        json!({ "echoed": { "a": 1 } })
    );
    k.idle().await;
    assert_eq!(
        *w.events.lock().unwrap(),
        [("echo.said".to_owned(), "acme.echo".to_owned())],
        "emitted inside the call, published after it"
    );
    // a nested call from the child continues the trace
    assert_eq!(
        k.call(u.clone(), "echo.nested", json!(null)).await.unwrap(),
        json!({ "depth": 0, "inner": 1 })
    );
    assert_eq!(
        k.call(u.clone(), "echo.deep", json!(null))
            .await
            .unwrap_err()
            .code,
        Code::DepthExceeded
    );
    // its interceptor: modify, and a veto keeps its code across the boundary
    let host = k.ctx("wisp.host").unwrap();
    assert_eq!(
        host.run_hook::<Go>(&host.root_call(), json!({}))
            .await
            .unwrap(),
        json!({ "seen": "echo" })
    );
    let e = k
        .call(u.clone(), "echo.hook", json!({ "block": true }))
        .await
        .unwrap_err();
    assert_eq!((e.code, e.message.as_str()), (Code::Vetoed, "echo says no"));
    assert_eq!(
        k.call(u.clone(), "echo.setting", json!(null))
            .await
            .unwrap(),
        json!("hi")
    );
    // its subscriber runs a command back in the kernel
    k.call(u.clone(), "host.ping", json!({ "x": 1 }))
        .await
        .unwrap();
    until(|| !w.records.lock().unwrap().is_empty()).await;
    assert_eq!(w.records.lock().unwrap()[0], json!({ "x": 1 }));
    assert_eq!(
        k.declared("host.list"),
        [("acme.echo".to_owned(), json!({ "id": "echo" }))]
    );
    // permissions apply: an agent can't call it, and switching it off removes everything
    assert_eq!(
        k.call(Caller::agent("s1", false), "echo.say", json!(1))
            .await
            .unwrap_err()
            .code,
        Code::Forbidden
    );
    k.set_enabled("acme.echo", false).await.unwrap();
    assert_eq!(k.registrations("acme.echo"), 0);
    assert_eq!(
        k.call(u, "echo.say", json!(1)).await.unwrap_err().code,
        Code::PluginOff
    );
}

#[tokio::test]
async fn a_dead_child_is_off_with_the_reason_then_restarts() {
    let w = world(
        "ok",
        ExecOptions {
            restart_base_ms: 50,
            ..ExecOptions::default()
        },
    )
    .await;
    let k = &w.k;
    assert!(
        k.call(Caller::user(), "echo.crash", json!(null))
            .await
            .is_err()
    );
    until(|| common::state(k, "acme.echo").0 == "off").await;
    let why = common::state(k, "acme.echo").1.unwrap();
    assert!(
        why.starts_with("acme.echo's process exited (code 3); restarting in 50 ms"),
        "{why}"
    );
    until(|| common::state(k, "acme.echo").0 == "active").await;
    assert_eq!(
        k.call(Caller::user(), "echo.say", json!(2)).await.unwrap(),
        json!({ "echoed": 2 })
    );
}

#[tokio::test]
async fn a_child_that_never_finishes_setup_or_dies_at_once_is_refused() {
    let w = world(
        "slowinit",
        ExecOptions {
            init_timeout_ms: 100,
            ..ExecOptions::default()
        },
    )
    .await;
    let (state, why) = common::state(&w.k, "acme.echo");
    assert_eq!(state, "refused");
    assert!(why.unwrap().contains("didn't finish setup within 100 ms"));
    let w = world(
        "dies",
        ExecOptions {
            restart_base_ms: 10,
            max_restarts: 1,
            ..ExecOptions::default()
        },
    )
    .await;
    // dying before `initialize` answers is a failed start: refused with why, not a restart loop
    let (state, why) = common::state(&w.k, "acme.echo");
    assert_eq!(state, "refused", "{why:?}");
    assert!(
        why.as_deref().unwrap_or_default().contains("start failed"),
        "{why:?}"
    );
}
