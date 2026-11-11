//! Published apps (v1 grid/sites.js, server/bundle.js): an app from someone's My Stuff (static files), put on the
//! grid so anyone with the link opens it, while their wisp sleeps and their computers are off.
//!
//! - **Address:** `<slug>--app--<handle>.<domain>`: three parts, so never a computer (`<name>--<handle>`), and a slug
//!   is never `p<digits>`, so never a preview. Its own origin: the grid sets no cookie there.
//! - **Publish:** `PUT /api/sites/<key>` with a bundle (each file a 4-byte length, a JSON header `{path, size}` and
//!   its bytes), keyed by its item in My Stuff, so publishing again updates the same link. A new version is unpacked
//!   beside the old one and swapped in, so a visitor never sees half of one. Secrets and source maps are dropped on
//!   receipt whatever the client sent, and no dotfile is ever served (but `.well-known` at the top).
//! - **Caps:** `perUser` apps, `maxBytes` a bundle (the edge refuses a bigger body).
//!
//! Not here yet: an app's own database (`/_wisp/…`, v1 app-db.js); a request there answers 404.

use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

use crate::clock::SharedClock;
use crate::db::Db;
use crate::error::{Result, bad};
use crate::rows::{SiteRow, UserRow};

pub const MAX_BYTES: i64 = 50 * 1024 * 1024;
pub const PER_USER: i64 = 20;
const MAX_FILES: usize = 5000;
const HEADER_MAX: usize = 2048;

// ---------- the bundle (server/bundle.js) ----------

fn segments(rel: &str) -> Vec<String> {
    rel.to_lowercase().split(['/', '\\']).map(str::to_owned).collect()
}

fn env_name(n: &str) -> bool {
    n == ".env" || n.starts_with(".env.")
}

