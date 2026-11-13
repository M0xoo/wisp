//! `stuff.agent.save` and `stuff.agent.list`: the `wisp_save` and `wisp_stuff` tools a task's agent calls (v1
//! POST /internal/stuff, GET /internal/stuff/:id), in v1's words. Each answers `{ text }`, or `{ error }` for a
//! refusal the agent reads. A subagent saves for its lead's task, where the user looks. A capped task (started
//! from a channel with a mode cap) publishes nothing, and reads and changes only its own project's items.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use wisp_kernel::caps::capped_refusal;
use wisp_kernel::{Call, Ctx, Setup, WireError};
use wisp_runtime_api::Session;
use wisp_runtime_api::commands as rt;
use wisp_stuff_api::commands as c;
use wisp_stuff_api::{StuffItem, StuffKind};
use wisp_stuff_core::agent::{public_note, published_note, save_answer, unpublished_note};
use wisp_stuff_core::record::{Fields, from_task};

use crate::save::SaveOpts;
use crate::state::{self, Cell, Stuff};

const ONE_OF: &str =
    "Give exactly one of path (a file), text (with a name like notes.md), url, or app (a folder); with id, it updates that item.";

fn said(text: String) -> c::AgentText {
    c::AgentText { text: Some(text), error: None }
}

fn refused(error: impl Into<String>) -> c::AgentText {
    c::AgentText { text: None, error: Some(error.into()) }
}

/// A string argument the agent gave: trimmed, None when empty.
fn given(v: Option<&String>) -> Option<&str> {
    v.map(|s| s.trim()).filter(|s| !s.is_empty())
}

fn capped(call: &Call) -> bool {
    call.caller().set.starts_with("agent:capped")
}

/// A task as wisp.stuff reads it (the caller's own was checked already: this reads its lead and the tasks
/// items came from).
async fn task(ctx: &Ctx, id: &str) -> Option<Session> {
    ctx.run::<rt::Get>(&ctx.root_call(), rt::IdArgs { id: id.into() }).await.ok()
}

/// The caller's task (as the agent's token reads it) and its lead: a subagent's parent, itself otherwise.
async fn caller_and_lead(ctx: &Ctx, call: &Call, session: &str) -> Option<(Session, Session)> {
    let own = ctx.run::<rt::Get>(call, rt::IdArgs { id: session.into() }).await.ok()?;
    let lead = match &own.parent_id {
        Some(p) => task(ctx, p.as_str()).await.unwrap_or_else(|| own.clone()),
        None => own.clone(),
    };
    Some((own, lead))
}

/// v1 `projectKey`: a subagent's is its lead's (up to five up), else the task's folder.
async fn project(ctx: &Ctx, s: &Session) -> String {
    let mut x = s.clone();
    for _ in 0..5 {
        let Some(p) = x.parent_id.clone() else { break };
        match task(ctx, p.as_str()).await {
            Some(t) => x = t,
            None => break,
        }
    }
    x.cwd
}

fn inside(a: &Path, b: &Path) -> bool {
    !b.as_os_str().is_empty() && a.starts_with(b)
}

/// One project: the same folder, or one inside the other.
fn same_project(a: &str, b: &str) -> bool {
    let (a, b) = (Path::new(a), Path::new(b));
    inside(a, b) || inside(b, a)
}

/// v1 `ownItem`: the tasks whose items the caller may read or change, of those `items` came from: its own and
/// its project's. The user's own uploads (from no task) don't count.
async fn own_sessions(ctx: &Ctx, s: &Session, items: &[StuffItem]) -> HashSet<String> {
    let mine = project(ctx, s).await;
    let mut ids: Vec<String> = items.iter().filter_map(|it| it.from.as_ref().and_then(|f| f.session.clone())).collect();
    ids.sort();
    ids.dedup();
    let mut out = HashSet::new();
    for id in ids {
        let own = id == s.id.as_str()
            || match task(ctx, &id).await {
                Some(t) => same_project(&project(ctx, &t).await, &mine),
                None => false,
            };
        if own {
            out.insert(id);
        }
    }
    out
}

fn from_session(it: &StuffItem) -> Option<&str> {
    it.from.as_ref().and_then(|f| f.session.as_deref())
}

async fn own_item(ctx: &Ctx, s: &Session, it: &StuffItem) -> bool {
    let mine = own_sessions(ctx, s, std::slice::from_ref(it)).await;
    from_session(it).is_some_and(|id| mine.contains(id))
}

