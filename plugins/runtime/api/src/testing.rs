//! Test stand-ins (feature `testing`, dev-dependencies only): a wisp.runtime holding one task whose
//! `runtime.setExt` honours `expect` as the real one does, and can land a second write just before the next
//! `runtime.setExt` is applied (a write that lands between a plugin's read and its write), deterministically.

use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use serde_json::{Value, json};
use wisp_kernel::{Declarative, Manifest, Plugin, Result, Setup, WireError};

use crate::commands::{Ack, Get, IdArgs, SetExt, SetExtArgs};
use crate::model::Session;

#[derive(Debug, Default)]
struct Inner {
    task: Session,
    /// (plugin, value): written just before the next `runtime.setExt` is compared and applied
    race: Option<(String, Value)>,
    /// every `runtime.setExt` that came in: (plugin, value, went)
    writes: Vec<(String, Value, bool)>,
}

/// wisp.runtime with one task: `runtime.get` and `runtime.setExt` (with `expect`) only. Clones share the task.
#[derive(Debug, Clone, Default)]
pub struct SlotRuntime(Arc<Mutex<Inner>>);

impl SlotRuntime {
    /// The task it holds (`runtime.get` of any other id: not found).
    #[must_use]
    pub fn new(task: Session) -> Self {
        Self(Arc::new(Mutex::new(Inner { task, ..Inner::default() })))
    }
    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
    /// `plugin`'s slot set to `value` just before the next `runtime.setExt` is compared and applied: another
    /// writer that got there between the caller's read and its write.
    pub fn race(&self, plugin: &str, value: Value) {
        self.lock().race = Some((plugin.to_owned(), value));
    }
    /// `plugin`'s slot now (`Null`: empty).
    #[must_use]
    pub fn ext(&self, plugin: &str) -> Value {
        self.lock().task.ext_of(plugin).clone()
    }
    /// `plugin`'s slot set directly (no write recorded).
    pub fn set(&self, plugin: &str, value: Value) {
        self.lock().task.ext.insert(plugin.to_owned(), value);
    }
    /// Every `runtime.setExt` so far: (plugin, value, went).
    #[must_use]
    pub fn writes(&self) -> Vec<(String, Value, bool)> {
        self.lock().writes.clone()
    }
    /// Registers `runtime.get` and `runtime.setExt` (for a stand-in runtime that serves more commands too).
    pub fn register(&self, s: &mut Setup) {
        let me = self.clone();
        s.command::<Get, _, _>(move |_c, _call, a: IdArgs| {
            let t = me.lock().task.clone();
            async move { if t.id == a.id { Ok(t) } else { Err(WireError::not_found("That task is gone.")) } }
        });
        let me = self.clone();
        s.command::<SetExt, _, _>(move |_c, _call, a: SetExtArgs| {
            let r = me.apply(a);
            async move { r }
        });
    }
    fn apply(&self, a: SetExtArgs) -> Result<Ack> {
        let mut g = self.lock();
        if let Some((plugin, value)) = g.race.take() {
            g.task.ext.insert(plugin, value);
        }
        let now = g.task.ext_of(&a.plugin).clone();
        let went = a.expect.as_ref().is_none_or(|e| e.value == now);
        if went {
            if a.value.is_null() {
                g.task.ext.remove(&a.plugin);
            } else {
                g.task.ext.insert(a.plugin.clone(), a.value.clone());
            }
        }
        g.writes.push((a.plugin, a.value, went));
        if went { Ok(Ack {}) } else { Err(WireError::conflict("changed meanwhile")) }
    }
}

impl Plugin for SlotRuntime {
    fn manifest(&self) -> Manifest {
        manifest(json!({ "wispPlugin": 1, "id": "wisp.runtime", "version": "2.0.0", "api": "^1", "activation": ["onStartup"] }))
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        self.register(s);
        Ok(())
    }
}

/// A plugin `id` that does nothing but may run `runtime.get` and `runtime.setExt`: its context calls a helper as
/// the plugin under test would (`Kernel::ctx(id)`).
#[must_use]
pub fn caller(id: &str) -> Declarative {
    Declarative(manifest(json!({
        "wispPlugin": 1, "id": id, "version": "2.0.0", "api": "^1", "activation": ["onStartup"],
        "permissions": ["runtime:get", "runtime:setExt"]
    })))
}

fn manifest(v: Value) -> Manifest {
    // a literal manifest: it parses (a typo here fails every test that uses it at once)
    Manifest::from_value(v).unwrap_or_else(|e| unreachable!("stand-in manifest: {e}"))
}
