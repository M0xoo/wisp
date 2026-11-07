//! Attachments (v1 services/uploads.js): a raw body kept by id, referenced from launches and replies.
//! Its bytes go in the CAS; `path` is a readable copy for harnesses that take a file.

use wisp_stuff_api::Upload;
use wisp_stuff_core::kind::{MAX_STUFF, known_mime};

use crate::error::{Result, bad};
use crate::shelf::Shelf;

/// v1's upload name rule: the base name, odd characters as `_`, the last 120 characters.
pub fn upload_name(name: Option<&str>) -> String {
    let base = name.filter(|n| !n.is_empty()).unwrap_or("file");
    let base = base.rsplit(['/', '\\']).next().unwrap_or_default();
    let mut out = String::new();
    let mut run = false;
    for c in base.chars() {
        if c.is_ascii_alphanumeric() || "_.- ".contains(c) {
            out.push(c);
            run = false;
        } else if !run {
            out.push('_');
            run = true;
        }
    }
    let n = out.chars().count();
    let out: String = out.chars().skip(n.saturating_sub(120)).collect();
    if out.is_empty() { "file".into() } else { out }
}

impl Shelf {
    pub async fn receive_upload(&self, bytes: Vec<u8>, name: Option<&str>, mime: Option<&str>) -> Result<Upload> {
        if bytes.len() as u64 > MAX_STUFF {
            return Err(bad(413, "file too large (500 MB max)"));
        }
        let name = upload_name(name);
        let mime = mime.filter(|m| !m.is_empty()).map(str::to_owned).or_else(|| known_mime(&name).map(str::to_owned)).unwrap_or_else(|| "application/octet-stream".into());
        let size = bytes.len() as u64;
        let blob = self.blobs.put(bytes).await?;
        let u = Upload { id: wisp_kernel::ids::uuid7(), name, mime, size, blob: Some(blob), path: None };
        self.rows.put_upload(u.clone()).await?;
        self.with_path(u).await
    }

    /// The record with a readable path (made once from the CAS).
    async fn with_path(&self, mut u: Upload) -> Result<Upload> {
        if let Some(b) = u.blob.clone() {
            u.path = Some(self.blob_file(&b, &u.name).await?.to_string_lossy().into_owned());
        }
        Ok(u)
    }

    pub async fn upload(&self, id: &str) -> Result<Option<Upload>> {
        match self.rows.upload(id).await? {
            Some(u) => self.with_path(u).await.map(Some),
            None => Ok(None),
        }
    }

    /// Upload ids from a request body → their records; unknown ids are dropped.
    pub async fn uploads(&self, ids: &[String]) -> Result<Vec<Upload>> {
        let mut out = Vec::new();
        for id in ids {
            if let Some(u) = self.upload(id).await? {
                out.push(u);
            }
        }
        Ok(out)
    }

    pub async fn upload_bytes(&self, u: &Upload) -> Result<Option<std::sync::Arc<Vec<u8>>>> {
        match (&u.blob, &u.path) {
            (Some(b), _) => self.blobs.get(b).await,
            (None, Some(p)) => Ok(tokio::fs::read(p).await.ok().map(std::sync::Arc::new)),
            _ => Ok(None),
        }
    }

    pub async fn remove_upload(&self, id: &str) -> Result<bool> {
        self.rows.delete_upload(id).await
    }
}
