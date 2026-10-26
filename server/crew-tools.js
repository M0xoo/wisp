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

// What only an edit sets: the member's notebook, their memory from job to job.
export const NOTEBOOK_PROPS = {
  notebook: { type: 'string', description: 'Their whole notebook rewritten (markdown): lasting facts and the state they compare against next time. "" empties it. To add a few lines, use remember.' },
  remember: { type: 'array', items: { type: 'string' }, maxItems: 12, description: 'Lines to add to the end of their notebook, e.g. a preference of the user\'s for this job.' },
};

export const CREW_TOOLS = [
  {
    name: 'wisp_crew',
    description:
      'List the user\'s crew in wisp: their long-lived agents, each with a name, role, brief, folder, harness, schedule and jobs. Read-only. ' +
      'Use it before changing a member, or when the user asks who is on their crew. With `member`: that one in full, their whole brief, ' +
      'notebook and kit (skills and instructions files, with their text), to read before you change their notebook or propose kit files.',
    inputSchema: { type: 'object', properties: { member: { type: 'string', description: 'Their name, @handle or id: read that member in full.' } } },
  },
  {
    name: 'wisp_crew_add',
    description:
      'Add a member to the user\'s crew in wisp, when the user asks for one ("add a crew member who watches CI"). They work as tasks: ' +
      'on their schedule (cron), when the user tags @Name in a prompt, or when another task delegates to them. Write the brief to them, ' +
      'from what the user asked. Pick a short, friendly name if the user gave none. Returns the new member. ' +
      'When the user gives a shared crew file or link ("add the member from gist:abc123"), pass it as `from` instead.',
    inputSchema: {
      type: 'object',
      properties: {
        ...MEMBER_PROPS,
        checkin: { type: 'boolean', description: 'Start their first check-in right away. Default false.' },
        from: { type: 'string', description: 'Instead of the fields above: members someone shared, as a link to a .crew.json file (https, or gist:<id>) or its JSON. They join paused, in cwd (default: the current project), until the user resumes them.' },
      },
    },
  },
  {
    name: 'wisp_crew_edit',
    description:
      'Change a member of the user\'s crew in wisp (rename, new brief, schedule, folder, harness, pause, notebook…) when the user asks. Only the fields given change. ' +
      'Their skills and instructions files aren\'t set here: propose those with wisp_crew_kit.',
    inputSchema: {
      type: 'object',
      properties: { member: { type: 'string', description: 'Their name, @handle or id.' }, ...MEMBER_PROPS, ...NOTEBOOK_PROPS },
      required: ['member'],
    },
  },
  {
    name: 'wisp_crew_kit',
    description:
      'Propose skills or instructions files for a crew member\'s kit, when the user asks you to give them, write or improve one ("give Gucci a skill for UI reviews"). ' +
      'A skill is a how-to for one kind of work, read when a job fits its description; an instructions file (rules, e.g. AGENTS.md) is followed on every job. ' +
      'Nothing changes yet: wisp shows the files under your answer, and the user reads them and picks what to add. The same name as one they have replaces it. ' +
      'Read the member with wisp_crew { member } first. Write each file for them: concrete steps, checklists, commands and paths, not generic advice.',
    inputSchema: {
      type: 'object',
      properties: {
        member: { type: 'string', description: 'Their name, @handle or id.' },
        files: {
          type: 'array',
          minItems: 1,
          maxItems: 12,
          description: 'The files to propose.',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['skill', 'rules'], description: 'skill, or rules for an instructions file.' },
              name: { type: 'string', description: 'A skill: lowercase-with-dashes, up to 64. An instructions file: its file name, e.g. AGENTS.md.' },
              description: { type: 'string', description: 'A skill only: exactly when to use it. That is how they know to read it.' },
              body: { type: 'string', description: 'The markdown: the skill\'s steps, or the instructions.' },
            },
            required: ['kind', 'name', 'body'],
          },
        },
      },
      required: ['member', 'files'],
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
export const EDIT_FIELDS = [...CREW_FIELDS, 'notebook'];

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// A member as crew.view() gives it, in one markdown item.
export const memberLine = (m) =>
  `- **${m.name}** (@${m.handle}, id \`${m.id}\`)${m.role ? ` — ${m.role}` : ''} · ${[m.agent + (m.model ? ` (${m.model})` : ''), `${m.mode} mode`, m.machine ? `on machine ${m.machine}` : m.cwd ? `in ${m.cwd}` : 'no folder', m.cron ? `checks in on \`${m.cron}\`` : 'no schedule', m.paused && 'paused', m.running && `${m.running} job${m.running === 1 ? '' : 's'} running`, m.queue?.length && `${m.queue.length} waiting`].filter(Boolean).join(' · ')}${m.brief ? `\n  Brief: ${clip(m.brief.replace(/\s+/g, ' '), 200)}` : ''}`;

// A member in full, for wisp_crew { member }: what an agent reads before changing their memory or kit.
export const memberDetail = (m) =>
  [
    memberLine({ ...m, brief: '' }),
    `\n## Brief\n\n${m.brief || '(none)'}`,
    `\n## Notebook\n\n${m.notebook ? `${m.notebook}\n\n(${m.notebook.length} characters)` : '(empty)'}`,
    `\n## Kit\n\n${(m.kit || []).length ? m.kit.map((k) => `### ${k.kind === 'skill' ? 'Skill' : 'Instructions'}: ${k.name}${k.on === false ? ' (off)' : ''}\n\n${k.kind === 'skill' ? `When: ${k.description}\n\n` : ''}${k.body}`).join('\n\n') : 'No skills or instructions files yet. Propose some with wisp_crew_kit.'}`,
  ].join('\n');
