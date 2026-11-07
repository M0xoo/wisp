//! The children this helper started, by the server's id.
//!
//! An exited child moves to `gone`, a short list that keeps its tree reachable: a program that
//! exits leaving a background process (an MCP server, a `cmd &`) can still have its tree killed.

use std::collections::{HashMap, VecDeque};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use portable_pty::MasterPty;

use crate::error::{Error, Result};
use crate::protocol::Item;
use crate::tree::Tree;

/// Exited children kept for a later kill of what they left behind.
const GONE: usize = 256;

#[derive(Debug)]
pub enum Input {
    Bytes(Vec<u8>),
    Eof,
}

pub struct Entry {
    pub pid: u32,
    pub tree: Tree,
    /// None once stdin is closed.
    pub input: Option<Sender<Input>>,
    /// The PTY's master side, for resizing; None for a piped child.
    pub master: Option<Box<dyn MasterPty + Send>>,
}

impl std::fmt::Debug for Entry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Entry").field("pid", &self.pid).field("pty", &self.master.is_some()).finish_non_exhaustive()
    }
}

#[derive(Debug)]
struct GoneEntry {
    id: String,
    pid: u32,
    pty: bool,
    tree: Tree,
}

#[derive(Debug, Default)]
pub struct Registry {
    live: HashMap<String, Entry>,
    gone: VecDeque<GoneEntry>,
}

/// What a kill needs, copied out so the lock isn't held while it waits.
#[derive(Debug, Clone)]
pub struct Target {
    pub tree: Tree,
    pub alive: bool,
}

pub type Shared = Arc<Mutex<Registry>>;

/// A panicking thread can't leave the registry half-written (every change is one insert/remove),
/// so a poisoned lock is still safe to use.
pub fn lock(reg: &Shared) -> MutexGuard<'_, Registry> {
    reg.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Registry {
    pub fn shared() -> Shared {
        Arc::new(Mutex::new(Registry::default()))
    }

    pub fn check_free(&mut self, id: &str) -> Result<()> {
        if self.live.contains_key(id) {
            return Err(Error::DuplicateId(id.to_owned()));
        }
        self.gone.retain(|g| g.id != id);
        Ok(())
    }

    pub fn insert(&mut self, id: String, entry: Entry) {
        self.live.insert(id, entry);
    }

    pub fn live(&mut self, id: &str) -> Result<&mut Entry> {
        if self.gone.iter().any(|g| g.id == id) {
            return Err(Error::Exited(id.to_owned()));
        }
        self.live.get_mut(id).ok_or_else(|| Error::UnknownId(id.to_owned()))
    }

    pub fn target(&self, id: &str) -> Result<Target> {
        if let Some(e) = self.live.get(id) {
            return Ok(Target { tree: e.tree.clone(), alive: true });
        }
        self.gone
            .iter()
            .find(|g| g.id == id)
            .map(|g| Target { tree: g.tree.clone(), alive: false })
            .ok_or_else(|| Error::UnknownId(id.to_owned()))
    }

    /// Every tree, running or left behind, for the shutdown sweep.
    pub fn targets(&self) -> Vec<Target> {
        let live = self.live.values().map(|e| Target { tree: e.tree.clone(), alive: true });
        let gone = self.gone.iter().map(|g| Target { tree: g.tree.clone(), alive: false });
        live.chain(gone).collect()
    }

    /// The child exited: drop its input and PTY, keep its tree for a while.
    pub fn exited(&mut self, id: &str) {
        let Some(e) = self.live.remove(id) else { return };
        if self.gone.len() == GONE {
            self.gone.pop_front();
        }
        self.gone.push_back(GoneEntry { id: id.to_owned(), pid: e.pid, pty: e.master.is_some(), tree: e.tree });
    }

    pub fn items(&self) -> Vec<Item> {
        let live = self.live.iter().map(|(id, e)| Item { id: id.clone(), pid: e.pid, pty: e.master.is_some(), exited: false });
        let gone = self.gone.iter().map(|g| Item { id: g.id.clone(), pid: g.pid, pty: g.pty, exited: true });
        let mut items: Vec<Item> = live.chain(gone).collect();
        items.sort_by(|a, b| a.id.cmp(&b.id));
        items
    }
}
