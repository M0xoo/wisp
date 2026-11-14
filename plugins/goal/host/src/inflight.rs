//! The judges' quick runs under way, by task (in memory: a restart ends them, `recover` records it): a goal dropped,
//! set again or its task deleted stops them (`runtime.quickCancel`, routed to the sandbox's machine for one there),
//! so a judge whose vote would be thrown away stops spending tokens.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;
use wisp_kernel::{Code, Command, Ctx, Result, WireError};
use wisp_runtime_api::commands as rt;

/// One judge's run under way: its id (the check's) and the machine it runs on (None: here).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Run {
    id: String,
    machine: Option<String>,
}

/// Each task's judges' runs under way.
#[derive(Debug, Clone, Default)]
pub struct Inflight(Arc<Mutex<HashMap<String, Vec<Run>>>>);

/// A run's place in [`Inflight`], gone with the judge however it ends.
pub(crate) struct Held {
    all: Inflight,
    task: String,
    run: String,
}

impl Drop for Held {
    fn drop(&mut self) {
        let mut m = self.all.lock();
        if let Some(runs) = m.get_mut(&self.task) {
            runs.retain(|r| r.id != self.run);
            if runs.is_empty() {
                m.remove(&self.task);
            }
        }
    }
}

impl Inflight {
    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<Run>>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// `run` (on `machine`) is about to judge `task`'s goal: a stop from here on reaches it.
    pub(crate) fn hold(&self, task: &str, run: &str, machine: Option<&str>) -> Held {
        self.lock().entry(task.to_owned()).or_default().push(Run { id: run.to_owned(), machine: machine.map(str::to_owned) });
        Held { all: self.clone(), task: task.to_owned(), run: run.to_owned() }
    }

    /// The runs under way for `task` (only those of `only`, when given), taken: (id, machine).
    pub fn take(&self, task: &str, only: Option<&[String]>) -> Vec<(String, Option<String>)> {
        let mut m = self.lock();
        let Some(runs) = m.get_mut(task) else { return Vec::new() };
        let (out, keep): (Vec<Run>, Vec<Run>) = runs.drain(..).partition(|r| only.is_none_or(|o| o.contains(&r.id)));
        if keep.is_empty() {
            m.remove(task);
        } else {
            *runs = keep;
        }
        out.into_iter().map(|r| (r.id, r.machine)).collect()
    }

    /// The judges still running for `task` (only the runs `only` names, when given: a new goal's own round, started
    /// as it was set, goes on) are stopped, their process trees killed. How many were.
    pub(crate) async fn stop(&self, ctx: &Ctx, task: &str, only: Option<&[String]>) -> usize {
        let mut n = 0;
        for (run, machine) in self.take(task, only) {
            match cancel(ctx, machine.as_deref(), &run).await {
                Ok(()) => n += 1,
                Err(e) => tracing::warn!(task = %task, run = %run, "goal: stopping a judge: {}", e.message),
            }
        }
        n
    }
}

/// `runtime.quickCancel` for one run, here or on its machine (`machines.route`, as the run itself went).
async fn cancel(ctx: &Ctx, machine: Option<&str>, run: &str) -> Result<()> {
    let a = rt::QuickCancelArgs { run_id: run.to_owned() };
    let Some(machine) = machine else { return ctx.run::<rt::QuickCancel>(&ctx.root_call(), a).await.map(|_| ()) };
    let args = serde_json::to_value(&a).map_err(|e| WireError::internal(e.to_string()))?;
    let r = wisp_machines_api::RouteArgs {
        id: Some(machine.to_owned()),
        cmd: <rt::QuickCancel as Command>::ID.to_owned(),
        args,
        mid: format!("judge-stop-{}", wisp_kernel::ids::uuid7()),
    };
    ctx.run::<wisp_machines_api::Route>(&ctx.root_call(), r).await.map(|_| ())
}

/// A judge's run that `runtime.quickCancel` stopped: the runtime says so in `details.cancelled`; relayed by a peer
/// (`machines.route` keeps the code and message, not the details) its message says it.
pub fn was_cancelled(e: &WireError) -> bool {
    e.details.as_ref().and_then(|d| d.get("cancelled")).and_then(Value::as_bool) == Some(true)
        || (e.code == Code::Conflict && e.message == rt::QUICK_CANCELLED)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_judges_place_goes_with_it_and_a_stop_takes_the_tasks_runs() {
        let all = Inflight::default();
        let a = all.hold("t1", "r1", None);
        let _b = all.hold("t1", "r2", Some("box"));
        let _c = all.hold("t2", "r3", None);
        let _d = all.hold("t1", "r4", None);
        drop(a);
        assert_eq!(all.take("t1", Some(&["r2".to_owned()])), vec![("r2".to_owned(), Some("box".to_owned()))], "only the old goal's");
        assert_eq!(all.take("t1", None), vec![("r4".to_owned(), None)]);
        assert!(all.take("t1", None).is_empty(), "taken once");
        assert_eq!(all.take("t2", None).len(), 1, "another task's runs are its own");
        assert!(was_cancelled(&WireError::conflict("x").with_details(serde_json::json!({ "cancelled": true }))));
        assert!(!was_cancelled(&WireError::conflict("It took over 300 s and was stopped.")));
        let relayed = wisp_machines_api::service::peer_error(rt::QUICK_CANCELLED, 409, None);
        assert!(was_cancelled(&relayed), "a sandbox's judge, stopped on its machine: {relayed:?}");
    }
}
