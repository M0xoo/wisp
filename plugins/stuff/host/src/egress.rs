//! wisp.stuff's view of its own rows as they leave (ADR-0054, the `kernel.egress` point), on the `stuff` topic. An
//! item an agent saved from a task (`from.session`) carries what it wrote and what it kept of the file (title, note,
//! excerpt, tags, the version before's excerpt): those go through wisp.runtime's `runtime.envmask@1`, masked against
//! the .env values that task read, hidden when those can't be told or wisp.runtime is off (fail closed). An item no
//! task made (your own upload) is yours: as it is. Both the stored item (`stuff_item`, its `body`) and the page's
//! row (`stuff.item`, flat). The store keeps them as they are.

use serde_json::Value;
use std::sync::Arc;
use wisp_kernel::Ctx;
use wisp_kernel::egress::RowView;

use wisp_runtime_api::env::{EnvMask, EnvMaskService, carry, keep, kept_of, mask_or_hide, mask_prompt_kept, take_kept};
use wisp_stuff_api::StuffItem;

use crate::store::ITEM;
use crate::view::VIEW;

/// An item's fields an agent wrote, or that hold what it kept of a file.
const TEXT: &[&str] = &["/title", "/note", "/excerpt", "/tags", "/source", "/from/title", "/prev/excerpt"];

pub(crate) struct View(pub(crate) Ctx);

/// Where an item keeps its ranges: in its `from` (both tables carry it as JSON, and only an item with a task has any).
const AT: &str = "/from";

