//! `runtime.agents` detects every harness at once: each detect spawns its CLI a few times, and one after another
//! `wisp_available`, `wisp_agents` and Settings → Agents waited for the sum of every probe, not the slowest harness.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod common;

use std::sync::Arc;
use std::time::Duration;

use common::{Fake, rig_on};
use tokio::sync::Barrier;
use wisp_kernel::BoxFuture;
use wisp_runtime::Recorder;
use wisp_runtime_api::Harness;
use wisp_runtime_api::commands::AgentsArgs;
use wisp_runtime_api::harness::{HarnessFound, HarnessInfo, HarnessRun, HarnessSys, Launch, RunDriver};

/// A harness whose detect answers only once every harness's detect has started.
struct Meets {
    inner: Arc<dyn Harness>,
    all: Arc<Barrier>,
}

impl Harness for Meets {
    fn info(&self) -> &HarnessInfo {
        self.inner.info()
    }
    fn detect<'a>(&'a self, _sys: &'a dyn HarnessSys) -> BoxFuture<'a, HarnessFound> {
        Box::pin(async move {
            self.all.wait().await;
            HarnessFound { available: true, version: Some(format!("{} 1.0", self.inner.info().id)), ..HarnessFound::default() }
        })
    }
    fn launch(&self, run: &HarnessRun) -> wisp_kernel::Result<Launch> {
        self.inner.launch(run)
    }
    fn driver(&self, run: &HarnessRun) -> Box<dyn RunDriver> {
        self.inner.driver(run)
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn runtime_agents_detects_every_harness_at_once_in_registration_order() {
    let ids = ["a", "b", "c", "d"];
    let all = Arc::new(Barrier::new(ids.len()));
    let harnesses: Vec<Arc<dyn Harness>> =
        ids.iter().map(|id| Arc::new(Meets { inner: Fake::named(id, id, &[]), all: all.clone() }) as Arc<dyn Harness>).collect();
    let r = rig_on(Recorder::default(), harnesses).await;
    // one at a time, the first detect waits forever for the others
    let list = tokio::time::timeout(Duration::from_secs(5), r.rt.agents(&AgentsArgs::default()))
        .await
        .expect("runtime.agents ran the detects one after another");
    assert_eq!(list.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ids, "the list keeps the harnesses' order");
    assert!(list.iter().all(|a| a.available && a.version.as_deref() == Some(&format!("{} 1.0", a.id))), "{list:?}");
}
