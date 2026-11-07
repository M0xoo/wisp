//! The v1 import (plan §4.8): `~/.wisp/stuff/<id>.json` items, `~/.wisp/uploads/<id>.json`
//! attachments and `~/.wisp/shots/<session>/*` pictures. Records keep their ids, so links, pins and
//! grants still point at them; their files move into the CAS (an app's code hash is v1's, so a grant
//! allowed in v1 still holds). The originals stay. Runs once at start, in the background; an item
//! already here is skipped, so a stopped import just picks up where it was.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use wisp_stuff_api::{StuffContent, StuffItem, StuffKind};
use wisp_stuff_core::import_v1::{v1_item, v1_record_file, v1_shot, v1_upload};
use wisp_stuff_core::kind::mime_for;

use crate::appfiles;
use crate::error::Result;
use crate::shelf::Shelf;

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    pub items: usize,
    pub uploads: usize,
    pub shots: usize,
    pub skipped: usize,
}

async fn records(dir: &Path) -> Vec<(String, serde_json::Value)> {
    let mut out = Vec::new();
    let Ok(mut rd) = tokio::fs::read_dir(dir).await else { return out };
    while let Ok(Some(e)) = rd.next_entry().await {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(id) = v1_record_file(&name) else { continue };
        if let Ok(b) = tokio::fs::read(e.path()).await
            && let Ok(v) = serde_json::from_slice(&b)
        {
            out.push((id.to_owned(), v));
        }
    }
    out
}

/// What exists on disk, asked before the pure plan (the import runs at start).
async fn existing(v: &serde_json::Value) -> HashMap<String, bool> {
    let mut m = HashMap::new();
    let mut paths = vec![v.get("path"), v.get("cover"), v.get("prev").and_then(|p| p.get("path"))];
    paths.retain(Option::is_some);
    for p in paths.into_iter().flatten().filter_map(serde_json::Value::as_str) {
        m.insert(p.to_owned(), tokio::fs::try_exists(p).await.unwrap_or(false));
    }
    m
}

/// A file's or an app's content into the CAS.
async fn ingest(shelf: &Shelf, kind: StuffKind, path: &str, c: &mut StuffContent) -> Result<()> {
    if kind == StuffKind::App {
        let stored = appfiles::store(shelf.blobs.as_ref(), appfiles::walk(Path::new(path)).await?).await?;
        c.tree = Some(stored.tree);
        c.code = Some(stored.code);
        c.risky = stored.risky.then(|| vec!["webrtc".to_owned()]);
    } else {
        c.blob = Some(shelf.blobs.put(tokio::fs::read(path).await?).await?);
    }
    c.path = None;
    Ok(())
}

fn as_content(it: &StuffItem) -> StuffContent {
    wisp_stuff_core::record::content(it)
}

fn put_back(it: &mut StuffItem, c: StuffContent) {
    it.blob = c.blob;
    it.tree = c.tree;
    it.code = c.code;
    it.risky = c.risky;
    it.path = c.path;
}

pub async fn import_stuff(shelf: &Shelf, dir: &Path, r: &mut Report) {
    for (id, v) in records(dir).await {
        if shelf.get(&id).is_some() {
            r.skipped += 1;
            continue;
        }
        let ex = existing(&v).await;
        let Some(plan) = v1_item(&v, |p| ex.get(p).copied().unwrap_or(false)) else {
            r.skipped += 1;
            continue;
        };
        let mut it = plan.item;
        if let Err(e) = bring(shelf, &mut it, plan.content.as_deref(), plan.prev.as_deref(), plan.cover.as_deref()).await {
            tracing::warn!(item = %id, error = %e, "v1 item not imported");
            r.skipped += 1;
            continue;
        }
        if shelf.put(it).await.is_ok() {
            r.items += 1;
        }
    }
}

async fn bring(shelf: &Shelf, it: &mut StuffItem, content: Option<&str>, prev: Option<&str>, cover: Option<&str>) -> Result<()> {
    if let Some(p) = content {
        let mut c = as_content(it);
        ingest(shelf, it.kind, p, &mut c).await?;
        put_back(it, c);
    }
    if let Some(prev_item) = it.prev.as_deref_mut() {
        match prev {
            Some(p) => ingest(shelf, prev_item.kind, p, prev_item).await?,
            // its file is gone: there is no version to go back to
            None => it.prev = None,
        }
    }
    if let Some(c) = cover {
        it.cover = Some(shelf.blobs.put(tokio::fs::read(c).await?).await?);
        it.cover_mime = Some(mime_for(c, None));
    }
    Ok(())
}

pub async fn import_uploads(shelf: &Shelf, dir: &Path, r: &mut Report) {
    for (id, v) in records(dir).await {
        if matches!(shelf.rows.upload(&id).await, Ok(Some(_))) {
            r.skipped += 1;
            continue;
        }
        let Some((mut u, path)) = v1_upload(&v) else { continue };
        let Ok(bytes) = tokio::fs::read(&path).await else {
            r.skipped += 1;
            continue;
        };
        u.size = bytes.len() as u64;
        if let Ok(b) = shelf.blobs.put(bytes).await {
            u.blob = Some(b);
            if shelf.rows.put_upload(u).await.is_ok() {
                r.uploads += 1;
            }
        }
    }
}

/// Every kept picture into the CAS: `<session>/<file>` → its hash, for the session importer.
pub async fn import_shots(shelf: &Shelf, dir: &Path, r: &mut Report) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(mut sessions) = tokio::fs::read_dir(dir).await else { return out };
    while let Ok(Some(s)) = sessions.next_entry().await {
        let session = s.file_name().to_string_lossy().into_owned();
        let Ok(mut rd) = tokio::fs::read_dir(s.path()).await else { continue };
        while let Ok(Some(f)) = rd.next_entry().await {
            let rel = format!("{session}/{}", f.file_name().to_string_lossy());
            if v1_shot(&rel).is_none() {
                continue;
            }
            if let Ok(b) = tokio::fs::read(f.path()).await
                && let Ok(h) = shelf.blobs.put(b).await
            {
                out.insert(rel, h);
                r.shots += 1;
            }
        }
    }
    out
}

/// All of it, from `home` (`~/.wisp`).
pub async fn import_all(shelf: &Shelf, home: &Path) -> (Report, HashMap<String, String>) {
    let mut r = Report::default();
    import_stuff(shelf, &home.join("stuff"), &mut r).await;
    import_uploads(shelf, &home.join("uploads"), &mut r).await;
    let shots = import_shots(shelf, &home.join("shots"), &mut r).await;
    (r, shots)
}

pub fn home_of(stuff_dir: &Path) -> PathBuf {
    stuff_dir.parent().map_or_else(|| stuff_dir.to_path_buf(), Path::to_path_buf)
}
