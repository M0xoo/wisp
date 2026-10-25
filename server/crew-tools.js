// The crew tools, shared by the MCP server in every task (mcp-ask.js) and `wisp mcp` (mcp-wisp.js):
// their definitions, what an agent may set on a member, and how a member reads back to it. Node-free: mcp-ask.js runs it too.

export const MEMBER_PROPS = {
  name: { type: 'string', description: 'Up to 24 letters, digits, spaces, dots, dashes or underscores; unique. The user tags them as @Name.' },
  role: { type: 'string', description: 'A few words, e.g. "CI watcher", "Docs writer".' },
  brief: { type: 'string', description: 'Their standing job and how the user likes it done, written to them ("Watch CI on main; when a run fails, find why and…"). Every job they run reads it.' },
  cwd: { type: 'string', description: 'Absolute path of the folder they work in. Default when adding: the current project. "" = no folder.' },
  agent: { type: 'string', description: 'Harness: auto, claude, codex, opencode, cursor, antigravity, grok or copilot. Default auto.' },
  model: { type: 'string', description: 'Model id for that harness; "" for its default.' },
  effort: { type: 'string', description: 'Thinking level, e.g. low | medium | high; "" for the default.' },
  mode: { type: 'string', enum: ['plan', 'edits', 'auto'], description: 'plan = read-only, edits = auto-accept edits, auto = no permission prompts. Default auto.' },
  cron: { type: 'string', description: 'When they check in on their own, a 5-field cron in local time ("0 9 * * 1-5" = weekdays at 9). "" = only when given work.' },
  parallel: { type: 'integer', minimum: 1, maximum: 5, description: 'Jobs at once; more wait in their queue. Default 2.' },
  paused: { type: 'boolean', description: 'Paused members skip check-ins; work for them waits.' },
  avatar: { type: 'string', description: 'An emoji. Default: one rolled from the name.' },
};

export const CREW_TOOLS = [
  {
    name: 'wisp_crew',
    description:
      'List the user\'s crew in wisp: their long-lived agents, each with a name, role, brief, folder, harness, schedule and jobs. Read-only. ' +
      'Use it before changing a member, or when the user asks who is on their crew.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wisp_crew_add',
    description:
      'Add a member to the user\'s crew in wisp, when the user asks for one ("add a crew member who watches CI"). They work as tasks: ' +
      'on their schedule (cron), when the user tags @Name in a prompt, or when another task delegates to them. Write the brief to them, ' +
      'from what the user asked. Pick a short, friendly name if the user gave none. Returns the new member.',
    inputSchema: {
      type: 'object',
      properties: { ...MEMBER_PROPS, checkin: { type: 'boolean', description: 'Start their first check-in right away. Default false.' } },
      required: ['name'],
    },
  },
  {
    name: 'wisp_crew_edit',
    description: 'Change a member of the user\'s crew in wisp (rename, new brief, schedule, folder, harness, pause…) when the user asks. Only the fields given change.',
    inputSchema: {
      type: 'object',
      properties: { member: { type: 'string', description: 'Their name, @handle or id.' }, ...MEMBER_PROPS },
      required: ['member'],
    },
  },
  {
    name: 'wisp_crew_remove',
    description:
      'Remove a member from the user\'s crew in wisp. Their brief, notebook and schedule are deleted; their jobs stay as ordinary tasks. ' +
      'Only when the user asked to remove that member; if unsure who they meant, ask the user first.',
    inputSchema: { type: 'object', properties: { member: { type: 'string', description: 'Their name, @handle or id.' } }, required: ['member'] },
  },
];

// What the tools may set (the rest is the member's memory and wisp's bookkeeping).
export const CREW_FIELDS = Object.keys(MEMBER_PROPS);

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// A member as crew.view() gives it, in one markdown item.
export const memberLine = (m) =>
  `- **${m.name}** (@${m.handle}, id \`${m.id}\`)${m.role ? ` — ${m.role}` : ''} · ${[m.agent + (m.model ? ` (${m.model})` : ''), `${m.mode} mode`, m.machine ? `on machine ${m.machine}` : m.cwd ? `in ${m.cwd}` : 'no folder', m.cron ? `checks in on \`${m.cron}\`` : 'no schedule', m.paused && 'paused', m.running && `${m.running} job${m.running === 1 ? '' : 's'} running`, m.queue?.length && `${m.queue.length} waiting`].filter(Boolean).join(' · ')}${m.brief ? `\n  Brief: ${clip(m.brief.replace(/\s+/g, ' '), 200)}` : ''}`;