/// `p` against the task's folder, `..` resolved (v1 `path.resolve(workdir(s), p)`).
fn local(cwd: &str, p: &str) -> PathBuf {
    let joined = Path::new(cwd).join(p);
    let mut out = PathBuf::new();
    for c in joined.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

/// v1 `insideFolders`: links followed, so one inside the folder pointing out doesn't get out.
async fn inside_folders(file: &Path, roots: &[String]) -> bool {
    let real = |p: PathBuf| async move { tokio::fs::canonicalize(&p).await.unwrap_or(p) };
    let at = real(file.to_owned()).await;
    for r in roots.iter().filter(|r| !r.is_empty()) {
        if inside(&at, &real(PathBuf::from(r)).await) {
            return true;
        }
    }
    false
}

/// The folders a capped task may hand My Stuff a file from: its own, its other repos', its lead's.
fn folders(s: &Session, lead: &Session) -> Vec<String> {
    let mut out = vec![s.cwd.clone()];
    out.extend(s.dirs.iter().cloned());
    if lead.id != s.id {
        out.push(lead.cwd.clone());
    }
    out
}

pub(crate) fn register(s: &mut Setup, cell: &Cell) {
    let cl = cell.clone();
    s.command::<c::AgentSave, _, _>(move |ctx, call, a| {
        let cell = cl.clone();
        async move {
            let st = state::get(&cell)?;
            let out = save(&st, &ctx, &call, a).await;
            crate::view::publish(&ctx, &st);
            Ok(out)
        }
    });
    let cl = cell.clone();
    s.command::<c::AgentList, _, _>(move |ctx, call, a| {
        let cell = cl.clone();
        async move {
            let st = state::get(&cell)?;
            Ok(list(&st, &ctx, &call, a).await)
        }
    });
}

/// What a capped task is refused before anything is saved, in v1's words.
async fn capped_check(ctx: &Ctx, st: &Stuff, s: &Session, lead: &Session, a: &c::AgentSaveArgs, replace: Option<&str>) -> Option<String> {
    if a.publish.is_some() {
        return Some(capped_refusal("put anything on a public link, or take one down"));
    }
    if let Some(r) = replace {
        // v1 `ownItem`: an item that isn't there is no one's
        let own = match st.shelf.get(r) {
            Some(it) => own_item(ctx, s, &it).await,
            None => false,
        };
        if !own {
            return Some(capped_refusal("change an item of another project"));
        }
    }
    let roots = folders(s, lead);
    for p in [&a.path, &a.app, &a.cover].into_iter().filter_map(|p| given(p.as_ref())) {
        if !inside_folders(&local(&s.cwd, p), &roots).await {
            return Some(capped_refusal("save a file from outside its folder"));
        }
    }
    None
}

#[allow(clippy::many_single_char_names)]
async fn save(st: &Stuff, ctx: &Ctx, call: &Call, a: c::AgentSaveArgs) -> c::AgentText {
    let Some((s, lead)) = caller_and_lead(ctx, call, &a.session).await else { return refused("no such session") };
    let replace = given(a.id.as_ref()).map(str::to_owned);
    if capped(call)
        && let Some(no) = capped_check(ctx, st, &s, &lead, &a, replace.as_deref()).await
    {
        return said(no);
    }
    let n = [&a.path, &a.text, &a.url, &a.app].into_iter().filter(|v| given(v.as_ref()).is_some()).count();
    if n > 1 || (n == 0 && replace.is_none()) {
        return refused(ONE_OF);
    }
    let mut o = SaveOpts {
        fields: Fields::of(a.title.as_deref(), a.note.as_deref(), &a.tags, None),
        by: Some("agent".into()),
        from: from_task(Some((lead.id.as_str(), lead.title.as_str())), None, None),
        replace: replace.clone(),
        ..SaveOpts::default()
    };
    let saved = if n == 0 {
        st.shelf.update(replace.as_deref().unwrap_or_default(), &o.fields).await
    } else if let Some(url) = given(a.url.as_ref()) {
        st.shelf.save_link(url, o).await
    } else if let Some(text) = a.text.as_deref().filter(|t| !t.trim().is_empty()) {
        o.name = given(a.name.as_ref()).or_else(|| given(a.title.as_ref())).map(str::to_owned);
        st.shelf.save_text(text, o).await
    } else {
        let file = local(&s.cwd, given(a.app.as_ref()).or_else(|| given(a.path.as_ref())).unwrap_or_default());
        if tokio::fs::metadata(&file).await.is_err() {
            return refused(format!("Nothing at {}.", file.display()));
        }
        let cover = given(a.cover.as_ref()).map(|p| local(&s.cwd, p));
        if let Some(cv) = &cover
            && tokio::fs::metadata(cv).await.is_err()
        {
            return refused(format!("No picture at {}.", cv.display()));
        }
        if given(a.app.as_ref()).is_some() {
            st.shelf.save_app(&file, cover.as_deref(), o).await
        } else {
            o.name = given(a.name.as_ref()).map(str::to_owned);
            st.shelf.save_file(&file, o).await
        }
    };
    let it = match saved {
        Ok(it) => it,
        Err(e) => return refused(WireError::from(e).message),
    };
    let update = replace.is_some();
    ctx.emit(call, &c::Saved { id: it.id.clone(), session: Some(lead.id.to_string()), by: "agent".into(), kind: it.kind, update });
    crate::routes::track(ctx, "stuff_save", serde_json::json!({ "kind": it.kind, "by": "agent", "update": update }));
    let (it, note) = publishing(st, ctx, call, it, a.publish).await;
    said(save_answer(&it, update, &note))
}

/// `publish`: its public link on the user's wisp Grid, or that link taken down. Saved either way; the note says
/// what happened (or where it's public already).
async fn publishing(st: &Stuff, ctx: &Ctx, call: &Call, it: StuffItem, publish: Option<bool>) -> (StuffItem, String) {
    let on = match publish {
        Some(true) if it.kind == StuffKind::App => true,
        Some(false) if it.published.is_some() => false,
        _ => {
            let note = public_note(&it);
            return (it, note);
        }
    };
    let Ok(p) = ctx.use_service::<c::PublishService>() else {
        let why = "Publishing needs wisp Cloud: sign in first.";
        let note = if on { format!(" It wasn't published: {why} Tell the user.") } else { format!(" It wasn't unpublished: {why}") };
        return (it, note);
    };
    let was = it.published.clone();
    let done = if on { p.publish(call, &it.id, serde_json::json!({})).await } else { p.unpublish(call, &it.id).await };
    match done {
        Ok(x) => {
            // the publisher recorded the link (`stuff.setPublished`): the item as My Stuff has it now
            let x = st.shelf.get(&x.id).unwrap_or(x);
            let note = match (on, &x.published) {
                (true, Some(link)) => {
                    crate::routes::track(ctx, "stuff_publish", serde_json::json!({ "by": "agent", "update": was.is_some() }));
                    published_note(&link.url, was.is_some(), x.db.is_some())
                }
                (true, None) => public_note(&x),
                (false, _) => unpublished_note(&was.map(|w| w.url).unwrap_or_default()),
            };
            (x, note)
        }
        Err(e) if on => (it, format!(" It wasn't published: {} Tell the user.", e.message)),
        Err(e) => (it, format!(" It wasn't unpublished: {}", e.message)),
    }
}

async fn list(st: &Stuff, ctx: &Ctx, call: &Call, a: c::AgentListArgs) -> c::AgentText {
    let Some((s, _)) = caller_and_lead(ctx, call, &a.session).await else { return refused("no such session") };
    let capped = capped(call);
    if let Some(id) = given(a.id.as_ref()) {
        if capped
            && let Some(it) = st.shelf.get(id)
            && !own_item(ctx, &s, &it).await
        {
            return said(capped_refusal("read an item of another project"));
        }
        return match st.shelf.describe(id).await {
            Ok(text) => said(text.unwrap_or_else(|| format!("No item {id} in My Stuff."))),
            Err(e) => refused(WireError::from(e).message),
        };
    }
    let kind = given(a.kind.as_ref()).and_then(|k| serde_json::from_value::<StuffKind>(serde_json::Value::String(k.to_owned())).ok());
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let limit = a.limit.as_f64().filter(|n| *n >= 1.0).map(|n| n as usize);
    let args = c::FindArgs { query: given(a.query.as_ref()).unwrap_or_default().to_owned(), kind, limit };
    let found = if capped {
        let mine = own_sessions(ctx, &s, &st.shelf.list()).await;
        let only = move |it: &StuffItem| from_session(it).is_some_and(|id| mine.contains(id));
        st.shelf.find(&args, Some(&only)).await
    } else {
        st.shelf.find(&args, None).await
    };
    match found {
        Ok(f) => said(f.text),
        Err(e) => refused(WireError::from(e).message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_path_resolves_against_the_task_folder_and_dot_dot_gets_out() {
        assert_eq!(local("/p/task", "a/b.md"), PathBuf::from("/p/task/a/b.md"));
        assert_eq!(local("/p/task", "../x"), PathBuf::from("/p/x"));
        assert_eq!(local("/p/task", "/abs/f"), PathBuf::from("/abs/f"));
        assert!(same_project("/p/task", "/p/task/sub") && !same_project("/p/task", "/p/taskother") && !same_project("", "/p"));
    }
}
