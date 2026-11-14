//! Kit offers (v1 crew.js `propose`, `settleOffer`): `crew.agent.kit`, the `wisp_crew_kit` tool, keeps the files an
//! agent proposed on the member under the caller's latest turn; `crew.update`'s `offers` settles them.

use std::sync::Arc;

use wisp_crew_api::Member;
use wisp_crew_api::commands::{self as c, OfferSettle};
use wisp_crew_core::kit::Ids as _;
use wisp_crew_core::offers::{offer_from_job, propose, proposed_text, settle};
use wisp_kernel::Setup;

use crate::jobs::now;
use crate::{NewIds, State, calls};

/// The offers you added or dismissed, settled on `m` (unknown ids and states change nothing).
pub(crate) fn settle_all(m: &mut Member, list: Option<&Vec<OfferSettle>>, now: i64) {
    for o in list.into_iter().flatten() {
        settle(m, &o.id, &o.state, &o.names, now);
    }
}

/// A job's turn ended with files in its crew block (a kit job's proposal): an offer under that job.
pub(crate) async fn from_report(
    ctx: &wisp_kernel::Ctx,
    call: &wisp_kernel::Call,
    st: &State,
    crew_id: &str,
    job: &str,
    kit: &[serde_json::Value],
) {
    if kit.is_empty() {
        return;
    }
    let Ok(mut m) = st.member(crew_id) else { return };
    if offer_from_job(&mut m, job, kit, NewIds.next_id(), now(ctx)).is_some() {
        st.put(m.clone());
        st.save().await;
        ctx.emit(call, &wisp_crew_api::events::MemberChanged { crew_id: m.id });
    }
}

pub(crate) fn register(s: &mut Setup, st: &Arc<State>) {
    let st = st.clone();
    s.command::<c::AgentKit, _, _>(move |ctx, call, a| {
        let st = st.clone();
        async move {
            // a refusal the agent acts on is its answer, not a failed call (v1's `{ error }` body)
            let refuse = |e: String| Ok(c::AgentText { text: None, error: Some(e) });
            let turn =
                calls::turns(&ctx, &call, &a.session).await.ok().and_then(|t| t.last().map(|t| t.id.to_string())).unwrap_or_default();
            // read the member after the await, and write it back with none between: a change made meanwhile stays
            let mut m = match st.member(&a.member) {
                Ok(m) => m,
                Err(e) => return refuse(e.message),
            };
            match propose(&mut m, &a.session, &turn, &a.files, NewIds.next_id(), now(&ctx)) {
                Ok((offer, refused)) => {
                    let text = proposed_text(&m, &offer, &refused);
                    st.put(m.clone());
                    st.save().await;
                    ctx.emit(&call, &wisp_crew_api::events::MemberChanged { crew_id: m.id });
                    Ok(c::AgentText { text: Some(text), error: None })
                }
                Err(e) => refuse(e.to_string()),
            }
        }
    });
}
