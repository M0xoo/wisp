//! wisp.stuff's commands (the manifest's 17), over the same shelf the v1 routes use.

use std::path::Path;
use std::sync::Arc;

use wisp_kernel::{Result as WireResult, Setup, WireError};
use wisp_stuff_api::commands as c;
use wisp_stuff_core::record::{Fields, current_grant};

use crate::routes::{allow_for, saved};
use crate::save::SaveOpts;
use crate::shelf::gone;
use crate::state::{self, Cell, Stuff};

fn w(e: crate::error::Error) -> WireError {
    e.into()
}

/// The file manager, on `path`: macOS reveals it in Finder, Windows selects it in Explorer, elsewhere its
/// folder opens.
pub fn reveal_argv(os: &str, path: &str) -> (&'static str, Vec<String>) {
    match os {
        "macos" => ("open", vec!["-R".into(), path.into()]),
        "windows" => ("explorer", vec![format!("/select,{path}")]),
        _ => ("xdg-open", vec![Path::new(path).parent().map_or_else(|| path.to_owned(), |d| d.display().to_string())]),
    }
}

/// Registers command `$C` with `|s, ctx, call, args| body` over the started state.
macro_rules! on {
    ($s:ident, $cell:ident, $C:ty, |$st:ident, $ctx:ident, $call:ident, $a:ident| $body:expr) => {{
        let cell = $cell.clone();
        $s.command::<$C, _, _>(move |$ctx, $call, $a| {
            let cell = cell.clone();
            async move {
                let $st: Arc<Stuff> = state::get(&cell)?;
                let _ = (&$ctx, &$call);
                let kept = ($ctx.clone(), $st.clone());
                let out = { $body };
                // My Stuff's page reads rows: a change is written there too
                if !<$C as wisp_kernel::Command>::READ_ONLY {
                    crate::view::publish(&kept.0, &kept.1);
                }
                out
            }
        });
    }};
}

fn save_opts(a: &c::SaveArgs) -> SaveOpts {
    SaveOpts {
        fields: Fields::of(a.title.as_deref(), a.note.as_deref(), &a.tags, a.starred),
        by: Some(a.by.clone().unwrap_or_else(|| "you".into())),
        from: a.from.clone(),
        replace: a.replace.clone(),
        name: a.name.clone(),
        lang: a.lang.clone(),
        ..SaveOpts::default()
    }
}

async fn save(s: &Stuff, a: c::SaveArgs) -> WireResult<(wisp_stuff_api::StuffItem, bool)> {
    if let Some(same) = s.shelf.find_key(a.from.as_ref().and_then(|f| f.key.as_deref())) {
        return Ok((same, false));
    }
    let o = save_opts(&a);
    let it = if let Some(url) = &a.url {
        s.shelf.save_link(url, o).await
    } else if let Some(t) = &a.text {
        s.shelf.save_text(t, o).await
    } else if let Some(f) = &a.file {
        s.shelf.save_file(Path::new(f), o).await
    } else if let Some(app) = &a.app {
        s.shelf.save_app(Path::new(app), a.cover.as_deref().map(Path::new), o).await
    } else if let Some(id) = &a.replace {
        s.shelf.update(id, &o.fields).await
    } else {
        return Err(WireError::invalid("Say what to save: a url, some text, a file or an app."));
    };
    Ok((it.map_err(w)?, true))
}

