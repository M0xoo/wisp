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

/// Registers command `$C` with `|s, ctx, call, args| body` over the started state.
macro_rules! on {
    ($s:ident, $cell:ident, $C:ty, |$st:ident, $ctx:ident, $call:ident, $a:ident| $body:expr) => {{
        let cell = $cell.clone();
        $s.command::<$C, _, _>(move |$ctx, $call, $a| {
            let cell = cell.clone();
            async move {
                let $st: Arc<Stuff> = state::get(&cell)?;
                let _ = (&$ctx, &$call);
                $body
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
