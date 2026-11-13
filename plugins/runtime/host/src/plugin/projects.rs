//! Declared projects: `runtime.projectTest`, `runtime.discover`, `runtime.folders`, `runtime.projectRun`.

use std::sync::Arc;

use wisp_kernel::{Setup, WireError};
use wisp_resources_api::StoredKind;
use wisp_runtime_api::commands as c;

use super::track;

/// `runtime.discover`: git repos under your home that aren't projects yet (`found.rs`).
pub(super) fn discover(s: &mut Setup, known: Arc<StoredKind>) {
    s.command::<c::Discover, _, _>(move |_ctx, _call, _a| {
        let known = known.clone();
        async move {
            let paths: Vec<String> = known.specs().await.unwrap_or_default().into_iter().filter_map(|(_, s)| s.get("path").and_then(serde_json::Value::as_str).map(str::to_owned)).collect();
            let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(std::path::PathBuf::from);
            Ok(match home {
                Some(h) => crate::found::discover(&h, &paths).await,
                None => Vec::new(),
            })
        }
    });
}

/// `runtime.folders`: the folders a typed path could go on to (`found.rs` `folders`).
pub(super) fn folders(s: &mut Setup) {
    s.command::<c::Folders, _, _>(move |_ctx, _call, a| async move {
        let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(std::path::PathBuf::from);
        Ok(crate::found::folders(&a.q, home.as_deref()).await)
    });
}

/// `runtime.projectTest`: a declared project's test command, written through its resource kind.
pub(super) fn project_test(s: &mut Setup, tests_kind: Arc<StoredKind>) {
    s.command::<c::ProjectTest, _, _>(move |_ctx, call, a| {
        let kind = tests_kind.clone();
        async move {
            use wisp_resources_api::ResourceKind as _;
            let list = kind.specs().await.unwrap_or_default();
            let (_, before) = list.into_iter().find(|(n, _)| *n == a.name).ok_or_else(|| WireError::not_found(format!("No project called {}", a.name)))?;
            let spec = crate::kinds::with_test(&before, &a.test_command);
            let op = wisp_resources_api::Op { op: wisp_resources_api::OpKind::Update, kind: "project".into(), name: a.name.clone(), spec, id: None, changes: Vec::new(), before: Some(before) };
            kind.apply(&call, &op).await?;
            Ok(c::Ack {})
        }
    });
}

/// `runtime.projectRun`: a declared project's run scripts, in a shell terminal.
pub(super) fn project_run(s: &mut Setup, projects: Arc<StoredKind>) {
    s.command::<c::ProjectRun, _, _>(move |ctx, call, a| {
        let projects = projects.clone();
        async move {
            let list = projects.specs().await.unwrap_or_default();
            let (name, p) = crate::kinds::project_for(&list, &a.cwd).ok_or_else(|| WireError::not_found(format!("{} isn't in a declared project (projects: in a formula)", a.cwd)))?;
            if p.run.is_empty() {
                return Err(WireError::invalid(format!("{name} has no run scripts (run: in its project)")));
            }
            let argv = vec!["sh".to_owned(), "-c".to_owned(), p.run.join(" && ")];
            let args = wisp_terminal_api::commands::OpenArgs { kind: wisp_terminal_api::TermKind::Shell, id: format!("run:{name}"), argv, cwd: p.path.clone(), ..Default::default() };
            let out = ctx.run::<wisp_terminal_api::commands::Open>(&call, args).await?;
            track(&ctx, "run_app", serde_json::json!({ "source": "project" })).await;
            serde_json::to_value(out).map_err(|e| WireError::invalid(format!("terminal.open: {e}")))
        }
    });
}
