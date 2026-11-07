//! Saving to My Stuff: a file on this computer, bytes (an upload, a picture from elsewhere), text
//! from a reply, a link, an app's folder. Each is a new item, or (with `replace`) the item's new
//! content with the version before kept.

use std::path::Path;

use wisp_stuff_api::{AppManifest, StuffFrom, StuffItem, StuffKind};
use wisp_stuff_core::kind::{MAX_STUFF, kind_of, mime_for, safe_name, texty};
use wisp_stuff_core::make::{self, AppFacts, FileIn, HEAD_BYTES, Origin};
use wisp_stuff_core::record::{Fields, keep};

use crate::appfiles;
use crate::error::{Result, bad};
use crate::shelf::Shelf;

/// Who saves, from where, and the fields they set.
#[derive(Debug, Clone, Default)]
pub struct SaveOpts {
    pub fields: Fields,
    pub by: Option<String>,
    pub from: Option<StuffFrom>,
    pub replace: Option<String>,
    pub name: Option<String>,
    pub mime: Option<String>,
    pub lang: Option<String>,
    /// the file it was copied from
    pub source: Option<String>,
    /// a file copied in may be empty (v1 kept one); a dropped upload may not
    pub allow_empty: bool,
}

/// An app's files before they're saved.
#[derive(Debug, Clone)]
pub struct AppIn {
    /// how the refusals name it (its folder's path)
    pub shown: String,
    /// its folder's name: the title when wisp-app.json has none
    pub folder: String,
    /// wisp-app.json's text ('' when there is none)
    pub manifest: String,
    pub files: Vec<(String, appfiles::Src, u64)>,
    pub source: Option<String>,
}

fn too_big() -> crate::error::Error {
    bad(413, "That file is too big for My Stuff (500 MB at most).")
}

impl Shelf {
    /// Where new content goes: a new id, or the item's own when it's an update.
    fn slot(&self, replace: Option<&str>) -> Result<(Option<StuffItem>, String)> {
        match replace.filter(|r| !r.is_empty()) {
            None => Ok((None, wisp_kernel::ids::uuid7())),
            Some(r) => {
                let old = self.get(r).ok_or_else(|| bad(404, format!("No item {r} in My Stuff: wisp_stuff lists them.")))?;
                let id = old.id.clone();
                Ok((Some(old), id))
            }
        }
    }

    /// The fields on the new content, then the update rule when it replaces an item.
    async fn finish(&self, old: Option<StuffItem>, mut new: StuffItem, o: &SaveOpts, titled: bool) -> Result<StuffItem> {
        o.fields.apply(&mut new);
        let it = match old {
            Some(old) => keep(&old, new, titled, self.now()),
            None => new,
        };
        self.put(it).await
    }

    /// Bytes under a name: an upload, a dropped file, a copy of a file.
    pub async fn save_bytes(&self, bytes: Vec<u8>, o: SaveOpts) -> Result<StuffItem> {
        if bytes.is_empty() && !o.allow_empty {
            return Err(bad(400, "Nothing to save: the file is empty."));
        }
        if bytes.len() as u64 > MAX_STUFF {
            return Err(too_big());
        }
        let name = safe_name(o.name.as_deref().unwrap_or_default(), "file");
        let head = (matches!(kind_of(&name), StuffKind::Doc | StuffKind::Code) && texty(&name)).then(|| String::from_utf8_lossy(&bytes[..bytes.len().min(HEAD_BYTES)]).into_owned());
        let size = bytes.len() as u64;
        let _w = self.write.lock().await;
        let (old, id) = self.slot(o.replace.as_deref())?;
        let blob = self.blobs.put(bytes).await?;
        let f = FileIn { id: &id, name: &name, size, blob: &blob, mime: o.mime.as_deref(), lang: o.lang.as_deref(), head: head.as_deref() };
        let origin = Origin { by: o.by.clone(), from: o.from.clone(), source: o.source.clone() };
        let new = make::file_item(&f, &origin, self.now());
        let titled = o.fields.title.is_some();
        self.finish(old, new, &o, titled).await
    }

    /// A file on this computer, copied in.
    pub async fn save_file(&self, src: &Path, mut o: SaveOpts) -> Result<StuffItem> {
        let st = tokio::fs::metadata(src).await.map_err(|_| bad(404, format!("Nothing at {}.", src.display())))?;
        if !st.is_file() {
            return Err(bad(400, "That’s a folder, not a file: save the files in it one by one, or a zip of it."));
        }
        if st.len() > MAX_STUFF {
            return Err(too_big());
        }
        let bytes = tokio::fs::read(src).await?;
        if o.name.as_deref().is_none_or(str::is_empty) {
            o.name = src.file_name().map(|n| n.to_string_lossy().into_owned());
        }
        o.source = Some(src.to_string_lossy().into_owned());
        o.allow_empty = true;
        self.save_bytes(bytes, o).await
    }

