//! The panes wisp ships (v1 server/starters): compiled into the binary, added to My Stuff once (the
//! same item after that), pinned and allowed by you like any app. A copy nobody changed follows the
//! version wisp ships: its wisp-app.json's `was` lists the code hashes wisp shipped before.

use serde::Serialize;
use wisp_stuff_api::{AppManifest, StuffFrom, StuffItem};
use wisp_stuff_core::app::{folder_hash, follows_starter};
use wisp_stuff_core::record::hash_now;

use crate::appfiles::Src;
use crate::error::Result;
use crate::save::{AppIn, SaveOpts};
use crate::shelf::Shelf;

type Files = &'static [(&'static str, &'static [u8])];

pub const STARTERS: &[(&str, Files)] = &[
    (
        "agent-board",
        &[("index.html", include_bytes!("../starters/agent-board/index.html")), ("wisp-app.json", include_bytes!("../starters/agent-board/wisp-app.json"))],
    ),
    (
        "allowance-board",
        &[("index.html", include_bytes!("../starters/allowance-board/index.html")), ("wisp-app.json", include_bytes!("../starters/allowance-board/wisp-app.json"))],
    ),
];

pub fn starter_key(id: &str) -> String {
    format!("starter:{id}")
}

/// A starter as `GET /stuff/starters` lists it (never its `was`: not the page's business).
#[derive(Debug, Clone, Serialize)]
pub struct Starter {
    pub id: String,
    pub name: String,
    pub description: String,
    pub uses: Vec<String>,
    /// the item it was added as, or null
    pub added: Option<String>,
}

pub fn manifest(files: Files) -> AppManifest {
    let raw = files.iter().find(|f| f.0 == "wisp-app.json").map(|f| String::from_utf8_lossy(f.1).into_owned()).unwrap_or_default();
    AppManifest::parse(&raw).unwrap_or_default()
}

/// The hash of what wisp ships now.
pub fn shipped_hash(files: Files) -> String {
    let list: Vec<(&str, &[u8])> = files.to_vec();
    folder_hash(&list, &manifest(files).uses)
}

pub fn list(shelf: &Shelf) -> Vec<Starter> {
    STARTERS
        .iter()
        .map(|(id, files)| {
            let m = manifest(files);
            let added = shelf.find_key(Some(&starter_key(id))).map(|it| it.id);
            Starter { id: (*id).to_owned(), name: m.name.unwrap_or_else(|| (*id).to_owned()), description: m.description.unwrap_or_default(), uses: m.uses, added }
        })
        .collect()
}

fn app_in(id: &str, files: Files) -> AppIn {
    let manifest = files.iter().find(|f| f.0 == "wisp-app.json").map(|f| String::from_utf8_lossy(f.1).into_owned()).unwrap_or_default();
    AppIn {
        shown: format!("wisp's starter {id}"),
        folder: id.to_owned(),
        manifest,
        files: files.iter().map(|(rel, b)| ((*rel).to_owned(), Src::Mem(b), b.len() as u64)).collect(),
        source: None,
    }
}

/// Adds starter `id` (or answers the item it already is). None: wisp has no starter by that name.
/// Returns whether it was added now.
pub async fn add(shelf: &Shelf, id: &str) -> Result<Option<(StuffItem, bool)>> {
    let Some((sid, files)) = STARTERS.iter().find(|(s, _)| *s == id) else { return Ok(None) };
    if let Some(it) = shelf.find_key(Some(&starter_key(sid))) {
        return Ok(Some((it, false)));
    }
    let o = SaveOpts { by: Some("wisp".into()), from: Some(StuffFrom { key: Some(starter_key(sid)), ..StuffFrom::default() }), ..SaveOpts::default() };
    Ok(Some((shelf.save_app_in(app_in(sid, files), None, o).await?, true)))
}

/// A copy follows wisp's newer starter only when nobody changed it, and you didn't go back on
/// purpose. The normal update: rev + 1, prev kept; the title and what you allowed stay.
pub async fn follow(shelf: &Shelf, it: &StuffItem, id: &str, files: Files, was: &[String]) -> Result<Option<StuffItem>> {
    let prev = it.prev.as_ref().and_then(|p| p.code.as_deref().map(|c| wisp_stuff_core::app::app_hash(c, p.uses.as_deref().unwrap_or_default())));
    if !follows_starter(&hash_now(it), prev.as_deref(), was, &shipped_hash(files)) {
        return Ok(None);
    }
    let o = SaveOpts {
        replace: Some(it.id.clone()),
        by: it.by.clone(),
        fields: wisp_stuff_core::record::Fields { title: Some(it.title.clone()), ..Default::default() },
        ..SaveOpts::default()
    };
    shelf.save_app_in(app_in(id, files), None, o).await.map(Some)
}

/// At start: every starter's copies that nobody changed follow. A starter that can't be read never
/// stops wisp.
pub async fn follow_all(shelf: &Shelf) {
    for (id, files) in STARTERS {
        let was = manifest(files).was;
        let Some(it) = shelf.find_key(Some(&starter_key(id))) else { continue };
        if let Err(e) = follow(shelf, &it, id, files, &was).await {
            tracing::warn!(starter = id, error = %e, "starter didn't follow");
        }
    }
}
