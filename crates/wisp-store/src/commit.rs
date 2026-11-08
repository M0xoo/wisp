//! A command's write, tied to the kernel's `CommitHook` (wisp-kernel README, "For wisp-store"): the
//! events the call buffered go out exactly when this transaction commits, each carrying the change
//! feed's head as its cursor, and are dropped if it rolls back. Additive to the store's API.

use wisp_kernel::{Call, CommitHook};

use crate::error::Result;
use crate::store::Store;
use crate::writer::Writer;

impl Store {
    /// `write` on behalf of `call`: `hook.mark` before, `committed(head)` after COMMIT,
    /// `rolled_back` when `f` (or the commit) fails.
    pub async fn write_for<T, F>(&self, hook: &CommitHook, call: &Call, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Writer<'_>) -> Result<T> + Send + 'static,
    {
        let mark = hook.mark(call);
        let r = self
            .write(move |w| {
                let v = f(w)?;
                Ok((v, w.head_seq()?))
            })
            .await;
        match r {
            Ok((v, head)) => {
                hook.committed(call, u64::try_from(head).ok());
                Ok(v)
            }
            Err(e) => {
                hook.rolled_back(call, mark);
                Err(e)
            }
        }
    }
}
