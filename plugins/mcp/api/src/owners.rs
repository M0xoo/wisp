//! The commands of other plugins that wisp.mcp's tools run, by id: each is the port of the v1
//! `/api/internal/*` route (agent tools) or client-SDK call (`wisp mcp`) behind a tool. Their owners
//! register them; until an owner's `api` crate declares one, this list is where its id is agreed.
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
pub const SPELLS: &str = "plugins.agent.spells"; // GET /internal/spells/:id
pub const SPELL_SCHEMA: &str = "plugins.agent.spellSchema"; // GET /internal/spell-schema/:id
pub const SPELL_DATA: &str = "plugins.agent.spellData"; // POST /internal/spell-data/:id
pub const SPELL_CHECK: &str = "plugins.agent.spellCheck"; // POST /internal/spell-check/:id
pub const AVAILABLE: &str = "runtime.agent.available"; // GET /internal/available/:id
/// → `{ text, ids }`
pub const LAUNCH: &str = "runtime.agent.launch"; // POST /internal/launch/:id
pub const TASK: &str = "runtime.agent.task"; // POST /internal/task/:id
/// → `{ settled, question?, text }` (read-only)
pub const TASK_STATE: &str = "runtime.agent.taskState"; // GET /internal/task/:id?of
/// → `{ decision }` at once, or `{ id }`: an ask it opened with `mcp.ask.open`
pub const APPROVAL: &str = "runtime.agent.approval"; // POST /internal/approve
/// → `{ delegations: [{ id?, name?, subagent?, error? }] }`
pub const DELEGATE: &str = "runtime.agent.delegate"; // POST /internal/delegate/:id
/// `{ ids, turn }` → `{ done, text }` (read-only)
pub const RESULTS: &str = "runtime.agent.results"; // GET /internal/delegate/:id?ids&turn

// ---- the user's editors (v1 server/mcp-wisp.js, through the client SDK) ----
pub const CREATE: &str = "runtime.create"; // POST /api/sessions → { id }
pub const GET: &str = "runtime.get"; // GET /api/sessions/:id
pub const LIST: &str = "runtime.list"; // GET /api/sessions
pub const MARKDOWN: &str = "runtime.markdown"; // GET /api/sessions/:id/presentation → { markdown }
pub const FOLLOW_UP: &str = "runtime.followUp"; // POST /api/sessions/:id/reply
pub const STOP: &str = "runtime.stop"; // POST /api/sessions/:id/stop
pub const AGENTS: &str = "runtime.agents"; // GET /api/agents
pub const MACHINES: &str = "machines.list"; // GET /api/machines
pub const CREW_ALL: &str = "crew.list"; // GET /api/crew
pub const CREW_GET: &str = "crew.get"; // GET /api/crew/:key (name, @handle or id)
pub const CREW_CREATE: &str = "crew.add"; // POST /api/crew
pub const CREW_UPDATE: &str = "crew.update"; // PATCH /api/crew/:id
pub const CREW_DELETE: &str = "crew.remove"; // DELETE /api/crew/:id
pub const CREW_IMPORT: &str = "crew.import"; // POST /api/crew/import

/// Every command id above, for the manifest and capability sets.
pub const ALL: &[&str] = &[
    LATER_SCHEDULE,
    TAG,
    PR,
    WATCH,
    STUFF_SAVE,
    STUFF_LIST,
    BLOCKS,
    STATS,
    SESSIONS,
    SESSION,
    CREW_LIST,
    CREW_ADD,
    CREW_EDIT,
    CREW_KIT,
    CREW_REMOVE,
    CONNECTORS_LIST,
    CONNECTORS_ADD,
    CONNECTORS_SIGNIN,
    SPELLS,
    SPELL_SCHEMA,
    SPELL_DATA,
    SPELL_CHECK,
    AVAILABLE,
    LAUNCH,
    TASK,
    TASK_STATE,
    APPROVAL,
    DELEGATE,
    RESULTS,
    CREATE,
    GET,
    LIST,
    MARKDOWN,
    FOLLOW_UP,
    STOP,
    AGENTS,
    MACHINES,
    CREW_ALL,
    CREW_GET,
    CREW_CREATE,
    CREW_UPDATE,
    CREW_DELETE,
    CREW_IMPORT,
];

/// `a.b.c` → `a:b.c`: the kernel's default permission for a command id.
pub fn permission(command: &str) -> String {
    command.replacen('.', ":", 1)
}
