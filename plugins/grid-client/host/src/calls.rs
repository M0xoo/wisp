//! The grid client's calls to other plugins, through their typed commands (`wisp-machines-api`,
//! `wisp-stuff-api`, `wisp-channels-api`), all on the root call.

use std::collections::BTreeMap;

use serde_json::Value;
use wisp_kernel::{Ctx, Result};
use wisp_machines_api::commands as m;
use wisp_stuff_api::commands as s;

/// A machines peer, as far as the grid client looks at it.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct Peer {
    pub id: String,
    pub name: String,
    pub transport: String,
    /// the transport's own fields (url, grid, handle, computer, sandbox…)
    pub data: BTreeMap<String, Value>,
}

impl Peer {
    /// One of its transport fields, as a string.
    pub fn field(&self, key: &str) -> Option<&str> {
        self.data.get(key).and_then(Value::as_str)
    }
}

/// `machines.list`: every peer (none when refused).
pub(crate) async fn peers(ctx: &Ctx) -> Vec<Peer> {
    match ctx.run::<m::List>(&ctx.root_call(), m::NoArgs {}).await {
        Ok(list) => list.into_iter().map(|p| Peer { id: p.id, name: p.name, transport: p.transport, data: p.data }).collect(),
        Err(err) => {
            tracing::warn!(error = %err.message, "grid-client: machines.list");
            Vec::new()
        }
    }
}

/// `machines.add` → the new peer's id.
pub(crate) async fn add(ctx: &Ctx, a: m::AddArgs) -> Result<String> {
    Ok(ctx.run::<m::Add>(&ctx.root_call(), a).await?.id)
}

/// `machines.update`.
pub(crate) async fn update(ctx: &Ctx, id: &str, set: m::AddArgs) -> Result<()> {
    ctx.run::<m::Update>(&ctx.root_call(), m::UpdateArgs { id: id.to_owned(), set }).await.map(|_| ())
}

/// `machines.follow`: watched, not woken.
pub(crate) async fn follow(ctx: &Ctx, id: &str) -> Result<()> {
    ctx.run::<m::Follow>(&ctx.root_call(), m::IdArgs { id: id.to_owned() }).await.map(|_| ())
}

/// `machines.remove`.
pub(crate) async fn remove(ctx: &Ctx, id: &str) -> Result<()> {
    ctx.run::<m::Remove>(&ctx.root_call(), m::IdArgs { id: id.to_owned() }).await.map(|_| ())
}

/// `stuff.bundle`: an app packed for publishing.
pub(crate) async fn bundle(ctx: &Ctx, call: &wisp_kernel::Call, id: &str) -> Result<s::AppBundle> {
    ctx.run::<s::Bundle>(call, s::Id { id: id.to_owned() }).await
}

/// `stuff.setPublished`: the link recorded (`None` takes it off).
pub(crate) async fn set_published(
    ctx: &Ctx,
    call: &wisp_kernel::Call,
    id: &str,
    published: Option<wisp_stuff_api::Published>,
) -> Result<()> {
    ctx.run::<s::SetPublished>(call, s::SetPublishedArgs { id: id.to_owned(), published }).await.map(|_| ())
}

/// `channels.routed`: a message the grid routed here. Its body is handed on as the grid sent it (the
/// channels plugin reads it), so it stays JSON.
pub(crate) async fn routed(ctx: &Ctx, args: Value) -> Result<wisp_channels_api::HttpOut> {
    ctx.run::<wisp_channels_api::Routed>(&ctx.root_call(), args).await
}

/// A follow-up call that was refused: logged (the command it's part of carries on).
pub(crate) fn warn<T>(what: &str, r: Result<T>) {
    if let Err(err) = r {
        tracing::warn!(error = %err.message, "grid-client: {what}");
    }
}
