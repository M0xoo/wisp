//! Profiles, specs and snapshots (ADR-0027, ADR-0029), and the `agent` resource kind.

use std::sync::Arc;

use wisp_kernel::{Result as WireResult, Setup, WireError};
use wisp_runtime_api::commands as c;
use wisp_runtime_api::spec::{HistoryArgs, HistoryRow};
use wisp_store::Store;

use super::{Slot, rt};
use crate::runtime::Runtime;

/// Profiles, specs and snapshots (ADR-0027, ADR-0029), and the `agent` resource kind.
pub(super) fn specs(s: &mut Setup, slot: &Slot) {
    use wisp_resources_api::{CrudKind, KindInfo, RESOURCE_KIND, ResourceKind, schema_of};
    use wisp_runtime_api::spec::AgentSpec;
    let info = KindInfo::new("agent", "agents", "wisp.runtime", schema_of::<AgentSpec>()).order(20);
    let kind: Arc<dyn ResourceKind> = Arc::new(CrudKind::new::<AgentSpec>(info, s.ctx(), "runtime.profiles", "runtime.profile.set", "runtime.profile.set", "runtime.profile.remove").keyed("name", "name", "name").renames("runtime.profile.rename"));
    s.contribute(&RESOURCE_KIND, kind);
    s.command::<c::Profiles, _, _>(|ctx, _, _| async move { crate::specs::profiles(&*ctx.service::<Store>()?).await });
    s.command::<c::ProfileSet, _, _>(|ctx, _, p| async move { crate::specs::set_profile(&*ctx.service::<Store>()?, p).await });
    s.command::<c::ProfileRename, _, _>(|ctx, _, a| async move { crate::specs::rename_profile(&*ctx.service::<Store>()?, &a.from, &a.to).await });
    s.command::<c::ProfileRemove, _, _>(|ctx, _, a| async move {
        crate::specs::remove_profile(&*ctx.service::<Store>()?, &a.name).await?;
        Ok(c::Ack {})
    });
    let sp = slot.clone();
    s.command::<c::SpecOf, _, _>(move |_, _, a| {
        let slot = sp.clone();
        async move {
            let rt = rt(&slot)?;
            let s = rt.repo.session(a.id.as_str()).await.map_err(WireError::from)?;
            let turns = rt.repo.turns(a.id.as_str(), None, None).await.map_err(WireError::from)?;
            Ok(crate::specs::spec_of(&s, &turns))
        }
    });
    let hi = slot.clone();
    s.command::<c::History, _, _>(move |ctx, _, a| {
        let slot = hi.clone();
        async move {
            let rt = rt(&slot)?;
            let store = ctx.service::<Store>()?;
            history(&rt, &store, &a).await
        }
    });
    let sn = slot.clone();
    s.command::<c::SnapshotOf, _, _>(move |ctx, _, a| {
        let slot = sn.clone();
        async move {
            let store = ctx.service::<Store>()?;
            // a task's id: its spec names the hash
            let hash = match rt(&slot)?.repo.session(&a.of).await {
                Ok(s) => crate::specs::spec_of(&s, &[]).formula.ok_or_else(|| WireError::not_found(format!("task {} ran before snapshots were kept", a.of)))?,
                Err(_) => a.of.clone(),
            };
            crate::specs::snapshot(&store, &hash).await
        }
    });
}

/// `runtime.history`: every task's spec, with its cost, filtered by the profiles asked for.
async fn history(rt: &Runtime, store: &Store, a: &HistoryArgs) -> WireResult<Vec<HistoryRow>> {
    let sessions = rt.repo.sessions().await.map_err(WireError::from)?;
    let costs: std::collections::HashMap<String, f64> = rt.repo.summaries().await.map_err(WireError::from)?.into_iter().filter_map(|s| s.cost_usd.map(|c| (s.id.as_str().to_owned(), c))).collect();
    // the snapshots the profile filter needs, read once each
    let mut snaps: std::collections::HashMap<String, Option<serde_json::Value>> = std::collections::HashMap::new();
    if !a.profiles.is_empty() {
        for s in &sessions {
            if let Some(h) = crate::specs::spec_of(s, &[]).formula
                && !snaps.contains_key(&h)
            {
                let f = crate::specs::snapshot(store, &h).await.ok().map(|x| x.formula);
                snaps.insert(h, f);
            }
        }
    }
    Ok(crate::specs::history(&sessions, &costs, a, &mut |h: &str| snaps.get(h).cloned().flatten()))
}
