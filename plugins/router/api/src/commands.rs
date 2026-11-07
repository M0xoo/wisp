//! wisp.router's commands. Each id is also its permission (`router.view` → `router:view`), checked by
//! the kernel before the handler runs (default deny). v1's routes (routes/auto.js) are thin adapters
//! over them: GET /router, PATCH /router, POST /router/preview, POST /router/reset.

use serde::{Deserialize, Serialize};
use ts_rs::TS;
use wisp_kernel::{Command, Event};

use crate::types::{Added, Signals, StoredRoute};
use crate::view::{PreviewArgs, PreviewResult, RouterPatch, RouterView};

macro_rules! command {
    ($(#[$m:meta])* $name:ident = $id:literal : $args:ty => $out:ty $(, $ro:ident)?) => {
        $(#[$m])*
        #[derive(Debug)]
        pub struct $name;
        impl Command for $name {
            const ID: &'static str = $id;
            $(const READ_ONLY: bool = { let _ = stringify!($ro); true };)?
            type Args = $args;
            type Out = $out;
        }
    };
}

/// `{}`: no arguments, or an answer that is only success.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct Ack {}

/// `router.signal`: something happened to a routed task (👍/👎, a rollback, the best-of-2 judge).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct SignalArgs {
    pub id: String,
    pub patch: Signals,
}

/// `router.record`: a launch went out with this route (`id@machine` for one on a machine).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct RecordArgs {
    pub id: String,
    pub route: StoredRoute,
}

command!(
    /// GET /router: goals, settings, and what the router learned.
    View = "router.view": Ack => RouterView, read_only
);
command!(
    /// PATCH /router: goal, trying new models, allowed harnesses, rules, the steps after a run.
    Set = "router.set": RouterPatch => RouterView
);
command!(
    /// POST /router/preview: what Auto would run for this prompt, and why (no dice).
    Preview = "router.preview": PreviewArgs => PreviewResult, read_only
);
command!(
    /// POST /router/reset: forget outcomes and picks; the benchmarks stay.
    Reset = "router.reset": Ack => RouterView
);
command!(
    /// The route after the patch, or null when the task wasn't routed.
    Signal = "router.signal": SignalArgs => Option<StoredRoute>
);
command!(Record = "router.record": RecordArgs => Ack);

/// New harnesses or models showed up (they start on probation): Settings → Auto lists them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "router/")]
pub struct RouterAdded {
    pub added: Vec<Added>,
}

impl Event for RouterAdded {
    const TYPE: &'static str = "router.added";
}
