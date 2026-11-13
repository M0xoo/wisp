//! An item's record and what happens to it: the fields you may set, an update that keeps the version
//! before, Restore, the grant an update shrinks, the page's view and the agent's search. Pure: the
//! host passes the time and whatever it read.

use serde_json::Value;
use wisp_stuff_api::pane::{effective_grant, grant_of, is_write};
use wisp_stuff_api::{Grant, PrevView, Running, StuffContent, StuffItem, StuffKind, StuffView};

use crate::Bad;
use crate::kind::{clip, cut};

/// The fields a person (or an agent) may set on an item; None leaves one as it is.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Fields {
    pub title: Option<String>,
    pub note: Option<String>,
    pub tags: Option<Vec<String>>,
    pub starred: Option<bool>,
}

impl Fields {
    /// v1 `fields()`: a title is one line of at most 140 characters (blank: not given), a note at
    /// most 2000, tags normalised.
    pub fn of(title: Option<&str>, note: Option<&str>, tags: &Value, starred: Option<bool>) -> Self {
        Self {
            title: title.filter(|t| !t.trim().is_empty()).map(|t| clip(t, 140)),
            note: note.map(|n| cut(n.trim(), 2000)),
            tags: (!tags.is_null()).then(|| crate::kind::normalize_tags(tags)),
            starred,
        }
    }

    pub fn apply(&self, it: &mut StuffItem) {
        if let Some(t) = &self.title {
            it.title.clone_from(t);
        }
        if let Some(n) = &self.note {
            it.note = Some(n.clone());
        }
        if let Some(t) = &self.tags {
            it.tags = Some(t.clone());
        }
        if let Some(s) = self.starred {
            it.starred = Some(s);
        }
    }
}

/// What makes up an item's content (the rest is yours: title, note, tags, star, where it's from).
pub fn content(it: &StuffItem) -> StuffContent {
    StuffContent {
        kind: it.kind,
        name: it.name.clone(),
        mime: it.mime.clone(),
        size: it.size,
        blob: it.blob.clone(),
        tree: it.tree.clone(),
        code: it.code.clone(),
        path: it.path.clone(),
        source: it.source.clone(),
        lang: it.lang.clone(),
        excerpt: it.excerpt.clone(),
        url: it.url.clone(),
        entry: it.entry.clone(),
        files: it.files,
        db: it.db.clone(),
        uses: it.uses.clone(),
        risky: it.risky.clone(),
        by: it.by.clone(),
        at: it.updated_at.unwrap_or(it.at),
    }
}

fn put_content(it: &mut StuffItem, c: StuffContent) {
    it.kind = c.kind;
    it.name = c.name;
    it.mime = c.mime;
    it.size = c.size;
    it.blob = c.blob;
    it.tree = c.tree;
    it.code = c.code;
    it.path = c.path;
    it.source = c.source;
    it.lang = c.lang;
    it.excerpt = c.excerpt;
    it.url = c.url;
    it.entry = c.entry;
    it.files = c.files;
    it.db = c.db;
    it.uses = c.uses;
    it.risky = c.risky;
    it.by = c.by;
}

/// An update (or Restore) may ask for less: what you allowed shrinks with it, a new ask waits for you,
/// and a grant with no write scope left has no code hash to be tied to.
pub fn prune_grant(it: &mut StuffItem) {
    let uses = it.uses.clone().unwrap_or_default();
    if uses.is_empty() {
        it.uses = None;
    }
    let allowed = grant_of(&uses, it.allowed.as_deref().unwrap_or_default());
    if !allowed.iter().any(|x| is_write(x)) {
        it.grant_hash = None;
    }
    it.allowed = (!allowed.is_empty()).then_some(allowed);
}

/// The new content `new` for item `old` (`wisp_save` with its id): same id, place, star, note, tags,
/// picture and grant; the content before kept as the one previous version. `titled`: `new`'s title
/// was given (not made from its file name), so it replaces the old one.
pub fn keep(old: &StuffItem, new: StuffItem, titled: bool, now: i64) -> StuffItem {
    let mut next = old.clone();
    let was = content(old);
    let title = if titled { new.title.clone() } else { old.title.clone() };
    put_content(&mut next, content(&new));
    if new.cover.is_some() {
        next.cover.clone_from(&new.cover);
        next.cover_mime.clone_from(&new.cover_mime);
    }
    Fields { title: None, note: new.note, tags: new.tags, starred: new.starred }.apply(&mut next);
    next.title = title;
    next.updated_at = Some(now);
    next.rev = Some(old.rev.unwrap_or(1) + 1);
    next.prev = Some(Box::new(was));
    prune_grant(&mut next);
    next
}