    /// Text from a reply: a document or a snippet. A code block's language picks its extension.
    pub async fn save_text(&self, text: &str, mut o: SaveOpts) -> Result<StuffItem> {
        make::check_text(text)?;
        o.name = Some(make::text_name(o.name.as_deref(), o.lang.as_deref(), o.fields.title.as_deref()));
        self.save_bytes(text.as_bytes().to_vec(), o).await
    }

    /// A link: nothing to copy, just where it goes.
    pub async fn save_link(&self, url: &str, o: SaveOpts) -> Result<StuffItem> {
        let (href, host) = make::parse_link(url)?;
        let _w = self.write.lock().await;
        let (old, id) = self.slot(o.replace.as_deref())?;
        let new = make::link_item(&id, &href, &host, &Origin { by: o.by.clone(), from: o.from.clone(), source: None }, self.now());
        let titled = o.fields.title.is_some();
        self.finish(old, new, &o, titled).await
    }

    /// An app an agent built: its folder, without what a build makes again or secrets. Its
    /// wisp-app.json may name it, its entry (index.html unless it says) and its database.
    pub async fn save_app(&self, src: &Path, cover: Option<&Path>, o: SaveOpts) -> Result<StuffItem> {
        let is_dir = tokio::fs::metadata(src).await.map_err(|_| bad(404, format!("Nothing at {}.", src.display())))?.is_dir();
        if !is_dir {
            return Err(bad(400, "An app is a folder with an index.html (or the entry its wisp-app.json names)."));
        }
        let files = appfiles::walk(src).await?;
        let manifest = tokio::fs::read_to_string(src.join("wisp-app.json")).await.unwrap_or_default();
        let cover = match cover {
            Some(c) => Some(self.cover(c).await?),
            None => None,
        };
        let folder = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let app = AppIn { shown: src.display().to_string(), folder, manifest, files, source: Some(src.to_string_lossy().into_owned()) };
        self.save_app_in(app, cover, o).await
    }

    /// An app from its files (a folder walked, or a starter compiled into wisp).
    pub async fn save_app_in(&self, app: AppIn, cover: Option<(String, String)>, o: SaveOpts) -> Result<StuffItem> {
        let has = |rel: &str| app.files.iter().any(|f| f.0 == rel);
        let m = AppManifest::parse(&app.manifest).map_err(|e| bad(400, e))?;
        let db = m.db_spec(has).map_err(|e| bad(400, e))?;
        if let Some(seed) = db.as_ref().map(|d| d.seed.as_str()).filter(|s| !s.is_empty() && !has(s)) {
            return Err(bad(400, format!("No {seed} in {}: wisp-app.json's \"db\" names it as the seed.", app.shown)));
        }
        make::check_entry(&m.entry, has(&m.entry), &app.shown)?;
        let stored = appfiles::store(self.blobs.as_ref(), app.files).await?;
        let facts = AppFacts {
            folder: app.folder,
            name: m.name.clone(),
            description: m.description.clone(),
            entry: m.entry.clone(),
            db,
            uses: m.uses.clone(),
            tree: stored.tree,
            code: stored.code,
            size: stored.size,
            files: u32::try_from(stored.files.len()).unwrap_or(u32::MAX),
        };
        let _w = self.write.lock().await;
        let (old, id) = self.slot(o.replace.as_deref())?;
        let origin = Origin { by: o.by.clone(), from: o.from.clone(), source: app.source };
        let mut new = make::app_item(&id, &facts, &origin, self.now());
        new.risky = stored.risky.then(|| vec!["webrtc".to_owned()]);
        if let Some((hash, mime)) = cover {
            new.cover = Some(hash);
            new.cover_mime = Some(mime);
        }
        let titled = o.fields.title.is_some() || m.name.is_some();
        self.finish(old, new, &o, titled).await
    }

    /// A picture of an app (the agent's screenshot), for its card.
    async fn cover(&self, src: &Path) -> Result<(String, String)> {
        let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let is_file = tokio::fs::metadata(src).await.map(|m| m.is_file()).unwrap_or(false);
        if kind_of(&name) != StuffKind::Image || !is_file {
            return Err(bad(400, "cover has to be a picture (png, jpg, webp, svg)."));
        }
        let hash = self.blobs.put(tokio::fs::read(src).await?).await?;
        Ok((hash, mime_for(&name, None)))
    }
}
