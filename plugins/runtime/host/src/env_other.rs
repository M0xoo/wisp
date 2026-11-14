//! `runtime.envmask@1` (ADR-0054): other plugins mask what an agent wrote about a task in their own kinds (wisp.goal's
//! `goal_run`) against what that task read, in their own `kernel.egress` views. What a task read comes from memory;
//! a task not in memory is read back once in the background (`env_view::known_of`) and its text hidden meanwhile.

use std::sync::Arc;

use serde_json::Value;
use wisp_kernel::Ctx;
use wisp_runtime_api::env::EnvMask;
use wisp_runtime_core::env_other;

use crate::env_view::{Loading, known_of, on};
use crate::plugin::Slot;

pub(crate) struct Other(pub(crate) Ctx, pub(crate) Slot, pub(crate) Arc<Loading>);

impl EnvMask for Other {
    fn mask(&self, task: Option<&str>, v: &mut Value) -> bool {
        if !on(&self.0) {
            return false;
        }
        let known = task.and_then(|t| known_of(&self.1, &self.2, t));
        env_other::mask_other(v, known.as_deref())
    }
    fn ranges(&self, task: &str, v: &Value) -> Option<Value> {
        let known = known_of(&self.1, &self.2, task)?;
        Some(env_other::ranges_of(v, &known))
    }
    fn mask_kept(&self, task: Option<&str>, v: &mut Value, kept: Option<&Value>) -> bool {
        if !on(&self.0) {
            return false;
        }
        let known = task.and_then(|t| known_of(&self.1, &self.2, t));
        // a record no task owns can't have been ranged against one
        env_other::mask_other_kept(v, kept.filter(|_| task.is_some()), known.as_deref())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::sync::{Arc, OnceLock};

    use serde_json::json;
    use wisp_runtime_core::activity::EnvValues;
    use wisp_store::{Location, Store, SystemClock};

    use super::*;
    use crate::env_view::lock;
    use crate::repo::Repo;
    use crate::runtime::Runtime;

    fn slot() -> Slot {
        let store = Store::open(Location::Memory, Arc::new(SystemClock)).unwrap();
        crate::schema::install(&store).unwrap();
        let sim = wisp_proc::sim::SimProc::new();
        let r = Runtime::new(Repo::new(store), Arc::new(crate::host::Recorder::default()), Arc::new(sim), Arc::new(SystemClock));
        let slot: Slot = Arc::new(OnceLock::new());
        let _ = slot.set(r);
        slot
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn another_plugins_text_is_masked_against_its_tasks_values_in_memory_and_hidden_while_they_are_read_back() {
        let slot = slot();
        let r = crate::plugin::rt(&slot).unwrap();
        r.env_known("s1").await.unwrap();
        r.env_remember("s1", &EnvValues(vec!["sk-live-one".into()]));
        let loading: Arc<Loading> = Arc::default();
        let known = |sid| known_of(&slot, &loading, sid);
        let mut why = json!("the key sk-live-one is live");
        assert!(env_other::mask_other(&mut why, known("s1").as_deref()));
        assert_eq!(why, "the key •••• is live");
        // a task not in memory: hidden now, read back for the next send
        let mut why = json!("the key sk-live-one is live");
        assert!(env_other::mask_other(&mut why, known("s2").as_deref()));
        assert_eq!(why, "••••");
        assert!(lock(&loading).contains("s2") || r.env.get("s2").is_some());
        // no task named: hidden
        let mut why = json!("anything");
        assert!(env_other::mask_other(&mut why, None));
        assert_eq!(why, "••••");
    }
}
