//! What every handle on one repo (its main checkout) shares: the worktree-add queue (edge case Git 3),
//! the fetch clock (edge case Git 4) and the `on_change` subscribers.

use std::sync::{Arc, Mutex};

use wisp_git_api::{ChangeFn, RepoChange, Subscription};
use wisp_git_core::base::FetchClock;
use wisp_kernel::CancellationToken;

pub type Now = Arc<dyn Fn() -> i64 + Send + Sync>;

pub struct RootState {
    /// `git worktree add` reads every other worktree's files under .git/worktrees: two at once in one
    /// repo can catch the other half-made. Adds and removes take turns.
    pub worktrees: tokio::sync::Mutex<()>,
    /// held across a whole-remote fetch, so a second caller waits for the one in flight, then reuses it
    pub fetching: tokio::sync::Mutex<FetchClock>,
    watchers: Mutex<Vec<(CancellationToken, ChangeFn)>>,
}

impl std::fmt::Debug for RootState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RootState").finish_non_exhaustive()
    }
}

impl RootState {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { worktrees: tokio::sync::Mutex::new(()), fetching: tokio::sync::Mutex::new(FetchClock::default()), watchers: Mutex::new(Vec::new()) })
    }

    /// A subscription ending when it is disposed or dropped, or when `owner` is cancelled.
    pub fn subscribe(&self, owner: &CancellationToken, cb: ChangeFn) -> Subscription {
        let token = owner.child_token();
        if let Ok(mut w) = self.watchers.lock() {
            w.retain(|(t, _)| !t.is_cancelled());
            w.push((token.clone(), cb));
        }
        Subscription::new(token)
    }

    /// Tells every live subscriber. Callbacks run outside the lock, so one may subscribe again.
    pub fn notify(&self, change: &RepoChange) {
        let live: Vec<ChangeFn> = match self.watchers.lock() {
            Ok(mut w) => {
                w.retain(|(t, _)| !t.is_cancelled());
                w.iter().map(|(_, cb)| cb.clone()).collect()
            }
            Err(_) => Vec::new(),
        };
        for cb in live {
            cb(change.clone());
        }
    }

    pub fn watchers(&self) -> usize {
        self.watchers.lock().map(|mut w| {
            w.retain(|(t, _)| !t.is_cancelled());
            w.len()
        }).unwrap_or(0)
    }
}
