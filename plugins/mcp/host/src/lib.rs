//! wisp.mcp: wisp's MCP server (v1 server/mcp-ask.js for a task's agent, server/mcp-wisp.js for the
//! user's editors). `POST /api/mcp` takes one JSON-RPC message or a batch; `wisp-mcp-core` parses it,
//! answers what needs no kernel (`initialize`, `tools/list`, `ping`, refusals) and hands each tool
//! call back here, where it runs as its owner's command, through the kernel, as the caller.
//!
//! The session a tool acts for is the caller's (its token's), never an argument. A session's flags
//! (side discussion, capped, team) are what the runtime last said with `mcp.session.set`.

mod kinds;
mod run;

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use serde_json::Value;
use wisp_kernel::http::{Request, Response, Route};
use wisp_kernel::{Call, Ctx, Manifest, Plugin, Result, Setup};
use wisp_mcp_api::{Rpc, RpcArgs, SessionInfo, SessionSet, TOOL_POINT, Tools};
use wisp_mcp_core::table::OwnFlags;
use wisp_mcp_core::{Extra, Who};

/// The server's own version, for `serverInfo` on the user's side.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Default)]
pub struct McpPlugin;

/// What the runtime said about each session's run.
#[derive(Debug, Default)]
pub(crate) struct Sessions(Mutex<HashMap<String, SessionInfo>>);

impl Sessions {
    fn get(&self, id: &str) -> SessionInfo {
        self.0.lock().unwrap_or_else(PoisonError::into_inner).get(id).cloned().unwrap_or_default()
    }
    fn set(&self, id: String, info: Option<SessionInfo>) {
        let mut m = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        match info {
            Some(i) => m.insert(id, i),
            None => m.remove(&id),
        };
    }
}

/// Contributed tools as the dispatcher sees them, in the order plugins added them.
pub(crate) fn extras(ctx: &Ctx) -> (Vec<Extra>, Vec<Arc<wisp_mcp_api::ToolContribution>>) {
    let list = ctx.contributions(&TOOL_POINT);
    let ex = list
        .iter()
        .map(|c| Extra {
            name: c.tool.get("name").and_then(Value::as_str).unwrap_or_default().to_owned(),
            raw: c.tool.to_string(),
            audience: c.audience,
            flags: OwnFlags { read_only: c.read_only, capped_off: c.capped_off },
        })
        .collect();
    (ex, list)
}

/// Who `call` speaks for, with its session's flags (and what `mcp.session@1` contributors add).
pub(crate) fn who(ctx: &Ctx, call: &Call, sessions: &Sessions) -> Who {
    let caller = call.caller();
    let info = caller.session.as_deref().map(|s| sessions.get(s)).unwrap_or_default();
    let _ = ctx;
    Who::of(&caller.set, caller.session.as_deref(), info, VERSION)
}

fn route(sessions: Arc<Sessions>) -> Route {
    Route {
        method: "POST",
        pattern: wisp_mcp_api::MCP_PATH,
        permission: "mcp:call",
        doc: true,
        summary: "MCP over HTTP: one JSON-RPC message or a batch (initialize, tools/list, tools/call)",
        raw: false,
        max_body: None,
        handler: Arc::new(move |ctx, call, req: Request| {
            let sessions = sessions.clone();
            Box::pin(async move {
                let text = String::from_utf8_lossy(&req.body).into_owned();
                let cwd = req.header("x-wisp-cwd").map(str::to_owned);
                match run::rpc(&ctx, &call, &sessions, &text, cwd).await {
                    Some(body) => Ok(Response::Text { status: 200, content_type: "application/json".into(), body }),
                    // only notifications: nothing to answer
                    None => Ok(Response::Text { status: 202, content_type: "application/json".into(), body: String::new() }),
                }
            })
        }),
    }
}

impl Plugin for McpPlugin {
    fn manifest(&self) -> Manifest {
        Manifest::embedded(include_str!("../wisp-plugin.json"))
    }

    fn setup(&self, s: &mut Setup) -> Result<()> {
        crate::kinds::register(s);
        let sessions = Arc::new(Sessions::default());
        s.route(route(sessions.clone()));
        let st = sessions.clone();
        s.command::<Rpc, _, _>(move |ctx, call, a: RpcArgs| {
            let st = st.clone();
            async move {
                let text = a.msg.to_string();
                Ok(run::rpc(&ctx, &call, &st, &text, a.cwd).await.and_then(|s| serde_json::from_str(&s).ok()))
            }
        });
        let st = sessions.clone();
        s.command::<Tools, _, _>(move |ctx, call, _a| {
            let st = st.clone();
            async move {
                let w = who(&ctx, &call, &st);
                let (ex, _) = extras(&ctx);
                let list: Value = serde_json::from_str(&wisp_mcp_core::tools_list(&w, &ex)).unwrap_or(Value::Null);
                Ok(list.get("tools").and_then(Value::as_array).cloned().unwrap_or_default())
            }
        });
        let st = sessions;
        s.command::<SessionSet, _, _>(move |_ctx, _call, a| {
            let st = st.clone();
            async move {
                st.set(a.session, a.info);
                Ok(())
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_is_valid() {
        assert_eq!(McpPlugin.manifest().id, "wisp.mcp");
    }
}