/// A file that never goes in an app, saved or published: what holds secrets, and source maps.
pub fn private_file(rel: &str) -> bool {
    let mut dirs = segments(rel);
    let name = dirs.pop().unwrap_or_default();
    let ends = |exts: &[&str]| exts.iter().any(|e| name.ends_with(e));
    let secret = env_name(&name)
        || name.ends_with(".env")
        || name == ".envrc"
        || name.trim_start_matches('.').starts_with("credentials") && (name.trim_start_matches('.') == "credentials" || ends(&[".json", ".yml", ".yaml", ".toml", ".ini", ".txt", ".csv", ".xml"]))
        || name.starts_with("client_secret") && name.ends_with(".json")
        || (name.starts_with("service-account") || name.starts_with("service_account") || name.starts_with("serviceaccount")) && name.ends_with(".json")
        || ["secret.json", "secrets.json", "secret.yml", "secrets.yml", "secret.yaml", "secrets.yaml", "secret.toml", "secrets.toml"].contains(&name.as_str())
        || [".npmrc", ".netrc", ".pgpass", ".pypirc", ".htpasswd", ".git-credentials", ".dockercfg"].contains(&name.as_str())
        || ends(&[".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".ppk", ".map"])
        || ["id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"].contains(&name.as_str());
    secret || dirs.iter().any(|d| env_name(d))
}

/// May a visitor open this file: nothing private and no dotfile, but `.well-known` at the top.
pub fn public_file(rel: &str) -> bool {
    !private_file(rel) && segments(rel).iter().enumerate().all(|(i, s)| !s.starts_with('.') || (i == 0 && s == ".well-known"))
}

/// A file's path from a bundle, or None when it would land outside the folder.
pub fn bundle_path(p: &str) -> Option<String> {
    if p.is_empty() || p.len() > 400 || p.starts_with('/') || p.chars().any(|c| c.is_control() || c == '\\') {
        return None;
    }
    p.split('/').all(|x| !x.is_empty() && x != "." && x != "..").then(|| p.to_owned())
}

/// Writes a bundle into `dir` (made), leaving out what `skip` names. → (files, bytes) written.
pub fn unpack(buf: &[u8], dir: &Path, skip: &dyn Fn(&str) -> bool) -> std::result::Result<(usize, u64), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let (mut at, mut files, mut size) = (0usize, 0usize, 0u64);
    while at < buf.len() {
        let len4: [u8; 4] = buf.get(at..at + 4).and_then(|b| b.try_into().ok()).ok_or("The bundle ends early.")?;
        let n = u32::from_be_bytes(len4) as usize;
        at += 4;
        if n > HEADER_MAX || at + n > buf.len() {
            return Err("A file header in the bundle is broken.".into());
        }
        let head: Value = serde_json::from_slice(&buf[at..at + n]).map_err(|_| "A file header in the bundle is broken.")?;
        at += n;
        let raw = head.get("path").and_then(Value::as_str).unwrap_or_default();
        let len = head.get("size").and_then(Value::as_u64).and_then(|l| usize::try_from(l).ok());
        let (Some(rel), Some(len)) = (bundle_path(raw), len) else { return Err(format!("The bundle has a bad file: {}", raw.chars().take(80).collect::<String>())) };
        if at + len > buf.len() {
            return Err(format!("The bundle has a bad file: {}", rel.chars().take(80).collect::<String>()));
        }
        if skip(&rel) {
            at += len;
            continue;
        }
        files += 1;
        if files > MAX_FILES {
            return Err(format!("More than {MAX_FILES} files."));
        }
        let file = rel.split('/').fold(dir.to_path_buf(), |p, s| p.join(s));
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        // create_new: a bundle naming one file twice can't overwrite it
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(&file).map_err(|e| e.to_string())?;
        std::io::Write::write_all(&mut f, &buf[at..at + len]).map_err(|e| e.to_string())?;
        at += len;
        size += len as u64;
    }
    Ok((files, size))
}

/// One file as a bundle (for tests and wisp's own publish).
pub fn pack(files: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    for (p, data) in files {
        let head = json!({ "path": p, "size": data.len() }).to_string();
        out.extend_from_slice(&u32::try_from(head.len()).unwrap_or(u32::MAX).to_be_bytes());
        out.extend_from_slice(head.as_bytes());
        out.extend_from_slice(data);
    }
    out
}

// ---------- names and files ----------

/// "My Slides!" → "my-slides": a DNS label part, never a preview's `p<port>`.
pub fn site_slug(title: &str) -> String {
    let mut s = String::new();
    for c in title.to_lowercase().chars() {
        let c = match c {
            'à'..='å' => 'a',
            'è'..='ë' => 'e',
            'ì'..='ï' => 'i',
            'ò'..='ö' => 'o',
            'ù'..='ü' => 'u',
            'ç' => 'c',
            'ñ' => 'n',
            c => c,
        };
        if c.is_ascii_alphanumeric() {
            s.push(c);
        } else if !s.ends_with('-') {
            s.push('-');
        }
    }
    let s: String = s.trim_matches('-').chars().take(24).collect::<String>().trim_end_matches('-').to_owned();
    let s = if s.is_empty() { "app".to_owned() } else { s };
    if s.len() > 1 && s.starts_with('p') && s[1..].bytes().all(|b| b.is_ascii_digit()) { format!("{s}-app") } else { s }
}

/// `<slug>--app--<handle>`.
pub fn is_site_label(label: &str) -> bool {
    label.split_once("--app--").is_some_and(|(a, b)| {
        let ok = |x: &str| !x.is_empty() && x.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-');
        ok(a) && ok(b)
    })
}

fn valid_key(k: &str) -> bool {
    (1..=64).contains(&k.len()) && k.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The file a request path names in the app: inside its folder only; `/` is its entry, a folder its
/// index.html; a file a visitor may not open is none.
pub fn app_file(root: &Path, url_path: &str, entry: &str) -> Option<PathBuf> {
    let p = percent_decode(url_path.split('?').next().unwrap_or_default())?;
    let p = if p.is_empty() || p == "/" { format!("/{entry}") } else { p };
    let mut rel = PathBuf::new();
    for c in Path::new(p.trim_start_matches('/')).components() {
        match c {
            Component::Normal(x) => rel.push(x),
            Component::CurDir => {}
            _ => return None,
        }
    }
    let rel_s = rel.to_string_lossy().replace('\\', "/");
    if !rel_s.is_empty() && !public_file(&rel_s) {
        return None;
    }
    let file = root.join(&rel);
    let meta = std::fs::metadata(&file).ok()?;
    if meta.is_file() {
        return Some(file);
    }
    let index = file.join("index.html");
    (meta.is_dir() && index.is_file()).then_some(index)
}

fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let h = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(h, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// A content type by extension (v1 `typeOf`).
pub fn type_of(file: &Path) -> &'static str {
    match file.extension().and_then(|e| e.to_str()).map(str::to_lowercase).as_deref() {
        Some("html" | "htm") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("avif") => "image/avif",
        Some("ico") => "image/x-icon",
        Some("txt" | "md") => "text/plain; charset=utf-8",
        Some("csv") => "text/csv; charset=utf-8",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("wasm") => "application/wasm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("ogg") => "audio/ogg",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("pdf") => "application/pdf",
        Some("xml") => "application/xml",
        Some("webmanifest") => "application/manifest+json",
        _ => "application/octet-stream",
    }
}

// ---------- the store ----------

/// What one site's request gets back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Served {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

pub struct Sites {
    db: Arc<Db>,
    clock: SharedClock,
    root: PathBuf,
    pub enabled: bool,
    pub max_bytes: i64,
    pub per_user: i64,
    /// a label's https URL (`GridConfig::instance_url`)
    url_of: Arc<dyn Fn(&str) -> String + Send + Sync>,
}

impl std::fmt::Debug for Sites {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Sites").field("root", &self.root).field("enabled", &self.enabled).finish_non_exhaustive()
    }
}

fn hex(n: usize) -> String {
    (0..n).map(|_| format!("{:02x}", rand::random::<u8>())).collect()
}

impl Sites {
    pub fn new(db: Arc<Db>, clock: SharedClock, data_dir: &Path, cfg: Option<&crate::config::FeatureConfig>, url_of: Arc<dyn Fn(&str) -> String + Send + Sync>) -> Self {
        Self {
            db,
            clock,
            root: data_dir.join("sites"),
            enabled: cfg.and_then(|c| c.enabled).unwrap_or(true),
            max_bytes: cfg.and_then(|c| c.max_bytes).unwrap_or(MAX_BYTES),
            per_user: cfg.and_then(|c| c.per_user).unwrap_or(PER_USER),
            url_of,
        }
    }

    fn dir_of(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }

    pub fn view(&self, s: &SiteRow) -> Value {
        json!({ "key": s.key, "title": s.title, "url": format!("{}/", (self.url_of)(&s.label)), "files": s.files, "size": s.size, "createdAt": s.created_at, "updatedAt": s.updated_at })
    }

    pub fn list(&self, user_id: &str) -> Result<Vec<SiteRow>> {
        self.db.with(|c| c.prepare_cached("SELECT * FROM sites WHERE user_id = ?1 ORDER BY updated_at DESC")?.query_map([user_id], SiteRow::from_row)?.collect())
    }

    fn own(&self, user_id: &str, key: &str) -> Result<Option<SiteRow>> {
        self.db.with(|c| c.prepare_cached("SELECT * FROM sites WHERE user_id = ?1 AND key = ?2")?.query_row(params![user_id, key], SiteRow::from_row).optional())
    }

    pub fn by_label(&self, label: &str) -> Result<Option<SiteRow>> {
        if !is_site_label(&label.to_lowercase()) {
            return Ok(None);
        }
        self.db.with(|c| crate::rows::find::site_by_label(c, &label.to_lowercase()))
    }

    /// Publish (or update) the app keyed `key` from a bundle.
    pub fn publish(&self, user: &UserRow, key: &str, buf: &[u8], title: &str, entry: &str) -> Result<Value> {
        if !self.enabled {
            return Err(bad("This grid doesn’t publish apps.", 403));
        }
        if !valid_key(key) {
            return Err(bad("Bad app key.", 400));
        }
        if i64::try_from(buf.len()).unwrap_or(i64::MAX) > self.max_bytes {
            return Err(bad(format!("That app is too big to publish here ({} MB at most).", self.max_bytes / 1024 / 1024), 413));
        }
        let name: String = title.split_whitespace().collect::<Vec<_>>().join(" ").chars().take(140).collect();
        let name = if name.is_empty() { "App".to_owned() } else { name };
        let start = if entry.trim_start_matches('/').is_empty() { "index.html".to_owned() } else { entry.trim_start_matches('/').to_owned() };
        let have = self.own(&user.id, key)?;
        if have.is_none() {
            let n: i64 = self.db.with(|c| c.query_row("SELECT count(*) FROM sites WHERE user_id = ?1", [&user.id], |r| r.get(0)))?;
            if n >= self.per_user {
                return Err(bad(format!("You have {} published apps, as many as this grid keeps. Unpublish one first.", self.per_user), 409));
            }
        }
        let id = have.as_ref().map_or_else(|| hex(6), |h| h.id.clone());
        let tmp = self.root.join(format!("{id}.new-{}", hex(3)));
        let got = unpack(buf, &tmp, &private_file).map_err(|e| {
            let _ = std::fs::remove_dir_all(&tmp);
            bad(e, 400)
        })?;
        if got.0 == 0 || app_file(&tmp, "/", &start).is_none() {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(bad(format!("No {start} in the app."), 400));
        }
        // swap it in: the old version moves aside, the new one takes its name, the old one goes
        let dir = self.dir_of(&id);
        let old = self.root.join(format!("{id}.old-{}", hex(3)));
        if dir.exists() {
            std::fs::rename(&dir, &old)?;
        }
        if let Err(e) = std::fs::rename(&tmp, &dir) {
            if old.exists() {
                let _ = std::fs::rename(&old, &dir);
            }
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(e.into());
        }
        let _ = std::fs::remove_dir_all(&old);
        let t = self.clock.now_ms();
        let (files, size) = (i64::try_from(got.0).unwrap_or(i64::MAX), i64::try_from(got.1).unwrap_or(i64::MAX));
        if let Some(h) = have {
            self.db.with(|c| c.execute("UPDATE sites SET title = ?1, entry = ?2, files = ?3, size = ?4, updated_at = ?5 WHERE id = ?6", params![name, start, files, size, t, id]))?;
            return Ok(self.view(&SiteRow { title: name, entry: start, files, size, updated_at: t, ..h }));
        }
        let slug = site_slug(&name);
        let mut label = format!("{slug}--app--{}", user.handle);
        let mut k = 2;
        while self.db.with(|c| crate::rows::find::site_by_label(c, &label))?.is_some() {
            label = format!("{slug}-{k}--app--{}", user.handle);
            k += 1;
        }
        let row = SiteRow { id, user_id: user.id.clone(), key: key.to_owned(), label, title: name, entry: start, files, size, db: None, created_at: t, updated_at: t };
        self.db.with(|c| {
            c.execute(
                "INSERT INTO sites (id, user_id, key, label, title, entry, files, size, db, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9, ?9)",
                params![row.id, row.user_id, row.key, row.label, row.title, row.entry, row.files, row.size, t],
            )
        })?;
        Ok(self.view(&row))
    }

    /// Unpublish: its row and its files. false: no app by that key.
    pub fn remove(&self, user_id: &str, key: &str) -> Result<bool> {
        let Some(s) = self.own(user_id, key)? else { return Ok(false) };
        self.db.with(|c| c.execute("DELETE FROM sites WHERE id = ?1", [&s.id]))?;
        let _ = std::fs::remove_dir_all(self.dir_of(&s.id));
        Ok(true)
    }

    /// An account going: its files (its rows go with it, ON DELETE CASCADE).
    pub fn remove_all(&self, user_id: &str) -> Result<()> {
        for s in self.list(user_id)? {
            let _ = std::fs::remove_dir_all(self.dir_of(&s.id));
        }
        self.db.with(|c| c.execute("DELETE FROM sites WHERE user_id = ?1", [user_id]))?;
        Ok(())
    }

    /// Anyone's request to a published app: its files, read-only.
    pub fn serve(&self, method: &str, path: &str, s: &SiteRow) -> Served {
        // kept out of search engines; the edge sets no cookie on a site's origin
        let mut headers = vec![("x-content-type-options", "nosniff".to_owned()), ("referrer-policy", "strict-origin-when-cross-origin".to_owned()), ("x-robots-tag", "noindex, nofollow".to_owned())];
        if method != "GET" && method != "HEAD" {
            headers.push(("allow", "GET, HEAD".into()));
            return Served { status: 405, headers, body: Vec::new() };
        }
        let file = (!path.starts_with("/_wisp/")).then(|| app_file(&self.dir_of(&s.id), path, &s.entry)).flatten();
        let Some(file) = file else {
            headers.push(("content-type", "text/plain; charset=utf-8".into()));
            headers.push(("cache-control", "no-store".into()));
            return Served { status: 404, headers, body: b"Not found in this app.".to_vec() };
        };
        let body = std::fs::read(&file).unwrap_or_default();
        headers.push(("content-type", type_of(&file).into()));
        headers.push(("cache-control", "public, max-age=60".into()));
        Served { status: 200, headers, body: if method == "HEAD" { Vec::new() } else { body } }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests;
