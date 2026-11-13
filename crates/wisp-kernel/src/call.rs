//! A call in flight (plan §6.11.2): its trace (root id, depth, the `(plugin, hook)` frames it passed
//! through), who it speaks for, the plugin whose code runs it, and the buffers of the root command it
//! belongs to (events wait there until the command commits, veto follow-ups until it settles).
use std::sync::{Arc, Mutex, Weak};

use serde_json::Value;
use tokio_util::sync::CancellationToken;

use crate::caps::{Caller, Compiled};
use crate::events::Pending;
use crate::state::KernelState;
use crate::{Call, Result, WireError};

/// Calls nest at most this deep: a call at depth `MAX_DEPTH` is refused with `depth_exceeded`.
pub const MAX_DEPTH: u32 = 8;

/// A root command's buffers.
#[derive(Debug, Default)]
pub(crate) struct RootTx {
    pub(crate) events: Mutex<Vec<Pending>>,
    /// for the store's in-transaction append (durable events)
    pub(crate) kernel: Weak<KernelState>,
    /// (command, args, the context of the plugin that vetoed: the follow-up speaks for it)
    pub(crate) follow: Mutex<Vec<(String, Value, crate::host::Ctx)>>,
}

#[derive(Debug)]
pub(crate) struct CallInner {
    pub(crate) root: String,
    pub(crate) depth: u32,
    pub(crate) stack: Vec<String>,
    pub(crate) caller: Caller,
    pub(crate) cancel: CancellationToken,
    pub(crate) read_only: bool,
    /// the caller's capability set, resolved once per root call
    pub(crate) set: Option<Arc<Compiled>>,
    /// the plugin whose code runs this call: `require` checks its manifest permissions too
    pub(crate) via: Option<Arc<str>>,
    pub(crate) via_set: Option<Arc<Compiled>>,
    pub(crate) kernel: Weak<KernelState>,
    /// Some inside a command
    pub(crate) tx: Option<Arc<RootTx>>,
    /// the durable event whose handler made this call (ADR-0044), and its chain depth
    pub(crate) cause: Option<u64>,
    pub(crate) cause_depth: u32,
}

impl CallInner {
    /// A call that runs no command yet (the edge, a plugin's own timer): its first command is a root.
    pub(crate) fn detached(k: &Arc<KernelState>, caller: Caller, via: Option<Arc<str>>, cancel: CancellationToken) -> Self {
        let set = k.caps.get(&caller.set);
        let via_set = via.as_ref().and_then(|v| k.caps.get(&format!("plugin:{v}")));
        Self {
            root: crate::ids::uuid7(),
            depth: 0,
            stack: Vec::new(),
            caller,
            cancel,
            read_only: false,
            set,
            via,
            via_set,
            kernel: Arc::downgrade(k),
            tx: None,
            cause: None,
            cause_depth: 0,
        }
    }

    pub(crate) fn into_call(self) -> Call {
        Call { inner: Arc::new(self) }
    }
}

pub(crate) fn forbidden(msg: String) -> WireError {
    WireError::forbidden(msg)
}

/// Checks `p` against the caller's set and, when plugin code runs the call, against that plugin's own
/// set (its manifest's permissions): a call can only narrow as it passes through plugins.
pub(crate) fn check_sets(
    caller: Option<&Compiled>,
    caller_id: &str,
    via: Option<(&str, Option<&Compiled>)>,
    p: &crate::perm::Permission,
) -> Result<()> {
    // A plugin speaking for itself (`plugin:<id>`) is checked on its own hop; once another plugin's
    // code runs the call, that plugin acts on its own grant (capability routing). Users, agents, panes
    // and the rest narrow all the way down.
    if let Some((v, vs)) = via
        && caller_id.strip_prefix("plugin:").is_some_and(|c| c != v)
    {
        let Some(vs) = vs else {
            return Err(forbidden(format!("{v} has no capability set")));
        };
        return vs.explain(p).map_err(|why| forbidden(format!("{v} doesn't declare {p} in its manifest ({why})")));
    }
    let Some(set) = caller else {
        return Err(forbidden(format!("{caller_id} is not a capability set")));
    };
    set.explain(p).map_err(forbidden)?;
    if let Some((via, vs)) = via
        && set.id.strip_prefix("plugin:") != Some(via)
    {
        let Some(vs) = vs else {
            return Err(forbidden(format!("{via} has no capability set")));
        };
        vs.explain(p).map_err(|why| forbidden(format!("{via} doesn't declare {p} in its manifest ({why})")))?;
    }
    Ok(())
}

pub(crate) fn check(call: &CallInner, p: &crate::perm::Permission) -> Result<()> {
    let set = call.set.clone().or_else(|| call.kernel.upgrade().and_then(|k| k.caps.get(&call.caller.set)));
    check_sets(set.as_deref(), &call.caller.set, call.via.as_deref().map(|v| (v, call.via_set.as_deref())), p)
}

pub(crate) fn require(call: &CallInner, permission: &str) -> Result<()> {
    let Some(p) = crate::perm::parse(permission) else {
        return Err(WireError::invalid(format!("\"{permission}\" is not a permission")));
    };
    check(call, &p)
}

impl Call {
    /// Like `require`, for a write: also refused inside an interceptor (plan §6.11.2 rule 4). Service
    /// methods that change something start with it. Added in v2.0 (additive).
    pub fn require_write(&self, permission: &str) -> Result<()> {
        if self.inner.read_only {
            return Err(WireError::forbidden(format!("{permission} writes, and an interceptor may only read")));
        }
        require(&self.inner, permission)
    }

    /// The `(plugin, hook)` frames this call passed through, root first.
    pub fn stack(&self) -> &[String] {
        &self.inner.stack
    }

    /// The plugin whose code runs this call, if any.
    pub fn via(&self) -> Option<&str> {
        self.inner.via.as_deref()
    }

    /// The durable event whose handler made this call (ADR-0044). Additive (2026-11-09).
    pub fn cause(&self) -> Option<u64> {
        self.inner.cause
    }

    /// How many durable events deep this call's chain of causes goes (0: a person, a timer). A trigger
    /// refuses to fire past 3 (ADR-0043). Additive (2026-11-09).
    pub fn cause_depth(&self) -> u32 {
        self.inner.cause_depth
    }
}
