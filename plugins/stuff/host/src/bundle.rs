//! `stuff.bundle` (v1 bundle.js `packDir`): an app's files as one body for its grid, packed here because the files
//! are My Stuff's. What holds secrets and source maps never goes (`private_file`); the grid drops them again.

use base64::Engine as _;
use serde_json::json;
use wisp_kernel::{Setup, WireError};
use wisp_stuff_api::commands as c;

use crate::state::{self, Cell};

const MAX_FILES: usize = 5000;

/// Each file a 4-byte big-endian length, a JSON header `{path, size}`, and its bytes.
pub fn pack(files: &[(String, Vec<u8>)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (p, data) in files {
        let head = json!({ "path": p, "size": data.len() }).to_string();
        out.extend_from_slice(&u32::try_from(head.len()).unwrap_or(u32::MAX).to_be_bytes());
        out.extend_from_slice(head.as_bytes());
        out.extend_from_slice(data);
    }
    out
}

/// Every file under `dir` (forward-slash paths), but the private ones.
async fn files_of(dir: &std::path::Path) -> std::result::Result<Vec<(String, Vec<u8>)>, WireError> {
    let mut out = Vec::new();
    let mut todo = vec![(dir.to_path_buf(), String::new())];
    while let Some((d, rel)) = todo.pop() {
        let mut rd = tokio::fs::read_dir(&d).await.map_err(|e| WireError::not_found(format!("The app's files: {e}")))?;
        while let Some(e) = rd.next_entry().await.map_err(|e| WireError::internal(e.to_string()))? {
            let name = e.file_name().to_string_lossy().into_owned();
            let r = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            let t = e.file_type().await.map_err(|e| WireError::internal(e.to_string()))?;
            if t.is_dir() {
                todo.push((e.path(), r));
            } else if t.is_file() && !wisp_stuff_api::app::private_file(&r) {
                if out.len() >= MAX_FILES {
                    return Err(WireError::invalid(format!("More than {MAX_FILES} files.")));
                }
                out.push((r, tokio::fs::read(e.path()).await.map_err(|e| WireError::internal(e.to_string()))?));
            }
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

pub(crate) fn register(s: &mut Setup, cell: &Cell) {
    let cell = cell.clone();
    s.command::<c::Bundle, _, _>(move |_ctx, _call, a| {
        let cell = cell.clone();
        async move {
            let st = state::get(&cell)?;
            let it = st.shelf.get(&a.id).ok_or_else(|| WireError::not_found("No such item in My Stuff."))?;
            if it.kind != wisp_stuff_api::StuffKind::App {
                return Err(WireError::invalid("Only an app can be published."));
            }
            let dir = st.shelf.local_path(&it).await.map_err(|e| WireError::internal(e.to_string()))?;
            let files = files_of(std::path::Path::new(&dir)).await?;
            let size = files.iter().map(|f| f.1.len() as u64).sum();
            let body = base64::engine::general_purpose::STANDARD.encode(pack(&files));
            Ok(c::AppBundle {
                title: it.title.clone(),
                entry: it.entry.clone().unwrap_or_else(|| "index.html".into()),
                files: u32::try_from(files.len()).unwrap_or(u32::MAX),
                size,
                body,
            })
        }
    });
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn a_bundle_is_length_header_bytes_per_file() {
        let b = pack(&[("index.html".into(), b"hi".to_vec())]);
        let n = u32::from_be_bytes(b[..4].try_into().unwrap()) as usize;
        let head: serde_json::Value = serde_json::from_slice(&b[4..4 + n]).unwrap();
        assert_eq!((head["path"].as_str(), head["size"].as_u64()), (Some("index.html"), Some(2)));
        assert_eq!(&b[4 + n..], b"hi");
    }
}
