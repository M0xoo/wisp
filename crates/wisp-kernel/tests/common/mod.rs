//! Test plugins: a manifest (as JSON) plus a setup closure.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::needless_pass_by_value,
    clippy::type_complexity,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    clippy::many_single_char_names
)]
use std::sync::Arc;

use serde_json::{Value, json};
use wisp_kernel::{App, Kernel, Manifest, Plugin, PluginGroup, Result, Setup};

type SetupFn = Arc<dyn Fn(&mut Setup) -> Result<()> + Send + Sync>;

pub struct P {
    pub m: Manifest,
    pub f: SetupFn,
}

impl Plugin for P {
    fn manifest(&self) -> Manifest {
        self.m.clone()
    }
    fn setup(&self, s: &mut Setup) -> Result<()> {
        (self.f)(s)
    }
}

/// A manifest with defaults; `extra` keys are merged in.
pub fn manifest(id: &str, extra: Value) -> Manifest {
    let mut m = json!({ "wispPlugin": 1, "id": id, "version": "1.0.0", "api": "^1" });
    if let (Some(o), Some(e)) = (m.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            o.insert(k.clone(), v.clone());
        }
    }
    Manifest::from_value(m).expect("test manifest")
}

pub fn plugin(id: &str, extra: Value, f: impl Fn(&mut Setup) + Send + Sync + 'static) -> P {
    P {
        m: manifest(id, extra),
        f: Arc::new(move |s| {
            f(s);
            Ok(())
        }),
    }
}

pub fn bare(id: &str, extra: Value) -> P {
    plugin(id, extra, |_| {})
}

pub async fn start(group: PluginGroup) -> Kernel {
    App::new()
        .plugins(group)
        .start()
        .await
        .expect("kernel starts")
}

pub fn state(k: &Kernel, id: &str) -> (String, Option<String>) {
    let s = k
        .status()
        .into_iter()
        .find(|s| s.id == id)
        .expect("plugin in status");
    (s.state, s.reason)
}

/// A typed command for tests: `cmd!(Name, "id", Args, Out)`.
#[macro_export]
macro_rules! cmd {
    ($name:ident, $id:literal, $args:ty, $out:ty) => {
        #[derive(Debug)]
        pub struct $name;
        impl wisp_kernel::Command for $name {
            const ID: &'static str = $id;
            type Args = $args;
            type Out = $out;
        }
    };
    ($name:ident, $id:literal, $args:ty, $out:ty, read_only) => {
        #[derive(Debug)]
        pub struct $name;
        impl wisp_kernel::Command for $name {
            const ID: &'static str = $id;
            const READ_ONLY: bool = true;
            type Args = $args;
            type Out = $out;
        }
    };
}
