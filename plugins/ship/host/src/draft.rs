//! The dialog's default commit message and PR text when the caller sends none (v1 `ship.draft`): from the
//! task's last finished answer (its hero, the blocks a PR body keeps), else the task's title; the commit
//! type from its first prompt too.

use wisp_kernel::{Call, Ctx};
use wisp_runtime_api::commands as rt;
use wisp_runtime_api::model::TurnStatus;
use wisp_ship_api::Draft;
use wisp_ship_core::text::{DraftInput, draft, presentation_parts};

fn turns(id: &str, before: Option<u32>, limit: u32) -> rt::TurnsArgs {
    rt::TurnsArgs { id: id.into(), before, limit: Some(limit), masked: None }
}

/// The draft for a task, or an empty one when runtime can't say (the dialog's fields stay blank).
pub async fn draft_for(ctx: &Ctx, call: &Call, session: &str) -> Draft {
    let Ok(s) = ctx.run::<rt::Get>(call, rt::IdArgs { id: session.into() }).await else { return Draft::default() };
    let last = ctx.run::<rt::Turns>(call, turns(session, None, 5)).await.unwrap_or_default();
    let first = ctx.run::<rt::Turns>(call, turns(session, Some(1), 1)).await.unwrap_or_default();
    let answer = last.iter().rev().find(|t| t.status == TurnStatus::Done).or_else(|| last.last());
    let blocks = answer.and_then(|t| t.presentation.as_ref()).map(|p| p.blocks.as_slice()).unwrap_or_default();
    let (hero_title, hero_summary, markdown) = presentation_parts(blocks);
    let first_prompt = first.first().map_or("", |t| t.prompt.as_str());
    draft(&DraftInput { hero_title, hero_summary, session_title: &s.title, first_prompt, markdown: &markdown })
}
