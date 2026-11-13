//! The commands of other plugins that wisp.mcp's tools run, by id: each is the port of the v1
//! `/api/internal/*` route (agent tools) or client-SDK call (`wisp mcp`) behind a tool. Their owners
//! register them (`tools/check` rust-mcp-owners fails a const no host registers); the tools that run a typed
//! command (`wisp_launch`, `approve`, `delegate`, `wisp mcp`'s own) name its type in wisp-mcp-host instead.
//!
//! Agent commands take the tool's arguments plus `session` (the caller's, set by wisp.mcp over whatever
//! the arguments say) and answer v1's route body: `{ text }`, or `{ error }` for a refusal the agent
//! reads. The caller's capability set is checked against each one's permission (`a.b.c` → `a:b.c`).

// ---- a task's agent (v1 server/mcp-ask.js) ----
pub const LATER_SCHEDULE: &str = "later.agent.schedule"; // POST /internal/later
pub const TAG: &str = "runtime.agent.tag"; // POST /internal/tags
pub const PR: &str = "ship.agent.pr"; // POST /internal/prs
pub const WATCH: &str = "runtime.agent.watch"; // POST /internal/watch (owned by wisp.runtime: the watch is the task's)
pub const STUFF_SAVE: &str = "stuff.agent.save"; // POST /internal/stuff
pub const STUFF_LIST: &str = "stuff.agent.list"; // GET /internal/stuff/:id
pub const BLOCKS: &str = "runtime.agent.blocks"; // v1 protocol.js blockDocs(types), answered in the child
pub const STATS: &str = "runtime.agent.stats"; // GET /internal/stats/:id
pub const SESSIONS: &str = "runtime.agent.sessions"; // GET /internal/sessions/:id
pub const SESSION: &str = "runtime.agent.session"; // GET /internal/session/:id?of&turn
pub const CREW_LIST: &str = "crew.agent.list"; // GET /internal/crew/:id?member
pub const CREW_ADD: &str = "crew.agent.add"; // POST /internal/crew/:id
pub const CREW_EDIT: &str = "crew.agent.edit"; // PATCH /internal/crew/:id
pub const CREW_KIT: &str = "crew.agent.kit"; // POST /internal/crew/:id/kit
pub const CREW_REMOVE: &str = "crew.agent.remove"; // DELETE /internal/crew/:id
pub const CONNECTORS_LIST: &str = "connectors.agent.list"; // GET /internal/connectors/:id
pub const CONNECTORS_ADD: &str = "connectors.agent.add"; // POST /internal/connectors/:id
/// → `{ text }`, or `{ id }`: an ask it opened with `mcp.ask.open`, answered "Done: …" when it works
pub const CONNECTORS_SIGNIN: &str = "connectors.agent.signin"; // POST /internal/connectors/:id/signin
pub const AVAILABLE: &str = "runtime.agent.available"; // GET /internal/available/:id
pub const TASK: &str = "runtime.agent.task"; // POST /internal/task/:id

/// `a.b.c` → `a:b.c`: the kernel's default permission for a command id.
pub fn permission(command: &str) -> String {
    command.replacen('.', ":", 1)
}
