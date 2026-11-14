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

/// `runtime.envmask@1` as wisp.runtime answers it, for another plugin's tests: the tasks in memory (`known`: task →
/// the values it read) mask every quote of a value; a task not in memory masks by its kept ranges, else hides it whole
/// (fail closed). [`ranges`](crate::env::EnvMask::ranges) finds the quotes of a task in memory, none otherwise. No
/// .env-line rule: a plugin's tests check where the text goes, wisp.runtime's check the rules.
#[derive(Debug, Clone, Default)]
pub struct EnvFake {
    pub known: Vec<(String, Vec<String>)>,
}

impl EnvFake {
    /// Task `task` in memory, having read `values`.
    #[must_use]
    pub fn with(mut self, task: &str, values: &[&str]) -> Self {
        self.known.push((task.to_owned(), values.iter().map(|v| (*v).to_owned()).collect()));
        self
    }

    fn of(&self, task: Option<&str>) -> Option<&[String]> {
        let t = task?;
        self.known.iter().find(|(k, _)| k == t).map(|(_, v)| v.as_slice())
    }
}

fn leaves(v: &Value, ptr: &mut String, f: &mut impl FnMut(&str, &str)) {
    match v {
        Value::String(t) => f(ptr, t),
        Value::Array(a) => {
            for (i, x) in a.iter().enumerate() {
                let n = ptr.len();
                let _ = std::fmt::Write::write_fmt(ptr, format_args!("/{i}"));
                leaves(x, ptr, f);
                ptr.truncate(n);
            }
        }
        Value::Object(o) => {
            for (k, x) in o {
                let n = ptr.len();
                ptr.push('/');
                ptr.push_str(&k.replace('~', "~0").replace('/', "~1"));
                leaves(x, ptr, f);
                ptr.truncate(n);
            }
        }
        _ => {}
    }
}

fn spans(t: &str, values: &[String]) -> Vec<[u32; 2]> {
    let mut out: Vec<[u32; 2]> = values
        .iter()
        .filter(|v| !v.is_empty())
        .flat_map(|v| t.match_indices(v.as_str()).map(|(i, m)| [u32::try_from(i).unwrap_or(0), u32::try_from(i + m.len()).unwrap_or(0)]))
        .collect();
    out.sort_unstable();
    out
}

fn masked(t: &str, sp: &[[u32; 2]]) -> String {
    let (mut out, mut at) = (String::new(), 0usize);
    for [s, e] in sp {
        let (s, e) = (*s as usize, *e as usize);
        if s < at || e > t.len() || !t.is_char_boundary(s) || !t.is_char_boundary(e) {
            continue;
        }
        out.push_str(&t[at..s]);
        out.push_str(crate::env::HIDDEN);
        at = e;
    }
    out.push_str(&t[at..]);
    out
}

impl crate::env::EnvMask for EnvFake {
    fn mask(&self, task: Option<&str>, v: &mut Value) -> bool {
        self.mask_kept(task, v, None)
    }
    fn ranges(&self, task: &str, v: &Value) -> Option<Value> {
        let k = self.of(Some(task))?;
        let mut out = serde_json::Map::new();
        leaves(v, &mut String::new(), &mut |p, t| {
            let s = spans(t, k);
            if !s.is_empty() {
                out.insert(p.to_owned(), json!(s));
            }
        });
        Some(Value::Object(out))
    }
    fn mask_kept(&self, task: Option<&str>, v: &mut Value, kept: Option<&Value>) -> bool {
        if let Some(k) = self.of(task) {
            let mut hits = Vec::new();
            leaves(v, &mut String::new(), &mut |p, t| {
                let s = spans(t, k);
                if !s.is_empty() {
                    hits.push((p.to_owned(), s));
                }
            });
            return apply(v, hits);
        }
        let parsed: Option<std::collections::BTreeMap<String, Vec<[u32; 2]>>> =
            kept.filter(|_| task.is_some()).and_then(|k| serde_json::from_value(k.clone()).ok());
        match parsed {
            Some(m) => apply(v, m.into_iter().collect()),
            None => crate::env::hide(v, &[]),
        }
    }
}

fn apply(v: &mut Value, hits: Vec<(String, Vec<[u32; 2]>)>) -> bool {
    let mut changed = false;
    for (p, s) in hits {
        if let Some(Value::String(t)) = v.pointer_mut(&p) {
            *t = masked(t, &s);
            changed = true;
        }
    }
    changed
}
