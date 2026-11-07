//! v1 kept My Stuff, uploads and shots as one `<id>.json` per item beside its file (`~/.wisp/stuff`,
//! `~/.wisp/uploads`) or bare files (`~/.wisp/shots`). Each record comes in as it was, and its files
//! move into the CAS: these plan that, the host reads and writes. Originals stay (plan §4.8: one
//! release writes both, the next archives them).

use serde_json::Value;
use wisp_stuff_api::{StuffItem, StuffKind, Upload};

/// v1 ids are 12 lower-case hex characters (`randomUUID().replace(/-/g, '').slice(0, 12)`).
pub fn v1_record_file(name: &str) -> Option<&str> {
    let id = name.strip_suffix(".json")?;
    (id.len() == 12
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
    .then_some(id)
}

/// What to bring into the CAS for one v1 item: its file (or an app's folder), the version before it,
/// and an app's picture. The host replaces each with a hash.
#[derive(Debug, Clone, PartialEq)]
pub struct V1Plan {
    pub item: StuffItem,
    /// a file's path, or an app's folder (`item.kind == App`)
    pub content: Option<String>,
    pub prev: Option<String>,
    pub cover: Option<String>,
}

/// A v1 record worth keeping: an id and a kind, and (but for a link) a file that's still there.
/// v1's `cover` was a path; v2's is a hash, so it moves to `cover` in the plan.
pub fn v1_item(v: &Value, exists: impl Fn(&str) -> bool) -> Option<V1Plan> {
    let id = v.get("id").and_then(Value::as_str)?;
    let kind = StuffKind::parse(v.get("kind").and_then(Value::as_str)?)?;
    let path = v.get("path").and_then(Value::as_str).map(str::to_owned);
    if kind != StuffKind::Link && !path.as_deref().is_some_and(&exists) {
        return None;
    }
    let cover = v
        .get("cover")
        .and_then(Value::as_str)
        .filter(|p| exists(p))
        .map(str::to_owned);
    let mut raw = v.clone();
    if let Some(o) = raw.as_object_mut() {
        o.remove("cover");
    }
    let mut item: StuffItem = serde_json::from_value(raw).ok()?;
    if item.name.is_empty() {
        item.name = id.to_owned();
    }
    if item.title.is_empty() {
        item.title.clone_from(&item.name);
    }
    if item.by.is_none() {
        item.by = Some("you".into());
    }
    let prev = item
        .prev
        .as_ref()
        .and_then(|p| p.path.clone())
        .filter(|p| exists(p));
    Some(V1Plan {
        item,
        content: path.filter(|_| kind != StuffKind::Link),
        prev,
        cover,
    })
}

/// A v1 upload record: an id and the file it names.
pub fn v1_upload(v: &Value) -> Option<(Upload, String)> {
    let id = v.get("id").and_then(Value::as_str)?.to_owned();
    let path = v.get("path").and_then(Value::as_str)?.to_owned();
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("file")
        .to_owned();
    let mime = v
        .get("mime")
        .and_then(Value::as_str)
        .unwrap_or("application/octet-stream")
        .to_owned();
    let size = v.get("size").and_then(Value::as_u64).unwrap_or(0);
    Some((
        Upload {
            id,
            name,
            mime,
            size,
            blob: None,
            path: None,
        },
        path,
    ))
}

/// A picture or video a v1 turn showed, kept at `~/.wisp/shots/<session>/<turn>-<i>.<ext>`:
/// `(session, file name)` when `rel` is one. Its bytes go into the CAS and the session importer points
/// the turn's block at the hash.
pub fn v1_shot(rel: &str) -> Option<(&str, &str)> {
    let (session, name) = rel.split_once('/')?;
    let ok = matches!(
        crate::kind::kind_of(name),
        StuffKind::Image | StuffKind::Video
    );
    (ok && !session.is_empty() && !name.contains('/')).then_some((session, name))
}