pub fn register(s: &mut Setup, cell: &Cell) {
    on!(s, cell, c::List, |st, ctx, call, _a| Ok(st.views().await));
    on!(s, cell, c::Get, |st, ctx, call, a| Ok(st.shelf.get(&a.id)));
    on!(s, cell, c::Find, |st, ctx, call, a| st.shelf.find(&a, None).await.map_err(w));
    on!(s, cell, c::Describe, |st, ctx, call, a| Ok(st.shelf.describe(&a.id).await.map_err(w)?.map(|text| c::Text { text })));
    on!(s, cell, c::GrantOf, |st, ctx, call, a| Ok(current_grant(&st.shelf.get(&a.id).ok_or_else(|| w(gone()))?)));
    on!(s, cell, c::Save, |st, ctx, call, a| {
        let update = a.replace.is_some();
        let (it, fresh) = save(&st, a).await?;
        if fresh {
            saved(&ctx, &call, &it, update);
        }
        Ok(st.view(&it).await)
    });
    on!(s, cell, c::Update, |st, ctx, call, a| {
        let f = Fields::of(a.title.as_deref(), a.note.as_deref(), &a.tags, a.starred);
        let it = st.shelf.update(&a.id, &f).await.map_err(w)?;
        Ok(st.view(&it).await)
    });
    on!(s, cell, c::Restore, |st, ctx, call, a| {
        let it = st.shelf.restore(&a.id).await.map_err(w)?;
        Ok(st.view(&it).await)
    });
    on!(s, cell, c::Remove, |st, ctx, call, a| {
        let ok = st.remove(&ctx, &call, &a.id).await.map_err(w)?;
        if ok {
            ctx.emit(&call, &c::Removed { id: a.id });
        }
        Ok(c::Done { ok })
    });
    on!(s, cell, c::Allow, |st, ctx, call, a| {
        let it = allow_for(&st, &ctx, &call, &a.id, &a.uses, a.task.as_deref()).await.map_err(w)?;
        Ok(st.view(&it).await)
    });
    on!(s, cell, c::SetPublished, |st, ctx, call, a| {
        let was = st.shelf.get(&a.id).is_some_and(|x| x.published.is_some());
        let publishing = a.published.is_some();
        let it = st.shelf.set_published(&a.id, a.published).await.map_err(w)?;
        if publishing {
            crate::routes::track(&ctx, "stuff_publish", serde_json::json!({ "by": "you", "update": was }));
        }
        Ok(st.view(&it).await)
    });
    on!(s, cell, c::Starters, |st, ctx, call, _a| Ok(serde_json::json!({ "starters": crate::starters::list(&st.shelf) })));
    on!(s, cell, c::AddStarter, |st, ctx, call, a| {
        let (it, _) = crate::starters::add(&st.shelf, &a.id).await.map_err(w)?.ok_or_else(|| WireError::not_found("wisp has no starter by that name."))?;
        Ok(st.view(&it).await)
    });
    on!(s, cell, c::Reveal, |st, ctx, call, a| {
        let it = st.shelf.get(&a.id).ok_or_else(gone).map_err(w)?;
        if it.url.is_some() {
            return Err(WireError::invalid("A link has no file."));
        }
        let path = st.shelf.local_path(&it).await.map_err(w)?;
        let (bin, args) = reveal_argv(std::env::consts::OS, &path);
        let opened = match ctx.service::<wisp_proc::Proc>() {
            Ok(p) => p.exec(bin, &args, wisp_proc::ExecOpts::default()).await.is_ok_and(|r| r.exit.success()),
            Err(_) => false,
        };
        Ok(serde_json::json!({ "ok": opened, "path": path }))
    });
    on!(s, cell, c::Targets, |_st, ctx, call, _a| match ctx.use_service::<c::PublishService>() {
        Ok(p) => p.targets(&call),
        Err(_) => Ok(Vec::new()),
    });
    on!(s, cell, c::PublishApp, |st, ctx, call, a| {
        let p = ctx.use_service::<c::PublishService>().map_err(|_| WireError::invalid("Publishing needs wisp Cloud: sign in first."))?;
        let it = p.publish(&call, &a.id, serde_json::json!({})).await?;
        // the publisher recorded the link (`stuff.setPublished`): the item as My Stuff has it now
        let it = st.shelf.get(&it.id).unwrap_or(it);
        crate::routes::track(&ctx, "stuff_publish", serde_json::json!({ "by": "you" }));
        Ok(st.view(&it).await)
    });
    on!(s, cell, c::UnpublishApp, |st, ctx, call, a| {
        let p = ctx.use_service::<c::PublishService>().map_err(|_| WireError::invalid("Publishing needs wisp Cloud: sign in first."))?;
        let it = p.unpublish(&call, &a.id).await?;
        let it = st.shelf.get(&it.id).unwrap_or(it);
        Ok(st.view(&it).await)
    });
    on!(s, cell, c::Launch, |st, ctx, call, a| {
        let port = st.apps.launch(&a.id).await.map_err(w)?;
        ctx.emit(&call, &c::AppLaunched { id: a.id });
        crate::routes::track(&ctx, "stuff_launch", serde_json::json!({}));
        Ok(c::Launched { port, url: format!("http://localhost:{port}/") })
    });
    on!(s, cell, c::Stop, |st, ctx, call, a| Ok(c::Done { ok: st.apps.stop(&a.id) }));
    on!(s, cell, c::ResetData, |st, ctx, call, a| {
        let it = st.reset_data(&a.id).await.map_err(w)?;
        Ok(st.view(&it).await)
    });
    on!(s, cell, c::UploadOf, |st, ctx, call, a| st.shelf.upload(&a.id).await.map_err(w));
    on!(s, cell, c::Uploads, |st, ctx, call, a| st.shelf.uploads(&a.ids).await.map_err(w));
    on!(s, cell, c::RemoveUpload, |st, ctx, call, a| Ok(c::Done { ok: st.shelf.remove_upload(&a.id).await.map_err(w)? }));
}

#[cfg(test)]
mod reveal_tests {
    use super::reveal_argv;

    #[test]
    fn show_in_folder_opens_each_oss_file_manager_on_the_item() {
        assert_eq!(reveal_argv("macos", "/s/a.png"), ("open", vec!["-R".to_owned(), "/s/a.png".to_owned()]));
        assert_eq!(reveal_argv("linux", "/s/a.png"), ("xdg-open", vec!["/s".to_owned()]));
        assert_eq!(reveal_argv("windows", "C:\\s\\a.png").0, "explorer");
    }
}