/// Swap an item with its previous version.
pub fn restore(it: &StuffItem, now: i64) -> Result<StuffItem, Bad> {
    let Some(prev) = it.prev.as_deref() else {
        return Err(Bad::new(404, "There’s no earlier version of that."));
    };
    let mut back = it.clone();
    put_content(&mut back, prev.clone());
    back.updated_at = Some(now);
    back.rev = Some(it.rev.unwrap_or(1) + 1);
    back.prev = Some(Box::new(content(it)));
    prune_grant(&mut back);
    Ok(back)
}

/// What an app may use now. The code hash only counts for an app holding a write scope; `hash_now`
/// is its code as it is (`""`: unknown, so a write grant is off).
pub fn grant(it: &StuffItem, hash_now: &str) -> Grant {
    effective_grant(it.allowed.as_deref().unwrap_or_default(), it.grant_hash.as_deref().unwrap_or_default(), hash_now)
}

/// The app's grant hash as its content is now: its code (immutable in the CAS) and its uses.
pub fn hash_now(it: &StuffItem) -> String {
    it.code.as_deref().map_or_else(String::new, |c| crate::app::app_hash(c, it.uses.as_deref().unwrap_or_default()))
}

/// What an app may use now, by its own content.
pub fn current_grant(it: &StuffItem) -> Grant {
    grant(it, &hash_now(it))
}

/// Facts the host knows about an item when it draws the page's view.
#[derive(Debug, Clone, Default)]
pub struct ViewFacts {
    pub grant: Option<Grant>,
    /// an app with a database has data in it (Reset data)
    pub data: bool,
    pub running: Option<u16>,
}

/// What the page sees: no paths or hashes, the grant as it holds now.
pub fn view(it: &StuffItem, f: &ViewFacts) -> StuffView {
    let g = f.grant.clone().unwrap_or_else(|| current_grant(it));
    StuffView {
        id: it.id.clone(),
        kind: it.kind,
        name: it.name.clone(),
        title: it.title.clone(),
        mime: it.mime.clone(),
        size: it.size,
        at: it.at,
        by: it.by.clone().unwrap_or_else(|| "you".into()),
        lang: it.lang.clone(),
        excerpt: it.excerpt.clone(),
        url: it.url.clone(),
        entry: it.entry.clone(),
        files: it.files,
        uses: it.uses.clone(),
        from: it.from.clone(),
        note: it.note.clone(),
        tags: it.tags.clone(),
        starred: it.starred,
        rev: it.rev,
        updated_at: it.updated_at,
        published: it.published.clone(),
        allowed: (!g.allowed.is_empty()).then_some(g.allowed),
        changed: g.changed.then_some(true),
        risky: it.risky.clone().filter(|r| !r.is_empty() && it.uses.as_ref().is_some_and(|u| !u.is_empty())),
        prev: it.prev.as_ref().map(|p| PrevView { at: p.at, size: Some(p.size), by: p.by.clone() }),
        cover: it.cover.as_ref().map(|_| true),
        db: it.db.as_ref().map(|_| true),
        data: it.db.as_ref().map(|_| f.data),
        running: if it.kind == StuffKind::App { f.running.map(|port| Running { port }) } else { None },
    }
}

/// Every word of `query` is in the item's words (`#tag` matches the tag); `kind` filters.
pub fn matches(it: &StuffItem, query: &str, kind: Option<StuffKind>) -> bool {
    if kind.is_some_and(|k| k != it.kind) {
        return false;
    }
    let from = it.from.as_ref().and_then(|f| f.title.as_deref()).unwrap_or_default();
    let app = if it.kind == StuffKind::App { format!("app {}", it.excerpt.as_deref().unwrap_or_default()) } else { String::new() };
    let tags = it.tags.as_deref().unwrap_or_default().join(" ");
    let hay = format!(
        "{} {} {} {} {} {} {}",
        it.title,
        it.name,
        it.note.as_deref().unwrap_or_default(),
        tags,
        from,
        it.url.as_deref().unwrap_or_default(),
        app
    )
    .to_lowercase();
    query.to_lowercase().split_whitespace().all(|w| hay.contains(w.trim_start_matches('#')))
}

/// Newest first; the same `at` keeps the later id first (ids are time-sortable).
pub fn sort_newest(items: &mut [StuffItem]) {
    items.sort_by(|a, b| b.at.cmp(&a.at).then_with(|| b.id.cmp(&a.id)));
}

/// Where an item came from: the task (its title as it was then) and the turn, plus the page's key
/// for "already saved" (at most 300 characters).
pub fn from_task(task: Option<(&str, &str)>, turn: Option<&str>, key: Option<&str>) -> Option<wisp_stuff_api::StuffFrom> {
    let key = key.filter(|k| !k.is_empty()).map(|k| k.chars().take(300).collect::<String>());
    match task {
        None => key.map(|k| wisp_stuff_api::StuffFrom { key: Some(k), ..Default::default() }),
        Some((id, title)) => Some(wisp_stuff_api::StuffFrom {
            session: Some(id.to_owned()),
            title: Some(title.to_owned()),
            turn: turn.map(str::to_owned),
            key,
        }),
    }
}
