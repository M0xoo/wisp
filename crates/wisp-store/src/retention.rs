//! Retention (plan §4.1): change rows are kept 7 days or 1M rows, whichever keeps fewer; mutation records
//! 24 h. And the epoch: a fresh random value on restore or import, so a cursor from before is never trusted.

use std::sync::PoisonError;

use rusqlite::{Connection, OptionalExtension};

use crate::error::Result;
use crate::store::{EpochListener, PruneResult, Retention, Store};

impl Store {
    // ---------- epoch, retention ----------

    /// A fresh epoch, after a restore or an import: every client's cursor from before is distrusted.
    pub async fn rotate_epoch(&self) -> Result<String> {
        let epoch = (self.shared.make_epoch)();
        let e = epoch.clone();
        self.thread
            .run_raw_async(move |db| crate::writer::write_meta(db, "epoch", Some(&e)))
            .await?;
        self.shared
            .epoch
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .clone_from(&epoch);
        let listeners: Vec<EpochListener> = self
            .shared
            .epoch_listeners
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .map(|(_, f)| f.clone())
            .collect();
        for f in listeners {
            crate::thread::call_listener(|| f(&epoch));
        }
        Ok(epoch)
    }

    /// Change rows: older than `change_ms` or beyond the newest `change_rows`. Mutation records: older than
    /// `mutation_ms`. Run it on a timer (hourly is plenty).
    pub async fn prune(&self) -> Result<PruneResult> {
        let (r, now) = (self.shared.retention, self.shared.clock.now_ms());
        self.thread.run_raw_async(move |db| prune(db, r, now)).await
    }
}

fn prune(db: &Connection, r: Retention, now: i64) -> Result<PruneResult> {
    db.execute_batch("BEGIN IMMEDIATE")?;
    let run = || -> Result<PruneResult> {
        let head = crate::changes::head_seq(db)?;
        // the newest seq to drop: beyond the row cap, or the run of oldest rows past the age limit
        // (scanned from the oldest, stopping at the first row young enough to keep)
        let first_kept: Option<i64> = db
            .query_row(
                "SELECT seq FROM change WHERE at >= ? ORDER BY seq LIMIT 1",
                [now - r.change_ms],
                |row| row.get(0),
            )
            .optional()?;
        let by_age = first_kept.map_or(head, |s| s - 1);
        let upto = by_age.max(head - r.change_rows);
        let changes = prune_changes(db, upto)?;
        let mutations = db.execute("DELETE FROM mutation WHERE at < ?", [now - r.mutation_ms])?;
        Ok(PruneResult {
            changes,
            mutations: mutations as u64,
        })
    };
    match run() {
        Ok(out) => {
            db.execute_batch("COMMIT")?;
            Ok(out)
        }
        Err(e) => {
            db.execute_batch("ROLLBACK")?;
            Err(e)
        }
    }
}

/// Drops change rows up to `upto` and their topic entries, one index range per topic they were on.
fn prune_changes(db: &Connection, upto: i64) -> Result<u64> {
    let mut topics = std::collections::BTreeSet::new();
    {
        let mut st = db.prepare("SELECT topic, more FROM change WHERE seq <= ?")?;
        let mut rows = st.query([upto])?;
        while let Some(row) = rows.next()? {
            topics.insert(row.get::<_, String>(0)?);
            if let Some(more) = row.get::<_, Option<String>>(1)? {
                topics.extend(more.split(' ').map(str::to_owned));
            }
        }
    }
    let mut st = db.prepare_cached("DELETE FROM change_topic WHERE topic = ? AND seq <= ?")?;
    for t in &topics {
        st.execute(rusqlite::params![t, upto])?;
    }
    Ok(db.execute("DELETE FROM change WHERE seq <= ?", [upto])? as u64)
}
