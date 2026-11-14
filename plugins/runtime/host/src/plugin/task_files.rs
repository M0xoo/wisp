//! What a task tells My Stuff (`stuff.task-files@1`, wisp-stuff-api): its title, whether it runs in Full auto right
//! now (a pane's scopes never widen then, v1 `runsFullAuto`), and the file Save to My Stuff copies from it (v1
//! `taskFile`). Without it My Stuff can neither refuse a grant during Full auto nor save a reply's picture.

use std::sync::Arc;

use wisp_kernel::{BoxFuture, Call, Result as WireResult, Setup, WireError};
use wisp_runtime_api::model::{Mode, Session, SessionState};
use wisp_stuff_api::commands::{TaskFiles, TaskFilesService, TaskInfo};

use super::{Slot, rt};
use crate::error::RuntimeError;

struct Files(Slot);

/// v1 `runsFullAuto`: Full auto and a turn running now.
pub(crate) fn runs_full_auto(s: &Session) -> bool {
    s.mode == Mode::Auto && s.state == SessionState::Running
}

/// A task that isn't here is none, not a failure.
fn absent<T>(r: crate::error::Result<T>) -> WireResult<Option<T>> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(RuntimeError::NoTask(_)) => Ok(None),
        Err(e) => Err(WireError::from(e)),
    }
}

impl TaskFiles for Files {
    fn task(&self, call: &Call, id: &str) -> BoxFuture<'static, WireResult<Option<TaskInfo>>> {
        let (slot, call, id) = (self.0.clone(), call.clone(), id.to_owned());
        Box::pin(async move {
            call.require("stuff:read")?;
            let s = absent(rt(&slot)?.get(&id).await)?;
            Ok(s.map(|s| TaskInfo { id: s.id.0.clone(), title: s.title.clone(), full_auto: runs_full_auto(&s) }))
        })
    }

    fn file(&self, call: &Call, id: &str, asked: &str) -> BoxFuture<'static, WireResult<Option<String>>> {
        let (slot, call, id, asked) = (self.0.clone(), call.clone(), id.to_owned(), asked.to_owned());
        Box::pin(async move {
            call.require("stuff:read")?;
            let f = absent(rt(&slot)?.task_file(&id, &asked).await)?.flatten();
            Ok(f.map(|p| p.display().to_string()))
        })
    }
}

pub(crate) fn provide(s: &mut Setup, slot: &Slot) {
    let f: Arc<dyn TaskFiles> = Arc::new(Files(slot.clone()));
    s.provide::<TaskFilesService>(f);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_running_full_auto_turn_counts_as_running_in_full_auto_v1_runs_full_auto() {
        let s = |mode, state| Session { mode, state, ..Session::default() };
        assert!(runs_full_auto(&s(Mode::Auto, SessionState::Running)));
        assert!(!runs_full_auto(&s(Mode::Auto, SessionState::Review)), "Full auto, but nothing runs");
        assert!(!runs_full_auto(&s(Mode::Edits, SessionState::Running)), "running, but someone reads its cards");
        assert!(!runs_full_auto(&s(Mode::Plan, SessionState::Waiting)));
    }
}
