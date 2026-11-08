//! What active plugins registered: commands, interceptors, list-point contributions and services, each
//! tagged with its owner so switching a plugin off removes all of it at once. Reads are hot (every
//! dispatch), writes are rare (activation), so lists are kept sorted and shared as `Arc`s.
use std::collections::HashMap;
use std::sync::Arc;

use serde_json::Value;

use crate::host::{CmdFn, Ctx, HookFn};
use crate::perm::Permission;
use crate::state::Erased;
use crate::{InterceptOpts, Result, WireError};

pub(crate) struct CmdEntry {
    pub(crate) id: String,
    pub(crate) owner: Arc<str>,
    pub(crate) perm: Permission,
    pub(crate) read_only: bool,
    pub(crate) task_args: &'static [&'static str],
    pub(crate) all_tasks: bool,
    pub(crate) reads_any: bool,
    pub(crate) json: CmdFn,
    /// `TypedCmd<C>` for in-process commands: no JSON round trip when caller and owner share the type
    pub(crate) typed: Option<Erased>,
    pub(crate) ctx: Ctx,
    /// `owner:id`, the trace frame
    pub(crate) frame: String,
}

pub(crate) struct HookEntry {
    pub(crate) owner: Arc<str>,
    pub(crate) opts: InterceptOpts,
    pub(crate) order: u64,
    pub(crate) json: HookFn,
    pub(crate) typed: Option<Erased>,
    pub(crate) ctx: Ctx,
    pub(crate) frame: String,
}

pub(crate) struct PointEntry {
    pub(crate) owner: Arc<str>,
    pub(crate) version: u32,
    pub(crate) item: Erased,
    /// a contribution made over RPC (exec tier) is plain JSON
    pub(crate) json: Option<Value>,
}

pub(crate) struct ProvEntry {
    pub(crate) owner: Arc<str>,
    pub(crate) item: Erased,
}

#[derive(Default)]
pub(crate) struct Registry {
    pub(crate) commands: HashMap<String, Arc<CmdEntry>>,
    pub(crate) hooks: HashMap<String, Arc<Vec<Arc<HookEntry>>>>,
    pub(crate) points: HashMap<String, Vec<PointEntry>>,
    /// `id@major` → providers in registration order
    pub(crate) services: HashMap<String, Vec<ProvEntry>>,
    /// contract id → the provider resolution chose (the user's pick, then overrides, then order)
    pub(crate) chosen: HashMap<String, String>,
    pub(crate) order: u64,
}

pub(crate) fn service_key(id: &str, major: u32) -> String {
    format!("{id}@{major}")
}

impl Registry {
    pub(crate) fn add_command(&mut self, e: CmdEntry) -> Result<()> {
        if let Some(had) = self.commands.get(&e.id) {
            return Err(WireError::conflict(format!(
                "{} is already registered by {}",
                e.id, had.owner
            )));
        }
        self.commands.insert(e.id.clone(), Arc::new(e));
        Ok(())
    }

    pub(crate) fn add_hook(&mut self, hook: &str, mut e: HookEntry) {
        e.order = self.order;
        self.order += 1;
        let mut list: Vec<Arc<HookEntry>> = self
            .hooks
            .get(hook)
            .map(|l| l.as_ref().clone())
            .unwrap_or_default();
        list.push(Arc::new(e));
        list.sort_by_key(|h| (h.opts.priority, h.order));
        self.hooks.insert(hook.to_owned(), Arc::new(list));
    }

    pub(crate) fn add_point(&mut self, id: &str, e: PointEntry) {
        self.points.entry(id.to_owned()).or_default().push(e);
    }

    pub(crate) fn add_service(&mut self, key: String, e: ProvEntry) {
        self.services.entry(key).or_default().push(e);
    }

    /// Removes everything `owner` registered; returns how many registrations went.
    pub(crate) fn remove_owner(&mut self, owner: &str) -> usize {
        let mut n = 0;
        self.commands.retain(|_, c| {
            let keep = &*c.owner != owner;
            n += usize::from(!keep);
            keep
        });
        for list in self.hooks.values_mut() {
            if list.iter().any(|h| &*h.owner == owner) {
                let kept: Vec<Arc<HookEntry>> = list
                    .iter()
                    .filter(|h| &*h.owner != owner)
                    .cloned()
                    .collect();
                n += list.len() - kept.len();
                *list = Arc::new(kept);
            }
        }
        self.hooks.retain(|_, l| !l.is_empty());
        for v in self.points.values_mut() {
            let before = v.len();
            v.retain(|p| &*p.owner != owner);
            n += before - v.len();
        }
        self.points.retain(|_, v| !v.is_empty());
        for v in self.services.values_mut() {
            let before = v.len();
            v.retain(|p| &*p.owner != owner);
            n += before - v.len();
        }
        self.services.retain(|_, v| !v.is_empty());
        n
    }

    /// What `owner` has registered right now (the leak check reads it).
    pub(crate) fn count_owner(&self, owner: &str) -> usize {
        self.commands
            .values()
            .filter(|c| &*c.owner == owner)
            .count()
            + self
                .hooks
                .values()
                .map(|l| l.iter().filter(|h| &*h.owner == owner).count())
                .sum::<usize>()
            + self
                .points
                .values()
                .map(|l| l.iter().filter(|p| &*p.owner == owner).count())
                .sum::<usize>()
            + self
                .services
                .values()
                .map(|l| l.iter().filter(|p| &*p.owner == owner).count())
                .sum::<usize>()
    }
}
