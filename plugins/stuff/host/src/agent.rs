//! What an agent reads (`wisp_stuff`, @-mentions): the items with a readable path for each.
use wisp_stuff_api::commands::{FindArgs, FindOut};
use wisp_stuff_api::{StuffItem, StuffKind};
use wisp_stuff_core::agent::{Detail, find_text, stuff_detail};
use wisp_stuff_core::kind::texty;
use wisp_stuff_core::record::{current_grant, matches};

use crate::error::Result;
use crate::shelf::Shelf;

impl Shelf {
    /// Every item matching the words and kind, newest first, with where its file is. `mine`: what a
    /// capped agent may see (its own project's); None: everything.
    pub async fn find(&self, a: &FindArgs, mine: Option<&(dyn Fn(&StuffItem) -> bool + Sync)>) -> Result<FindOut> {
        let limit = a.limit.unwrap_or(30).clamp(1, 100);
        let all: Vec<StuffItem> =
            self.list().into_iter().filter(|x| matches(x, &a.query, a.kind)).filter(|x| mine.is_none_or(|m| m(x))).collect();
        let mut with_paths = Vec::with_capacity(all.len().min(limit));
        for it in all.iter().take(limit) {
            let p = self.local_path(it).await.unwrap_or_default();
            with_paths.push((it.clone(), p));
        }
        let mut shown = with_paths.clone();
        // the count says how many matched, the lines show the newest `limit`
        shown.extend(all.iter().skip(limit).map(|x| (x.clone(), String::new())));
        let text = find_text(&shown, limit, self.len(), mine.is_some());
        Ok(FindOut { items: with_paths.into_iter().map(|(i, _)| i).collect(), text })
    }

    /// One item in full, or None.
    pub async fn describe(&self, id: &str) -> Result<Option<String>> {
        let Some(it) = self.get(id) else { return Ok(None) };
        let path = self.local_path(&it).await?;
        let mut d = Detail { allowed: current_grant(&it).allowed, ..Detail::default() };
        if matches!(it.kind, StuffKind::Doc | StuffKind::Code) && texty(&it.name) && it.size <= 20_000 {
            d.text = self.bytes(&it).await?.and_then(|b| String::from_utf8(b.to_vec()).ok());
        }
        if let Some(tree) = &it.tree {
            let t = crate::appfiles::tree(self.blobs.as_ref(), tree).await?;
            let mut rels: Vec<String> = t.keys().cloned().collect();
            rels.sort();
            rels.truncate(40);
            d.files = rels;
        }
        Ok(Some(stuff_detail(&it, &path, &d)))
    }
}
