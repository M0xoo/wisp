//! The store's content-addressed blob put (plan §4.1), as a kernel service an install provides
//! (`ctx.service::<Arc<dyn Blobs>>()`): large results go by reference, not inline. Declared here until
//! `wisp-store` exports its own; then the install adapts it and this stays the narrow seam tests fake.
//! Processes are not a port of git's: every git and gh call goes through `wisp_proc::Proc`.

use wisp_kernel::{BoxFuture, Result};

use crate::model::BlobRef;

pub trait Blobs: Send + Sync + 'static {
    fn put(&self, media: &str, bytes: Vec<u8>) -> BoxFuture<'static, Result<BlobRef>>;
}
