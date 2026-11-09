//! Members' `wakes:` (ADR-0043): each is a trigger targeting its member, given to the one trigger engine through
//! `trigger.provider@1` (named `crew.<handle>.<n>`), with the member's pause and mode. `crew.graph` says who wakes
//! whom on whose report.

use std::sync::Arc;

use wisp_automations_api::{PROVIDERS, Provided, TriggerProvider};
use wisp_crew_api::Member;
use wisp_crew_api::commands::{self as c, WakeEdge, WakeGraph};
use wisp_crew_core::mentions::handle_of;
use wisp_kernel::Setup;

use crate::{State, lock};

/// Each member's wakes, as triggers aimed at it.
pub fn provided(crew: &[Member]) -> Vec<Provided> {
    crew.iter()
        .flat_map(|m| {
            m.wakes.iter().enumerate().map(move |(i, w)| {
                let mut spec = w.clone();
                spec.crew.clone_from(&m.id);
                // per-member limits apply to every wake (§5): the member's parallel is its concurrency
                if spec.concurrency.is_empty() && m.parallel > 1 {
                    spec.concurrency = format!("parallel:{}", m.parallel);
                }
                Provided { name: format!("crew.{}.{}", handle_of(&m.name), i + 1), spec, paused: m.paused, full_auto: m.mode == "auto" }
            })
        })
        .collect()
}

/// Who wakes whom.
pub fn graph(crew: &[Member]) -> WakeGraph {
    let wakes: Vec<(String, wisp_automations_api::TriggerSpec)> = crew.iter().flat_map(|m| m.wakes.iter().map(move |w| (m.name.clone(), w.clone()))).collect();
    let edges = wisp_automations_api::spec::wake_edges(&wakes);
    WakeGraph {
        cycle: wisp_automations_api::spec::wake_cycle(&edges),
        edges: edges.into_iter().map(|(from, to)| WakeEdge { from, to }).collect(),
        wakes: crew.iter().map(|m| (m.name.clone(), m.wakes.iter().map(|w| w.on.clone()).collect())).collect(),
    }
}

struct Wakes(Arc<State>);

impl TriggerProvider for Wakes {
    fn triggers(&self) -> Vec<Provided> {
        provided(&lock(&self.0.saved).crew)
    }
}

pub fn register(s: &mut Setup, st: &Arc<State>) {
    let p: Arc<dyn TriggerProvider> = Arc::new(Wakes(st.clone()));
    s.contribute(&PROVIDERS, p);
    let st = st.clone();
    s.command::<c::Graph, _, _>(move |_, _, _| {
        let st = st.clone();
        async move { Ok(graph(&lock(&st.saved).crew)) }
    });
}
