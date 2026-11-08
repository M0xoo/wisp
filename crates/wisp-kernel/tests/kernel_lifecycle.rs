//! Lifecycle (plan §6.3, §6.4, §6.11.1): group disable, refusals with exact reasons, cascades and
//! coming back, scopes that leak nothing, services by contract, settings, schedules, routes.
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

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::json;
use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::{App, Call, Caller, Code, PluginGroup, Result, Service};

trait Repo: Send + Sync {
    fn status(&self, call: &Call) -> Result<String>;
}
struct GitService;
impl Service for GitService {
    const ID: &'static str = "git.service";
    const MAJOR: u32 = 1;
    type Api = dyn Repo;
}
struct Real(&'static str);
impl Repo for Real {
    fn status(&self, call: &Call) -> Result<String> {
        call.require("git:status")?;
        Ok(self.0.to_owned())
    }
}

fn git(id: &str, who: &'static str, builtin: bool) -> common::P {
    let extra = if builtin {
        json!({ "provides": { "git.service": { "version": "1.2.0" } } })
    } else {
        json!({ "provides": { "git.service": { "version": "1.0.0" } }, "trust": "untrusted" })
    };
    common::plugin(id, extra, move |s| {
        s.provide::<GitService>(Arc::new(Real(who)));
    })
}

cmd!(Status, "worktrees.status", (), String);
cmd!(Ping, "runtime.ping", (), ());

fn worktrees() -> common::P {
    common::plugin(
        "wisp.worktrees",
        json!({ "requires": { "git.service": "^1" }, "permissions": ["git:status"] }),
        |s| {
            s.command::<Status, _, _>(|ctx, call, ()| async move {
                ctx.use_service::<GitService>()?.status(&call)
            });
        },
    )
}

#[tokio::test]
async fn disabled_in_the_group_refuses_dependents_with_the_reason() {
    let g = PluginGroup::new()
        .add(common::bare("wisp.runtime", json!({})))
        .add(common::bare(
            "wisp.claude",
            json!({ "kind": "module", "extends": "wisp.runtime" }),
        ))
        .disable("wisp.runtime");
    let k = common::start(g).await;
    assert_eq!(
        common::state(&k, "wisp.runtime"),
        (
            "off".into(),
            Some("wisp.runtime is off (disabled in the plugin group)".into())
        )
    );
    assert_eq!(
        common::state(&k, "wisp.claude"),
        (
            "refused".into(),
            Some("wisp.claude extends wisp.runtime, which is off".into())
        )
    );
    k.set_enabled("wisp.runtime", true).await.unwrap();
    assert_eq!(
        common::state(&k, "wisp.claude").0,
        "active",
        "dependents come back with it"
    );
}

#[tokio::test]
async fn switching_off_cascades_and_leaks_nothing() {
    let ticks = Arc::new(AtomicU32::new(0));
    let t = ticks.clone();
    let runtime = common::plugin("wisp.runtime", json!({}), move |s| {
        let t = t.clone();
        let ctx = s.ctx();
        s.on_start(move |_| async move {
            ctx.spawn(async move {
                loop {
                    t.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await;
                }
            });
            Ok(())
        });
        s.command::<Ping, _, _>(|_, _, ()| async move { Ok(()) });
        s.ctx().watch_setting("runtime.x", |_| {});
    });
    let g = PluginGroup::new().add(runtime).add(common::bare(
        "wisp.claude",
        json!({ "requires": { "wisp.runtime": "^1" } }),
    ));
    let k = common::start(g).await;
    assert!(k.registrations("wisp.runtime") >= 2);
    k.set_enabled("wisp.runtime", false).await.unwrap();
    assert_eq!(k.registrations("wisp.runtime"), 0);
    assert_eq!(
        common::state(&k, "wisp.claude"),
        (
            "refused".into(),
            Some("wisp.claude requires wisp.runtime, which is off".into())
        )
    );
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    let n = ticks.load(Ordering::SeqCst);
    tokio::time::sleep(std::time::Duration::from_millis(30)).await;
    assert_eq!(ticks.load(Ordering::SeqCst), n, "the scope's task stopped");
    assert_eq!(
        k.call(Caller::user(), "runtime.ping", json!(null))
            .await
            .unwrap_err()
            .code,
        Code::NotFound
    );
}

#[tokio::test]
async fn services_by_contract_with_provider_choice_and_service_gone() {
    let k = common::start(
        PluginGroup::new()
            .add(git("wisp.git", "git", true))
            .add(git("acme.jj", "jj", false))
            .add(worktrees()),
    )
    .await;
    // an override (not built in) wins by default
    assert_eq!(
        k.call(Caller::user(), "worktrees.status", json!(null))
            .await
            .unwrap(),
        json!("jj")
    );
    k.choose_provider("git.service", "wisp.git").await.unwrap();
    assert_eq!(
        k.call(Caller::user(), "worktrees.status", json!(null))
            .await
            .unwrap(),
        json!("git")
    );
    // each method checks its permission against the caller
    assert_eq!(
        k.call(Caller::set("preview"), "worktrees.status", json!(null))
            .await
            .unwrap_err()
            .code,
        Code::Forbidden
    );
    let ctx = k.ctx("wisp.worktrees").unwrap();
    k.set_enabled("wisp.git", false).await.unwrap();
    assert_eq!(
        k.call(Caller::user(), "worktrees.status", json!(null))
            .await
            .unwrap(),
        json!("jj"),
        "the other provider takes over"
    );
    k.set_enabled("acme.jj", false).await.unwrap();
    assert_eq!(
        ctx.use_service::<GitService>().err().map(|e| e.code),
        Some(Code::ServiceGone)
    );
    assert_eq!(common::state(&k, "wisp.worktrees").0, "refused");
}

#[tokio::test]
async fn an_undeclared_service_or_a_version_mismatch_is_refused() {
    let sneaky = common::plugin("wisp.sneaky", json!({}), |s| {
        s.provide::<GitService>(Arc::new(Real("x")));
    });
    let old = common::bare("acme.old", json!({ "requires": { "wisp.base": "^2" } }));
    let k = common::start(
        PluginGroup::new()
            .add(sneaky)
            .add(common::bare("wisp.base", json!({})))
            .add(old),
    )
    .await;
    assert!(
        common::state(&k, "wisp.sneaky")
            .1
            .unwrap()
            .contains("without declaring it")
    );
    assert_eq!(
        common::state(&k, "acme.old").1.unwrap(),
        "acme.old requires wisp.base ^2, but 1.0.0"
    );
}

#[tokio::test]
async fn cycles_are_refused_and_printed() {
    let a = common::bare(
        "acme.a",
        json!({ "requires": { "b.service": "^1" }, "provides": { "a.service": { "version": "1.0.0" } } }),
    );
    let b = common::bare(
        "acme.b",
        json!({ "requires": { "a.service": "^1" }, "provides": { "b.service": { "version": "1.0.0" } } }),
    );
    let k = common::start(PluginGroup::new().add(a).add(b)).await;
    let why = common::state(&k, "acme.a").1.unwrap();
    assert!(why == "dependency cycle: acme.a → acme.b → acme.a", "{why}");
}

#[tokio::test]
async fn setup_failure_and_duplicates() {
    let bad = common::P {
        m: common::manifest("acme.bad", json!({})),
        f: Arc::new(|_| Err(wisp_kernel::WireError::internal("no config"))),
    };
    let k = common::start(
        PluginGroup::new()
            .add(bad)
            .add(common::bare("acme.bad", json!({ "version": "2.0.0" }))),
    )
    .await;
    let st = k.status();
    assert_eq!(st.iter().filter(|s| s.id == "acme.bad").count(), 2);
    assert!(
        st[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("setup failed: no config")
    );
    assert!(
        st[1]
            .reason
            .as_deref()
            .unwrap()
            .contains("registered twice")
    );
}

#[tokio::test]
async fn a_disable_list_switches_others_off() {
    let k = common::start(
        PluginGroup::new()
            .add(common::bare("wisp.telemetry", json!({})))
            .add(common::bare(
                "user.quiet",
                json!({ "disable": ["wisp.telemetry"] }),
            )),
    )
    .await;
    assert_eq!(
        common::state(&k, "wisp.telemetry"),
        (
            "off".into(),
            Some("wisp.telemetry is off (disabled by user.quiet)".into())
        )
    );
}

#[tokio::test]
async fn settings_declared_watched_and_typed() {
    let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
    let s2 = seen.clone();
    let p = common::plugin(
        "wisp.claude",
        json!({ "contributes": { "settings": [
            { "key": "claude.model", "type": "enum", "values": ["auto", "opus"], "default": "auto" },
            { "key": "claude.max", "type": "int", "min": 1, "max": 9, "scope": "device" }
        ] } }),
        move |s| {
            let seen = s2.clone();
            s.ctx()
                .watch_setting("claude.model", move |v| seen.lock().unwrap().push(v));
        },
    );
    let k = common::start(PluginGroup::new().add(p)).await;
    assert_eq!(k.setting("claude.model"), Some(json!("auto")));
    k.set_setting("claude.model", Some(json!("opus"))).unwrap();
    assert!(
        k.set_setting("claude.max", Some(json!(10)))
            .unwrap_err()
            .message
            .contains("at most 9")
    );
    assert_eq!(k.setting_info("claude.max").unwrap().scope, "device");
    assert!(k.set_setting("nobody.x", Some(json!(1))).is_err());
    k.set_setting("claude.model", None).unwrap();
    assert_eq!(
        *seen.lock().unwrap(),
        [Some(json!("opus")), Some(json!("auto"))]
    );
    k.set_enabled("wisp.claude", false).await.unwrap();
    assert_eq!(
        k.registrations("wisp.claude"),
        0,
        "the watcher went with the plugin"
    );
}

#[tokio::test]
async fn schedules_and_named_wakes() {
    let p = common::bare("acme.nightly", json!({ "activation": ["onSchedule:30ms"] }));
    let q = common::bare(
        "acme.view",
        json!({ "activation": ["onView:shell.task", "onTopic:session:*"] }),
    );
    let k = common::start(PluginGroup::new().add(p).add(q)).await;
    assert_eq!(common::state(&k, "acme.nightly").0, "resolved");
    tokio::time::sleep(std::time::Duration::from_millis(80)).await;
    assert_eq!(common::state(&k, "acme.nightly").0, "active");
    assert_eq!(k.wake("onBlock:chart", None).await, 0);
    assert_eq!(k.wake("onTopic:session:abc", None).await, 1);
    assert_eq!(common::state(&k, "acme.view").0, "active");
}

#[tokio::test]
async fn routes_serve_check_and_wake_their_lazy_plugin() {
    let p = common::plugin(
        "wisp.sessions",
        json!({ "activation": ["onRoute:GET /api/sessions/*"] }),
        |s| {
            s.route(Route {
                method: "GET",
                pattern: "/sessions/:id",
                permission: "session:read",
                doc: true,
                summary: "one session",
                raw: false,
                max_body: None,
                handler: Arc::new(|ctx, call, req: Request| {
                    Box::pin(async move {
                        Response::ok(
                            json!({ "id": req.param("id"), "by": ctx.plugin(), "via": call.via() }),
                        )
                    })
                }),
            });
        },
    );
    let k = common::start(PluginGroup::new().add(p)).await;
    assert_eq!(common::state(&k, "wisp.sessions").0, "resolved");
    let req = || Request {
        method: "GET".into(),
        path: "/api/sessions/s1".into(),
        ..Request::default()
    };
    let Response::Json { body, .. } = k.serve(Caller::user(), req()).await.unwrap() else {
        panic!("json")
    };
    assert_eq!(
        body,
        json!({ "id": "s1", "by": "wisp.sessions", "via": "wisp.sessions" })
    );
    assert_eq!(
        k.serve(Caller::set("pane:x"), req())
            .await
            .unwrap_err()
            .code,
        Code::Forbidden
    );
    assert!(k.serve(Caller::set("preview"), req()).await.is_ok());
    assert_eq!(
        k.serve(
            Caller::user(),
            Request {
                method: "GET".into(),
                path: "/api/nope".into(),
                ..Request::default()
            }
        )
        .await
        .unwrap_err()
        .code,
        Code::NotFound
    );
    assert_eq!(k.routes().len(), 1);
}

#[tokio::test]
async fn kernel_services_are_overridable() {
    #[derive(Debug)]
    struct Paths(&'static str);
    cmd!(Where, "paths.where", (), String);
    let p = common::plugin("wisp.paths", json!({}), |s| {
        s.command::<Where, _, _>(
            |ctx, _, ()| async move { Ok(ctx.service::<Paths>()?.0.to_owned()) },
        );
    });
    let k = App::new()
        .service(Paths("/a"))
        .service(Paths("/b"))
        .plugins(PluginGroup::new().add(p))
        .start()
        .await
        .unwrap();
    assert_eq!(
        k.call(Caller::user(), "paths.where", json!(null))
            .await
            .unwrap(),
        json!("/b")
    );
}
