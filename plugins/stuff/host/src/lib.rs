//! wisp-stuff: wisp.stuff plugin: My Stuff's commands and v1 routes over the CAS-backed shelf, the
//! apps it launches (each on a port of its own, with its own database) and uploads.
//!
//! Items and uploads are rows in stuff-owned store tables and their contents the store's blobs
//! (`store.rs`, ADR-0004). An app's own database and the copies agents read stay files under
//! `<home>/stuff`. v1's files are imported once at start (`import.rs`).

mod kinds;
mod agent;
mod bundle;
pub mod appdb;
mod appfiles;
mod commands;
mod error;
mod files;
pub mod import;
pub mod launch;
pub mod ports;
mod routes;
mod save;
pub mod shelf;
mod starters;
mod view;
pub mod state;
pub mod store;
mod uploads;

use std::sync::Arc;

use wisp_kernel::services::Paths;
use wisp_kernel::{Manifest, Plugin, Result, Setup, WireError};

use crate::launch::Apps;
use crate::shelf::Shelf;
use crate::state::{Cell, Stuff};

#[derive(Debug, Default)]
pub struct StuffPlugin;

impl Plugin for StuffPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        let cell: Cell = Cell::default();
        crate::kinds::register(s, &cell);
        for r in routes::all(&cell) {
            s.route(r);
        }
        commands::register(s, &cell);
        bundle::register(s, &cell);
        s.on_start(move |ctx| async move {
            let home = ctx.service::<Paths>()?.home().to_owned();
            let dir = home.join("stuff");
            let db = ctx.service::<wisp_store::Store>()?.as_ref().clone();
            store::install(&db).map_err(WireError::from)?;
            view::install(&db).map_err(WireError::from)?;
            let shelf = Shelf::open(Arc::new(store::StoreBlobs { store: db.clone() }), Arc::new(store::StoreRows { store: db }), dir, ctx.clock()?)
                .await
                .map_err(WireError::from)?;
            // v1's stuff, uploads and shots (and the pre-store files), once: what's here already is skipped
            let (bg, home2) = (shelf.clone(), home.clone());
            ctx.spawn(async move {
                import::import_interim(&bg, &home2.join("stuff")).await;
                let (r, _) = import::import_all(&bg, &home2).await;
                if r.items + r.uploads + r.shots > 0 {
                    tracing::info!(items = r.items, uploads = r.uploads, shots = r.shots, "stuff: imported v1's files");
                }
            });
            starters::follow_all(&shelf).await;
            let apps = Apps::new(shelf.clone(), Arc::new(appdb::AppDb::default()), ctx.scope().clone());
            let (stop, on_stop) = (ctx.scope().clone(), apps.clone());
            ctx.spawn(async move {
                stop.cancelled().await;
                on_stop.stop_all(); // switched off: every app it launched stops
            });
            let st = Arc::new(Stuff { shelf, apps, shots: std::sync::RwLock::default() });
            let _ = cell.set(st.clone());
            view::publish(&ctx, &st);
            Ok(())
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(StuffPlugin.manifest().id, "wisp.stuff");
    }
}
