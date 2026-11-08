//! wisp-stuff: wisp.stuff plugin: My Stuff's commands and v1 routes over the CAS-backed shelf, the
//! apps it launches (each on a port of its own, with its own database) and uploads.
//!
//! The shelf lives under `<home>/stuff`: blobs by BLAKE3 hash and one JSON file per row (`FsBlobs`,
//! `JsonRows`), the stand-ins named in `ports.rs` until its rows move into wisp-store tables.

mod agent;
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
pub mod state;
mod uploads;

use std::sync::Arc;

use wisp_kernel::services::Paths;
use wisp_kernel::{Manifest, Plugin, Result, Setup, WireError};

use crate::launch::Apps;
use crate::ports::{FsBlobs, JsonRows};
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
        for r in routes::all(&cell) {
            s.route(r);
        }
        commands::register(s, &cell);
        s.on_start(move |ctx| async move {
            let dir = ctx.service::<Paths>()?.home().join("stuff");
            let shelf = Shelf::open(Arc::new(FsBlobs::new(dir.join("blobs"))), Arc::new(JsonRows::new(dir.join("rows"))), dir, ctx.clock()?)
                .await
                .map_err(WireError::from)?;
            starters::follow_all(&shelf).await;
            let apps = Apps::new(shelf.clone(), Arc::new(appdb::AppDb::default()), ctx.scope().clone());
            let (stop, on_stop) = (ctx.scope().clone(), apps.clone());
            ctx.spawn(async move {
                stop.cancelled().await;
                on_stop.stop_all(); // switched off: every app it launched stops
            });
            let _ = cell.set(Arc::new(Stuff { shelf, apps, shots: std::sync::RwLock::default() }));
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
