//! `crew.agent.add`, the `wisp_crew_add` tool (v1 POST /internal/crew/:id): `from` takes in what someone shared
//! (a share link, v1's gist, an https `.crew.json`, or its JSON) through `crew.import`'s own path, paused; without it
//! a member is made from the fields. In the caller's project unless it names one; a refusal is the agent's answer.

use std::sync::Arc;

use wisp_crew_api::commands as c;
use wisp_crew_core::mentions::handle_of;
use wisp_kernel::{Setup, WireError};

use crate::jobs::{checkin, now};
use crate::{State, calls};

pub(crate) fn register(s: &mut Setup, st: &Arc<State>) {
    let st = st.clone();
    s.command::<c::AgentAdd, _, _>(move |ctx, call, a| {
        let st = st.clone();
        async move {
            let refuse = |e: WireError| Ok(c::AgentText { text: None, error: Some(e.message) });
            let project = match &a.member.cwd {
                Some(cwd) => cwd.clone(),
                None => calls::task(&ctx, &call, &a.session).await.map(|t| t.cwd).unwrap_or_default(),
            };
            if let Some(from) = a.from.as_deref().filter(|f| !f.trim().is_empty()) {
                let args = crate::transfer::from_args(from);
                return match Box::pin(crate::transfer::take_in(&ctx, &call, &st, args, "agent", Some(&project))).await {
                    Ok(out) => Ok(c::AgentText { text: Some(crate::transfer::joined_text(&out.members, &project)), error: None }),
                    Err(e) => refuse(e),
                };
            }
            let body = c::MemberBody { cwd: Some(project), ..a.member.clone() };
            let m = match st.normalize(&body, None, now(&ctx), &calls::profile_names(&ctx, &call).await) {
                Ok(m) => m,
                Err(e) => return refuse(e),
            };
            st.put(m.clone());
            st.save().await;
            ctx.emit(&call, &wisp_crew_api::events::Joined { crew_id: m.id.clone(), name: m.name.clone(), how: "create".into() });
            if a.checkin == Some(true) {
                crate::calls::warn("the first check-in", checkin(&ctx, &call, &st, &m.id, false).await.map(|_| ()));
            }
            Ok(c::AgentText { text: Some(format!("Added {} to your crew (@{}).", m.name, handle_of(&m.name))), error: None })
        }
    });
}