fn task_of(item: &Value) -> Option<String> {
    item.pointer("/from/session").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

fn texts_of(item: &Value) -> Vec<(String, String)> {
    task_of(item).map(|t| TEXT.iter().map(|p| ((*p).to_owned(), t.clone())).collect()).unwrap_or_default()
}

/// An item (`stuff_item`'s body, or a `stuff.item` row) masked against the task it came from (`m` `None`: hidden), by
/// the ranges kept with it as it was written (`from.envHide`) when that task's values aren't in memory (a restart's
/// first send). The ranges never leave.
pub(crate) fn mask_item(m: Option<&dyn EnvMask>, item: &mut Value) -> bool {
    let kept = take_kept(item, AT);
    let Some(task) = task_of(item) else { return kept.is_some() };
    TEXT.iter().fold(kept.is_some(), |c, p| {
        item.pointer_mut(p).filter(|x| !x.is_null()).is_some_and(|x| mask_or_hide(m, Some(&task), x, kept_of(kept.as_ref(), p))) | c
    })
}

/// Where an item's text quotes a value its task read, kept with it as it is written (ADR-0055).
pub(crate) fn keep_item(m: Option<&dyn EnvMask>, item: &mut Value) {
    let texts = texts_of(item);
    if !texts.is_empty() {
        keep(m, item, AT, &texts);
    }
}

/// [`keep_item`]'s gaps (its task not in memory now: the first write after a restart) filled from the row it replaces,
/// where a text is as it was.
pub(crate) fn carry_item(old: &Value, item: &mut Value) {
    let texts = texts_of(item);
    carry(old, item, AT, &texts);
}

/// How a read answers an item (`stuff.list`, `stuff.get`, `stuff.find`, `stuff.describe` and `wisp_stuff`):
/// masked as its rows are (ADR-0055).
pub(crate) struct Mask(pub(crate) Option<Arc<dyn EnvMask>>);

impl Mask {
    pub(crate) fn of(ctx: &Ctx) -> Self {
        Self(ctx.use_service::<EnvMaskService>().ok())
    }

    /// `x` (an item, a view, a list of them) through JSON, each masked; an error, never the value as it is, when the
    /// round trip fails (fail closed).
    pub(crate) fn json<T: serde::Serialize + serde::de::DeserializeOwned>(&self, x: T) -> wisp_kernel::Result<T> {
        let closed = |e: serde_json::Error| wisp_kernel::WireError::internal(format!("couldn't hide .env values: {e}"));
        let mut v = serde_json::to_value(x).map_err(closed)?;
        match &mut v {
            Value::Array(a) => {
                for x in a {
                    mask_item(self.0.as_deref(), x);
                }
            }
            Value::Null => {}
            x => {
                mask_item(self.0.as_deref(), x);
            }
        }
        serde_json::from_value(v).map_err(closed)
    }
}

impl crate::agent::Masker for Mask {
    fn item(&self, it: StuffItem) -> StuffItem {
        let id = it.id.clone();
        // the round trip can't fail for an item read back from the store; if it did, nothing of it is told
        self.json(it).unwrap_or_else(|_| StuffItem { id, title: wisp_runtime_api::env::HIDDEN.into(), ..StuffItem::default() })
    }
    fn text(&self, it: &StuffItem, text: String) -> String {
        let Some(task) = it.from.as_ref().and_then(|f| f.session.clone()).filter(|s| !s.is_empty()) else { return text };
        // a file's text: only the values its task read (it is code or a doc, not an agent's prose)
        let mut v = Value::String(text);
        mask_prompt_kept(self.0.as_deref(), Some(&task), &mut v, None);
        v.as_str().unwrap_or_default().to_owned()
    }
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

    /// ADR-0055: an item keeps where it quotes a value as it is written (in its `from`, in both tables), so the first
    /// snapshot after a restart masks by them instead of hiding it whole; a row rewritten while its task isn't in memory
    /// (every view row at start) keeps them where its text is as it was; they never leave. `stuff.list` / `stuff.get` /
    /// `wisp_stuff` answer masked: the item, and a file's text by its task's values only.
    #[test]
    fn an_items_ranges_kept_at_write_mask_it_after_a_restart_and_its_reads_answer_masked() {
        use crate::agent::Masker;
        use wisp_runtime_api::testing::EnvFake;
        let (live, restarted) = (EnvFake::default().with("s1", &["sk-live-one"]), EnvFake::default());
        let row = json!({ "id": "i1", "kind": "code", "name": "config.ts", "title": "Key sk-live-one", "note": "uses sk-live-one",
                          "excerpt": "const k = 'sk-live-one'", "tags": ["sk-live-one", "ops"], "from": { "session": "s1", "title": "Rotate" },
                          "size": 3, "by": "agent" });
        let mut stored = row.clone();
        keep_item(Some(&live), &mut stored);
        assert!(stored["from"]["envHide"]["/excerpt"].is_object(), "{stored}");
        let mut sent = stored.clone();
        assert!(mask_item(Some(&restarted), &mut sent));
        assert!(!sent.to_string().contains("sk-live"), "{sent}");
        assert_eq!(sent["excerpt"], "const k = '••••'", "by its ranges, not hidden whole");
        assert_eq!(sent["tags"], json!(["••••", "ops"]));
        assert_eq!(sent["from"], json!({ "session": "s1", "title": "Rotate" }), "the ranges never leave");
        // rewritten at start (nothing in memory): the same text keeps its ranges; one changed gets none
        let mut again = row.clone();
        keep_item(Some(&restarted), &mut again);
        carry_item(&stored, &mut again);
        assert_eq!(again["from"]["envHide"], stored["from"]["envHide"]);
        let mut changed = row.clone();
        changed["note"] = json!("now sk-live-one twice sk-live-one");
        keep_item(Some(&restarted), &mut changed);
        carry_item(&stored, &mut changed);
        assert!(changed["from"]["envHide"].get("/note").is_none() && changed["from"]["envHide"].get("/title").is_some());

        // the reads
        let m = Mask(Some(Arc::new(live)));
        let item: StuffItem = serde_json::from_value(row.clone()).unwrap();
        let told = m.item(item.clone());
        assert_eq!(told.title, "Key ••••");
        assert_eq!(told.from.as_ref().and_then(|f| f.session.as_deref()), Some("s1"));
        assert_eq!(
            m.text(&item, "const MAX=10;\nconst k = 'sk-live-one'".into()),
            "const MAX=10;\nconst k = '••••'",
            "a file: values only"
        );
        let list: Vec<Value> = m.json(vec![row.clone()]).unwrap();
        assert_eq!(list[0]["note"], "uses ••••");
        let gone = Mask(None);
        assert_eq!(gone.item(item.clone()).title, "••••", "wisp.runtime off: hidden");
        let mut own = item;
        own.from = None;
        assert_eq!(Mask(None).item(own).title, "Key sk-live-one", "your own upload: as it is");
    }
}
