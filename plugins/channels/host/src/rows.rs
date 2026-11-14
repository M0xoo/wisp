//! Settings → Phone's rows (F-chan-13): where each channel stands, on `plugin:wisp.channels:phone`, so the pane that
//! watches it turns Checking… into Working or Not working by itself (clients never poll). One `chan_phone` row per
//! channel, id its transport, `body` a `ChannelSetup::public` (no secret, no link code, no private URL or address),
//! written only when it changed.

use std::sync::Arc;

use serde_json::Value;
use wisp_kernel::Ctx;
use wisp_store::{Col, EntityDef, Store};

use crate::{Live, lock};

/// Settings → Phone watches these (`plugin:wisp.channels:phone`): one per channel, id its transport.
pub const PHONE: EntityDef = EntityDef {
    kind: "chan_phone",
    table: "chan_phone",
    key: "id",
    columns: &[("id", Col::Text), ("body", Col::Text)],
    json_columns: &["body"],
    parent: None,
    seq: None,
    topics: |_| vec![wisp_channels_api::PHONE_TOPIC.to_owned()],
};

/// Writes the Phone rows that changed, in one transaction.
pub async fn put_phone(store: &Store, rows: Vec<(String, Value)>) -> wisp_store::Result<()> {
    store
        .write(move |w| {
            for (id, body) in rows {
                w.upsert(PHONE.kind, crate::kept::row(&id, &body)?)?;
            }
            Ok(())
        })
        .await
}

/// Has Settings → Phone's rows written again, off the caller's way. Pokes coalesce: one task at most, which writes
/// again while more came in meanwhile (a burst of marks is one or two rebuilds, not one each), each reading the hub
/// afresh, so the last write is never older than the last poke.
pub fn poke(ctx: &Ctx, live: &Arc<Live>) {
    use std::sync::atomic::Ordering::SeqCst;
    live.st.phone_dirty.store(true, SeqCst);
    if live.st.phone_running.swap(true, SeqCst) {
        return;
    }
    let (c, l) = (ctx.clone(), live.clone());
    ctx.spawn(async move {
        loop {
            while l.st.phone_dirty.swap(false, SeqCst) {
                publish(&c, &l).await;
            }
            l.st.phone_running.store(false, SeqCst);
            // a poke between the last check and the store above found it running: take it now
            if !l.st.phone_dirty.load(SeqCst) || l.st.phone_running.swap(true, SeqCst) {
                break;
            }
        }
    });
}

/// Writes each channel's Phone row (`chan_phone`, `ChannelSetup::public`) that changed since the last write.
pub async fn publish(ctx: &Ctx, live: &Live) {
    if !live.st.loaded.load(std::sync::atomic::Ordering::Acquire) {
        return;
    }
    let Some(store) = live.st.store.get().cloned() else { return };
    let all = crate::setup::phone_status(ctx, live).await;
    let rows: Vec<(String, Value)> = {
        let had = lock(&live.st.phone);
        all.channels
            .iter()
            .filter_map(|c| serde_json::to_value(c.public()).ok().map(|v| (c.transport.clone(), v)))
            .filter(|(t, v)| had.get(t) != Some(v))
            .collect()
    };
    if rows.is_empty() {
        return;
    }
    match put_phone(&store, rows.clone()).await {
        Ok(()) => lock(&live.st.phone).extend(rows),
        Err(e) => tracing::warn!("channels: Settings → Phone's rows couldn't be written: {e}"),
    }
}
