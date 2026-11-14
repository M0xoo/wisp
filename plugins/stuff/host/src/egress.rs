//! wisp.stuff's view of its own rows as they leave (ADR-0054, the `kernel.egress` point), on the `stuff` topic. An
//! item an agent saved from a task (`from.session`) carries what it wrote and what it kept of the file (title, note,
//! excerpt, tags, the version before's excerpt): those go through wisp.runtime's `runtime.envmask@1`, masked against
//! the .env values that task read, hidden when those can't be told or wisp.runtime is off (fail closed). An item no
//! task made (your own upload) is yours: as it is. Both the stored item (`stuff_item`, its `body`) and the page's
//! row (`stuff.item`, flat). The store keeps them as they are.

use serde_json::Value;
use wisp_kernel::Ctx;
use wisp_kernel::egress::RowView;
use wisp_runtime_api::env::{EnvMask, EnvMaskService, mask_or_hide};

use crate::store::ITEM;
use crate::view::VIEW;

/// An item's fields an agent wrote, or that hold what it kept of a file.
const TEXT: &[&str] = &["/title", "/note", "/excerpt", "/tags", "/source", "/from/title", "/prev/excerpt"];

pub(crate) struct View(pub(crate) Ctx);

/// An item (`stuff_item`'s body, or a `stuff.item` row) masked against the task it came from (`m` `None`: hidden).
pub(crate) fn mask_item(m: Option<&dyn EnvMask>, item: &mut Value) -> bool {
    let Some(task) = item.pointer("/from/session").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned) else {
        return false;
    };
    TEXT.iter().fold(false, |c, p| item.pointer_mut(p).filter(|x| !x.is_null()).is_some_and(|x| mask_or_hide(m, Some(&task), x, None)) | c)
}

impl RowView for View {
    fn kinds(&self) -> &'static [&'static str] {
        &[ITEM.kind, VIEW.kind]
    }
    fn row(&self, kind: &str, v: &mut Value) {
        let m = self.0.use_service::<EnvMaskService>().ok();
        if kind == ITEM.kind {
            if let Some(b) = v.get_mut("body") {
                mask_item(m.as_deref(), b);
            }
        } else {
            mask_item(m.as_deref(), v);
        }
    }
    fn patch(&self, kind: &str, path: &str, v: &mut Value) {
        // rows are upserted whole, so none is sent; one that can't say whose it is: hidden
        if path.is_empty() {
            return self.row(kind, v);
        }
        let m = self.0.use_service::<EnvMaskService>().ok();
        mask_or_hide(m.as_deref(), None, v, None);
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use serde_json::json;

    use super::*;

    /// What wisp.runtime's service does: task "s1" read `sk-live-one`; any other isn't in memory.
    struct Fake;
    impl EnvMask for Fake {
        fn mask(&self, task: Option<&str>, v: &mut Value) -> bool {
            match (task, v) {
                (Some("s1"), Value::String(s)) => {
                    let m = s.replace("sk-live-one", "••••");
                    let c = m != *s;
                    *s = m;
                    c
                }
                (Some("s1"), Value::Array(a)) => a.iter_mut().fold(false, |c, x| Fake.mask(Some("s1"), x) | c),
                (_, v) => wisp_runtime_api::env::hide(v, &[]),
            }
        }
    }

    #[test]
    fn an_item_an_agent_saved_from_a_task_quoting_a_value_it_read_leaves_masked_and_your_own_as_it_is() {
        let row = json!({ "id": "i1", "kind": "snippet", "name": "config.ts", "title": "Key sk-live-one", "note": "uses sk-live-one",
                          "excerpt": "const k = 'sk-live-one'", "tags": ["sk-live-one"], "from": { "session": "s1", "title": "Rotate" },
                          "size": 3, "by": "agent" });
        // as the page's row is written: the value is in it (before this view, it left so)
        assert!(row.to_string().contains("sk-live-one"));
        let mut v = row.clone();
        assert!(mask_item(Some(&Fake), &mut v));
        assert!(!v.to_string().contains("sk-live-one"), "{v}");
        assert_eq!(v["excerpt"], "const k = '••••'", "masked, not dropped");
        assert_eq!((v["name"].clone(), v["size"].clone(), v["from"]["session"].clone()), (json!("config.ts"), json!(3), json!("s1")));
        // the stored item: the same, in its body
        let mut stored = json!({ "id": "i1", "updated_at": 1, "body": row.clone() });
        assert!(mask_item(Some(&Fake), stored.get_mut("body").unwrap()));
        assert!(!stored.to_string().contains("sk-live-one"));
        // not in memory, or wisp.runtime off: hidden
        let mut v = row.clone();
        v["from"]["session"] = json!("s9");
        assert!(mask_item(Some(&Fake), &mut v));
        assert_eq!(v["title"], "••••");
        let mut v = row.clone();
        assert!(mask_item(None, &mut v));
        assert_eq!(v["excerpt"], "••••");
        // your own upload: no task behind it, as it is
        let mut own = row.clone();
        own.as_object_mut().unwrap().remove("from");
        assert!(!mask_item(Some(&Fake), &mut own));
    }
}
