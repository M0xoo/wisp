//! wisp-mcp-core: the pure part of wisp's MCP server. No IO, no clock, no runtime: JSON-RPC framing and
//! parsing (`rpc`, `frame`), v1's tool table and what each caller is offered (`table`, `team`), the
//! dispatcher that answers what needs no kernel and hands tool calls on (`dispatch`), what each agent
//! tool runs (`plan`), v1's words for every answer (`words`, `user`) and the open asks (`asks`).

pub mod asks;
pub mod dispatch;
pub mod error;
pub mod frame;
pub mod generated;
pub mod plan;
pub mod rpc;
pub mod table;
pub mod team;
pub mod user;
pub mod words;

pub use dispatch::{Call, Extra, Outcome, Plan, Step, Who, assemble, finish, plan, tools_list};
pub use error::McpError;
pub use plan::{AgentAction, agent_action, owner_text};
