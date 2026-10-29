#!/usr/bin/env node
// Minimal stdio MCP server exposing `ask_user`, `wisp_stats`, `wisp_sessions` and `wisp_session`, injected into every agent wisp launches.
// The call is relayed to the wisp server, which surfaces it in the queue and blocks
// (by polling) until the user answers — so the agent keeps its full context.
// `delegate` and `subagent_results`: tasks for subagents, which wisp runs as child sessions while
// this call waits: the team the user picked (WISP_TEAM), or ones the agent names on the fly (any
// harness, model, machine).
// `wisp_available`, `wisp_launch` and `wisp_task` let the agent drive wisp like the user does
// (server/routes/control.js): what harnesses, machines, projects and presets there are, start a
// task anywhere, and follow up, stop, finish, archive or wait on one.
// With WISP_APPROVE, it offers `approve`: the harness's permission prompt (Claude's
// --permission-prompt-tool), answered by the user in wisp.
// `resume_later` schedules a follow-up to this same task (server/later.js).
// `wisp_tag` names the task's topics, the words the user finds it by in wisp's search.
// `wisp_pr` attaches a GitHub PR to the task: it shows like one Ship it opened, and wisp follows it.
// `wisp_save` keeps a file, text or link in the user's My Stuff (server/services/stuff.js); `wisp_stuff`
// finds what's there, with each file's path.
// `wisp_blocks` answers the full docs of the long answer blocks the protocol only names (graph, app).
// `wisp_stats` is read-only: tool counts, spend and success rate across the user's wisp sessions.
// `wisp_sessions` and `wisp_session` are read-only too: list the user's other tasks and read one's
// reports, e.g. a task the user mentioned in the prompt.
// `wisp_crew`, `wisp_crew_add`, `wisp_crew_edit` and `wisp_crew_remove` read and change the user's crew
// (server/crew.js) when the user asks; wisp refuses changes from subagents and crew members' jobs.
// `wisp_crew_kit` proposes skills and instructions files for a member: the task shows them for the
// user to pick from, so a member's job may call it too.
// `wisp_connectors`, `wisp_connector_add` and `wisp_connector_signin` read and add the user's
// connectors (MCP servers every task gets, server/connectors.js); secret values never pass through
// the agent: the sign-in card takes them.
// With WISP_SPELLS (a Cast a spell task): `wisp_spells`, `wisp_spell_schema`, `wisp_spell_data` and
// `wisp_spell_check`, to write a spell for the user to keep.

import readline from 'node:readline';
import { CREW_TOOLS } from './crew-tools.js';
import { blockDocs } from './protocol.js';

const { WISP_URL, WISP_TOKEN, WISP_SESSION, WISP_TURN, WISP_APPROVE, WISP_SPELLS, WISP_WATCH } = process.env;
const WAIT_S = 240; // wisp_task wait / wisp_launch wait=true, unless the agent asks for longer
const MAX_WAIT_S = 1800;
let TEAM = [];
try {
  TEAM = JSON.parse(process.env.WISP_TEAM || '[]');
} catch {}

const TOOL = {
  name: 'ask_user',
  description:
    'Ask the user a question through wisp and wait for their answer. Use when a decision would change the rest of your work ' +
    '(ambiguous requirements, risky/destructive steps, choosing between approaches). The user may take minutes or hours to answer. ' +
    'Do not use it for trivial choices you can make yourself.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question, one or two sentences.' },
      context: { type: 'string', description: 'Optional markdown: what you found so far and why you are asking.' },
      options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers (2–4). The user can always type their own.' },
    },
    required: ['question'],
  },
};

// resume_later: a follow-up into this same task at a later time (server/later.js).
const LATER = {
  name: 'resume_later',
  description:
    'Schedule a follow-up to this same task: at that time wisp sends your message back to you in this conversation, with your full context, ' +
    'as if the user had typed it. Use it when you must wait before you can go on (a deploy rolling out, CI running, a rate limit, ' +
    '"check again in 10 minutes"), or when the user asks you to do something later ("in 5 minutes do X"). After scheduling, end your turn ' +
    'with your report saying what you will check then; do not sleep or poll. Pass cancel with an id to drop one you scheduled.',
  inputSchema: {
    type: 'object',
    properties: {
      minutes: { type: 'number', description: 'Minutes from now (1 to 10080).' },
      at: { type: 'string', description: 'Or an ISO time with its offset, e.g. 2026-10-25T14:30+02:00.' },
      message: { type: 'string', description: 'What to do then, written to yourself: the check to run and what to do with the result.' },
      cancel: { type: 'string', description: 'The id of a follow-up you scheduled, to cancel it instead.' },
    },
  },
};

// wisp_tag: the task's topics, for the user's search (web/js/tags.js).
const TAG = {
  name: 'wisp_tag',
  description:
    'Tag this task with the topics it is about, so the user can find it later by searching wisp (⌘K, or #tag). ' +
    'Call it once you know what the task is about, in your first turn, and again only if the work moves to another topic: ' +
    'it replaces the tags. 3–8 short lowercase words or hyphenated terms a person would search for: the area or feature ' +
    '(auth, billing, search), the tech (redis, react, postgres), the kind of work (bugfix, refactor, research, release). ' +
    'Not the project name or words already in the title.',
  inputSchema: {
    type: 'object',
    properties: { tags: { type: 'array', items: { type: 'string' }, description: 'e.g. ["auth", "rate-limit", "redis", "bugfix"]' } },
    required: ['tags'],
  },
};

// wisp_pr: a PR the agent opened or worked on, shown on its task (services/ship.js, attach).
const PR = {
  name: 'wisp_pr',
  description:
    'Attach a GitHub pull request to this task, so the user sees it on the task like one opened with Ship it: its state, ' +
    'checks and reviews, kept current, with Merge. Call it for every PR you open (gh pr create) or work on in this task, ' +
    'one call per PR; a task can have several. remove=true detaches one.',
  inputSchema: {
    type: 'object',
    properties: {
      pr: { type: 'string', description: 'The PR’s URL (https://github.com/owner/repo/pull/123), or its number in this task’s repo.' },
      remove: { type: 'boolean', description: 'Detach this PR from the task instead.' },
    },
    required: ['pr'],
  },
};

// wisp_watch: a page beside the task the agent keeps updating while it works (server/watch.js).
const WATCH = {
  name: 'wisp_watch',
  description:
    'Let the user watch your work while you do it, instead of waiting for your answer: put up a page beside this task in wisp and keep it ' +
    'current as you go. Worth it for long or many-step work the user would like to follow (a migration across many files, a test or ' +
    'benchmark run, a crawl, a data job, a design taking shape); not for quick tasks or plain questions. You decide what the page shows ' +
    'and how: a progress bar and a checklist, a table filling in, a chart, a diagram growing. ' +
    'Two ways: a page you write that draws your progress, or the real thing running (the app you are building, on its dev server). ' +
    'action "open": html (one self-contained page: inline CSS and JS; scripts, styles and fonts from https CDNs are fine; no fetch, no ' +
    'relative files), path (an .html file you wrote, read again on "reload"), or url (a running app, e.g. http://localhost:5173: start its ' +
    'dev server first, in the background), a title, and optionally run: { command, cwd, note }, ' +
    'how the user runs or checks the thing themselves (shown under the page). The page uses wisp\'s theme as CSS variables ' +
    '(var(--ink), var(--muted), var(--line), var(--accent), var(--good), var(--bad), var(--surface), var(--sans), var(--mono)) and gets ' +
    'your data with wisp.on(\'state\', (s) => draw(s)) (called with the last state at once, then on every update; wisp.state is the last one). ' +
    'action "state": state (JSON, up to 64 KB: what the page draws now; merge: true merges it into the last one), caption optional. ' +
    'Send it after each meaningful step, not on every keystroke. action "caption": one line on what you are doing now. ' +
    'With a url: action "navigate" with path ("/settings") or url shows the page you just changed; "reload" when hot reload missed it; ' +
    '"state" is for your own page only. action "reload": after you edited the page. action "close": when the work is done (the page ' +
    'stays, with its last state; a url keeps showing while its server runs).',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['open', 'state', 'caption', 'navigate', 'reload', 'close'] },
      title: { type: 'string', description: 'open: a few words, e.g. "TypeScript migration".' },
      html: { type: 'string', description: 'open: the page (up to 1 MB).' },
      path: { type: 'string', description: 'open: or an .html file you wrote: absolute, or relative to your working directory. navigate: the path to show, e.g. "/settings".' },
      url: { type: 'string', description: 'open: or a running app to show, e.g. "http://localhost:5173". navigate: a full url to show instead of a path.' },
      state: { description: 'open / state: the data the page draws, any JSON.' },
      merge: { type: 'boolean', description: 'state: merge into the last state (top-level keys) instead of replacing it.' },
      caption: { type: 'string', description: 'What you are doing now, one line: "Converting auth/ (12 of 40)".' },
      run: {
        type: 'object',
        description: 'open / reload: how the user can run or check it themselves, e.g. { "command": "npm test -- --watch", "cwd": ".", "note": "re-runs on save" }.',
        properties: { command: { type: 'string' }, cwd: { type: 'string' }, note: { type: 'string' } },
      },
    },
    required: ['action'],
  },
};

// My Stuff: the user's own shelf of things kept from tasks (services/stuff.js).
const SAVE = {
  name: 'wisp_save',
  description:
    'Save something to the user\'s My Stuff in wisp: their shelf of things kept from tasks (pictures, videos, documents, code, ' +
    'any file, links), where they browse and search them later. wisp keeps a copy, so it stays when the task or its folder goes. ' +
    'Call it when the user asks you to save or keep something for them ("save that to my stuff", "keep the logo"), ' +
    'not on your own for everything you make. One item per call; give exactly one of path, text, url or app. ' +
    'For a bigger thing (slides, a demo, a small tool), build it as a static web app (index.html with its JS, CSS and assets; ' +
    'no server, no install step; bundle dependencies in or load them from a CDN) and save its folder as app: wisp serves and ' +
    'launches it for the user. With id, it updates an item they already have (a mentioned one, or from wisp_stuff) instead ' +
    'of adding one; the version before is kept. Show what you saved in your answer as a "stuff" block with its id.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'A file you made or found: absolute, or relative to your working directory.' },
      text: { type: 'string', description: 'Or text to save as a file: a note, a doc (markdown) or a snippet. Give it a name with an extension.' },
      url: { type: 'string', description: 'Or a link (http/https).' },
      app: {
        type: 'string',
        description:
          'Or an app: a folder with index.html (or wisp-app.json naming { name, entry, description, db }). node_modules and .git are left out. ' +
          'An app that keeps data (a demo\'s todos, form entries, scores) can have its own SQLite database: "db": true in wisp-app.json, ' +
          'or "db": "seed.sql" to make its tables (and sample rows) from that file in the app the first time. Its pages use it with ' +
          "import { sql } from '/_wisp/db.js'; then await sql('SELECT * FROM todos WHERE done = ?', 0) gives rows, and a write gives { changes, lastId }. " +
          'One statement per call, ? for values; no ATTACH or PRAGMA. A published app has one database for everyone who opens its link: no secrets in it.',
      },
      cover: { type: 'string', description: 'With app: a screenshot of it (png/jpg), for its card.' },
      id: { type: 'string', description: 'Update this item instead of adding one: new content (path, text, url or app) and/or title, note, tags.' },
      name: { type: 'string', description: 'File name to keep it under, e.g. "launch-plan.md". Default: the file\'s own name.' },
      title: { type: 'string', description: 'What the user sees on its card, a few words. Default: from the file name.' },
      note: { type: 'string', description: 'Optional: one or two sentences on what it is, to find it by later.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional: 1–5 short words to find it by, e.g. ["logo", "brand"].' },
      publish: {
        type: 'boolean',
        description:
          'With an app (new, or id alone to act on one they have): true puts it on the user\'s wisp Grid at a public link anyone can open ' +
          '(no sign-in), or updates the link it has with this version; the answer gives the link: send it to the user. false takes the link down. ' +
          'Only when the user asks to publish, deploy, host or share it. Needs them signed in to a wisp Grid (Settings → Cloud), or running in their cloud wisp.',
      },
    },
  },
};

const STUFF = {
  name: 'wisp_stuff',
  description:
    'List or search the user\'s My Stuff in wisp: what they (or agents) saved from tasks, newest first, each with its title, kind, ' +
    'note, tags and the path of its file (or its url). Read-only. Use it when the user refers to something they saved ' +
    '("use the logo from my stuff"): read or copy the file from its path.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Only items whose title, name, note, tags or task have all these words.' },
      id: { type: 'string', description: 'One item in full: a doc\'s or snippet\'s text, an app\'s files, and how to update it.' },
      kind: { type: 'string', enum: ['image', 'video', 'doc', 'code', 'file', 'link', 'app'] },
      limit: { type: 'number', description: 'Default 30, at most 100.' },
    },
  },
};

// Claude's permission-prompt contract: { tool_name, input, tool_use_id } in, a JSON
// { behavior: 'allow', updatedInput } or { behavior: 'deny', message } back as text.
const APPROVE = {
  name: 'approve',
  description: 'Internal: wisp asks the user to approve a tool call your permissions do not allow on their own. Never call this yourself.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name'],
  },
};

const BLOCKS = {
  name: 'wisp_blocks',
  description:
    'The fields of answer blocks your instructions only name (graph, app), with an example. Read one before you put it in ' +
    'your final message. Read-only and answered at once.',
  inputSchema: {
    type: 'object',
    properties: { types: { type: 'array', items: { type: 'string' }, description: 'e.g. ["graph"]' } },
    required: ['types'],
  },
};

const STATS = {
  name: 'wisp_stats',
  description:
    'Read-only stats about the user\'s past wisp tasks: how many tool calls each kind of action made (run = shell, read, edit, ' +
    'search, web, agent, tool = other MCP tools, ask), broken down by harness, project and day, plus turns, cost, tokens and ' +
    'success rate. Use when the user asks about their wisp usage, which tools or harnesses their tasks use, or what tasks cost.',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'How many days back, 1–365. Default 30.' },
      agent: { type: 'string', description: 'Only this harness, e.g. claude, codex, opencode.' },
      project: { type: 'string', description: 'Only this project (name or id); "current" = the project of this task.' },
    },
  },
};

const SESSIONS = {
  name: 'wisp_sessions',
  description:
    'List the user\'s other wisp tasks, newest first: id, title, state (running | waiting | review | done), harness, project, ' +
    'last update and a one-line summary. Read-only. Use it to find a task the user refers to; read one with wisp_session.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Only tasks whose title or summary has all these words.' },
      state: { type: 'string', description: 'Comma-separated, e.g. "running,waiting".' },
      project: { type: 'string', description: 'Only this project (name or id); "current" = the project of this task.' },
      archived: { type: 'boolean', description: 'Include archived tasks. Default false.' },
      limit: { type: 'number', description: 'Default 20, at most 100.' },
    },
  },
};

const SESSION = {
  name: 'wisp_session',
  description:
    'Read another wisp task by id: its title, state, harness, folder and branch, every request the user made in it, and a ' +
    'turn\'s report as markdown (summary, diffs, tests, next steps). Read-only. Use it when the prompt mentions a wisp task ' +
    '("@Title (wisp task <id>)") or the user asks what another task did.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The task id.' },
      turn: { type: 'number', description: 'Which turn\'s report, 1 = first. Default: the latest.' },
    },
    required: ['id'],
  },
};

async function crewTool(name, args = {}) {
  const path = `/api/internal/crew/${WISP_SESSION}`;
  const r =
    name === 'wisp_crew'
      ? await call(args.member ? `${path}?member=${encodeURIComponent(args.member)}` : path)
      : name === 'wisp_crew_kit'
        ? await call(`${path}/kit`, args)
        : await call(path, args, { wisp_crew_add: 'POST', wisp_crew_edit: 'PATCH', wisp_crew_remove: 'DELETE' }[name]);
  if (r.error) throw new Error(r.error);
  return r.text;
}

const CONNECTOR_TOOLS = [
  {
    name: 'wisp_connectors',
    description:
      "List the user's connectors in wisp: MCP servers that every task's agent gets (in Edits and Full auto), whatever the harness. " +
      'Each with its URL or command and whether it works, how many tools it has, or what it needs (a sign-in, a key). Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wisp_connector_add',
    description:
      'Add an MCP server to the user\'s connectors in wisp, when the user asks ("add PostHog", "connect Linear"). Remote: give its URL ' +
      '(for well-known services look up their official MCP URL, e.g. https://mcp.posthog.com/mcp). Local: give the command that starts it. ' +
      'Never pass secret values: list the names of the env vars (local) or headers (remote) it needs, and then call wisp_connector_signin, ' +
      'where the user signs in or types them. A local one asks the user first, since it runs a command on their computer. ' +
      'wisp checks it at once and says whether it works or what it needs. Tasks get it from their next turn.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lowercase letters, digits and _, e.g. posthog. Not "wisp".' },
        url: { type: 'string', description: 'Remote: its https URL (Streamable HTTP, or an older one ending in /sse).' },
        command: { type: 'string', description: 'Local: the command line that starts it, e.g. "npx -y @modelcontextprotocol/server-filesystem ~/notes".' },
        env: { type: 'array', items: { type: 'string' }, description: 'Local: names of the env vars it needs a value for, e.g. ["GITHUB_TOKEN"]. Names only.' },
        headers: { type: 'array', items: { type: 'string' }, description: 'Remote, for servers that take an API key instead of a sign-in: header names, e.g. ["Authorization"]. Names only.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'wisp_connector_signin',
    description:
      'Show the user a card in this task to sign in to a connector (a Sign in button for servers with an account, like PostHog or Linear) ' +
      'or to type the keys it needs, and wait like ask_user. It ends on its own once the connector works, or when the user skips. ' +
      'Call it after wisp_connector_add or wisp_connectors says one needs a sign-in or keys.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'The connector.' }, why: { type: 'string', description: 'One line for the card: what it is for, or where to find the key.' } },
      required: ['name'],
    },
  },
];

async function connectorTool(name, args = {}) {
  const path = `/api/internal/connectors/${WISP_SESSION}`;
  if (name === 'wisp_connectors') return (await call(path)).text;
  if (name === 'wisp_connector_add') {
    // A command that every later task would start: the user says so first.
    if (args.command && !args.url) {
      const ok = await askUser({ question: `Add ${args.name || 'this'} as a connector? Every task will start it with: ${args.command}`, options: ['Add it', 'Don’t'] });
      if (ok !== 'Add it') return ok === null ? 'The user did not answer, so nothing was added.' : `The user didn’t want it added${ok && ok !== 'Don’t' ? ` and said: ${ok}` : ''}. Nothing was added.`;
    }
    const r = await call(path, { ...args, transport: args.url ? 'remote' : 'local' });
    if (r.error) throw new Error(r.error);
    return r.text;
  }
  const r = await call(`${path}/signin`, args);
  if (r.error) throw new Error(r.error);
  if (r.text) return r.text;
  const a = await waitFor(r.id);
  if (!a) return 'The card was cancelled; nothing changed. Carry on without it.';
  if (/^Done: /.test(a.answer)) return `${a.answer.slice(6)}. Tasks get its tools from their next turn: harnesses load MCP servers when a turn starts, so this turn can't call them yet.`;
  return a.answer === 'Skip' ? 'The user skipped it for now; it stays in Settings → Connectors, where they can sign in later. Carry on without it.' : `The user answered instead: ${a.answer}`;
}

// Cast a spell tasks (WISP_SPELLS) get the tools to write one: what's installed, the reference,
// a data source's real answer, and a check that validates without installing anything.
const SPELL_TOOLS = [
  {
    name: 'wisp_spells',
    description: 'The spells the user has (on or off), each as its full JSON with a plain-words summary. Read-only.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wisp_spell_schema',
    description: 'The complete reference for writing a spell: fields, slots, parts, props, style properties, tokens, icons, actions, data sources and worked examples.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wisp_spell_data',
    description: 'Run a spell data source and return a sample of its real answer, so script reads the right shape. Read-only (wisp GET routes from the allowlist, read-only gh commands).',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'object', description: '{ "wisp": "/usage/tools?days=30" } or { "gh": ["search", "prs", "--author", "@me", "--json", "url,title"] }' },
        task: { type: 'string', description: 'Optional task id, to fill {field} templates in gh args from that task (e.g. {pr.number}).' },
      },
      required: ['source'],
    },
  },
  {
    name: 'wisp_spell_check',
    description: 'Validate a spell without installing it. Returns ok and what it does in plain words, or every problem to fix. The script is compiled, never run.',
    inputSchema: { type: 'object', properties: { spell: { type: 'object', description: 'The whole spell JSON.' } }, required: ['spell'] },
  },
];

async function spellTool(name, args = {}) {
  if (name === 'wisp_spell_data') return (await call(`/api/internal/spell-data/${WISP_SESSION}`, args)).text;
  if (name === 'wisp_spell_check') return (await call(`/api/internal/spell-check/${WISP_SESSION}`, args)).text;
  return (await call(`/api/internal/${name === 'wisp_spells' ? 'spells' : 'spell-schema'}/${WISP_SESSION}`)).text;
}

async function sessions(args = {}) {
  const q = new URLSearchParams(Object.entries(args).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
  return (await call(`/api/internal/sessions/${WISP_SESSION}?${q}`)).text;
}

async function session({ id, turn } = {}) {
  if (!id) throw new Error('id is required');
  const q = new URLSearchParams({ of: String(id), ...(turn !== undefined && { turn: String(turn) }) });
  return (await call(`/api/internal/session/${WISP_SESSION}?${q}`)).text;
}

async function stats({ days, agent, project } = {}) {
  const q = new URLSearchParams(Object.entries({ days, agent, project }).filter(([, v]) => v !== undefined && v !== ''));
  return (await call(`/api/internal/stats/${WISP_SESSION}?${q}`)).text;
}

const AGENTS = ['auto', 'claude', 'codex', 'opencode', 'cursor', 'antigravity', 'grok', 'copilot'];
const roster = TEAM.map((m) => `- ${m.name}${m.count > 1 ? ` ×${m.count} (parallel copies ${m.copies.join(', ')})` : ''}: ${[m.agent, m.model || 'default model', m.effort && `${m.effort} thinking`, m.place && `on ${m.place}`].filter(Boolean).join(' · ')}${m.use ? ` — use for: ${m.use}` : ''}`).join('\n');
const TEAM_TOOLS = [
  {
    name: 'delegate',
    description:
      'Hand tasks to your subagents (separate coding agents the user picked, each on its own harness and model). ' +
      'Tasks in one call run in parallel in your working folder. By default the call waits until every task finishes and ' +
      'returns each report plus the files it changed; wait=false returns delegation ids at once. Delegating to a subagent ' +
      'again continues its conversation.' +
      (TEAM.length ? ' Use this instead of any built-in subagent or task tool.' : '') +
      ' A task can name a subagent of the team, or create one on the fly: agent (a harness), with model, effort and machine ' +
      '(to run it on one of the user\'s machines; wisp_available lists harnesses and machines) and a name; pass that name again to continue it. ' +
      'Create them when the user asks for subagents ("have codex review it", "run the tests on my devbox") or when parallel work on other harnesses pays off. ' +
      'A subagent on another machine gets a copy of your folder (wisp carries it: no commit or push needed): name files by their path in the folder, not absolute paths, and paste in what stays behind (git-ignored files, files outside the folder).' +
      (TEAM.length ? '\n\nThe team:\n' + roster : '\n\nNo team yet.'),
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              ...(TEAM.length && { subagent: { type: 'string', enum: TEAM.flatMap((m) => (m.count > 1 ? [m.name, ...m.copies] : [m.name])), description: 'A subagent of the team. A name with copies (×N) goes to a free copy; name a copy (x#2) to continue it.' } }),
              agent: { type: 'string', enum: AGENTS, description: 'Or a new subagent on this harness (auto: wisp picks harness and model).' },
              model: { type: 'string', description: 'With agent: its model id. Default: the harness default.' },
              effort: { type: 'string', description: 'With agent: thinking level, e.g. low | medium | high.' },
              machine: { type: 'string', description: 'With agent: run it on this machine (id or name from wisp_available). Default: this computer.' },
              name: { type: 'string', description: 'With agent: a short name for it ("reviewer"). Pass the same name later to continue that subagent.' },
              use: { type: 'string', description: 'With agent: what it is for, shown to the user.' },
              prompt: { type: 'string', description: 'The task, briefed like a colleague: goal, files, constraints, how to verify. It cannot see your conversation.' },
            },
            required: ['prompt'],
          },
        },
        wait: { type: 'boolean', description: 'Wait for all tasks to finish (default true).' },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'subagent_results',
    description: 'Wait for delegated tasks and return their reports. Pass the ids delegate returned; with none, every task delegated in this turn.',
    inputSchema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, wait: { type: 'boolean', description: 'Default true; false returns current status at once.' } } },
  },
];

// Driving wisp like the user does (server/routes/control.js).
const CONTROL_TOOLS = [
  {
    name: 'wisp_available',
    description:
      'What the user has in wisp to run work on, in one read: harnesses on this computer (installed or not, models, thinking levels), ' +
      'their machines (other computers and cloud computers, online or not, the harnesses on each), projects, saved subagent presets, ' +
      'this task\'s own subagents and the crew. Read-only. Read it before you pick a harness, model or machine for delegate or wisp_launch.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wisp_launch',
    description:
      'Start a new wisp task, as the user would from wisp\'s prompt box: its own agent, conversation and card, which the user follows ' +
      'and replies to on its own. Use it when the user asks you to start, kick off or hand off tasks ("start a task to…", "open a new ' +
      'conversation for…", "run this on my devbox"); for help with your own work, use delegate instead. Returns the new task\'s id at once ' +
      '(wait=true blocks until it finishes or asks). Show each task you start in your answer as a "task" block.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task, briefed like a colleague: goal, constraints, how to verify. It cannot see your conversation.' },
        project: { type: 'string', description: 'A project by name or id (wisp_available lists them).' },
        cwd: { type: 'string', description: 'Or a folder (absolute path). Default: this task\'s project.' },
        scratch: { type: 'boolean', description: 'No project: an empty folder of its own (questions, research).' },
        also: { type: 'array', items: { type: 'string' }, description: 'More folders the same task works in (absolute paths).' },
        machine: { type: 'string', description: 'Run it on this machine (id or name). Default: where the project is, else this computer.' },
        agent: { type: 'string', enum: AGENTS, description: 'Harness. Default: the user\'s default.' },
        model: { type: 'string', description: 'Model id for that harness.' },
        effort: { type: 'string', description: 'Thinking level.' },
        mode: { type: 'string', enum: ['plan', 'edits', 'auto'], description: 'plan = read-only, edits = auto-accept edits, auto = no prompts. Default: the user\'s.' },
        worktree: { type: 'boolean', description: 'Its own git worktree (default on in git repos, except in plan mode).' },
        subagents: {
          type: 'array',
          description: 'A team the new task\'s agent can delegate to: [{ agent, model?, effort?, machine?, name?, use?, count? }].',
          items: { type: 'object', properties: { agent: { type: 'string', enum: AGENTS }, model: { type: 'string' }, effort: { type: 'string' }, machine: { type: 'string' }, name: { type: 'string' }, use: { type: 'string' }, count: { type: 'integer', minimum: 1, maximum: 5 } }, required: ['agent'] },
        },
        preset: { type: 'string', description: 'Or a saved subagent preset\'s id.' },
        wait: { type: 'boolean', description: 'Block until it finishes or asks (up to timeout_seconds).' },
        timeout_seconds: { type: 'number', description: `With wait: default ${WAIT_S}, at most ${MAX_WAIT_S}.` },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'wisp_task',
    description:
      'Act on another wisp task, as the user would from its card. action: reply (a follow-up, or the answer when it is asking; agent, ' +
      'model, effort or mode switch it from then on; queue=true waits for its current run instead of interrupting), stop, done (mark it ' +
      'done), archive, unarchive, rename (title), or wait (block until it finishes or asks, then return its report). Only when the user ' +
      'asks, or for tasks you started. Find tasks with wisp_sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task id.' },
        action: { type: 'string', enum: ['reply', 'stop', 'done', 'archive', 'unarchive', 'rename', 'wait'] },
        text: { type: 'string', description: 'reply: the message.' },
        queue: { type: 'boolean', description: 'reply: wait for its current run instead of interrupting it.' },
        mode: { type: 'string', enum: ['plan', 'edits', 'auto'] },
        agent: { type: 'string', enum: AGENTS },
        model: { type: 'string' },
        effort: { type: 'string' },
        title: { type: 'string', description: 'rename: the new title.' },
        timeout_seconds: { type: 'number', description: `wait: default ${WAIT_S}, at most ${MAX_WAIT_S}.` },
      },
      required: ['task', 'action'],
    },
  },
];

// Until the task finishes or asks, or the time is up: its report either way.
async function waitTask(id, seconds) {
  const end = Date.now() + Math.min(Math.max(Number(seconds) || WAIT_S, 1), MAX_WAIT_S) * 1000;
  for (;;) {
    let r;
    try {
      r = await call(`/api/internal/task/${WISP_SESSION}?of=${encodeURIComponent(id)}`);
    } catch (err) {
      if (Date.now() > end) throw err;
      await sleep(1500);
      continue; // wisp restarting
    }
    if (r.error) throw new Error(r.error);
    if (r.settled) return `${r.question ? `It is asking: ${r.question} (answer with wisp_task action "reply").\n\n` : ''}${r.text}`;
    if (Date.now() > end) return `Still running (timed out waiting; call wait again for more).\n\n${r.text}`;
    await sleep(2000);
  }
}

async function controlTool(name, a = {}) {
  if (name === 'wisp_available') return (await call(`/api/internal/available/${WISP_SESSION}`)).text;
  if (name === 'wisp_launch') {
    const { wait, timeout_seconds, ...body } = a;
    const r = await call(`/api/internal/launch/${WISP_SESSION}`, body);
    if (r.error) throw new Error(r.error);
    return wait && r.ids?.length ? `${r.text}\n\n---\n\n${await waitTask(r.ids[0], timeout_seconds)}` : r.text;
  }
  if (a.action === 'wait') return waitTask(a.task, a.timeout_seconds);
  const r = await call(`/api/internal/task/${WISP_SESSION}`, a);
  if (r.error) throw new Error(r.error);
  return r.text;
}

async function results(ids, wait = true) {
  for (;;) {
    let r;
    try {
      r = await call(`/api/internal/delegate/${WISP_SESSION}?ids=${encodeURIComponent((ids || []).join(','))}&turn=${WISP_TURN || ''}`);
    } catch (err) {
      if (!wait) throw err;
      await sleep(1500);
      continue; // wisp restarting — keep waiting
    }
    if (r.done || !wait) return r.text;
    await sleep(1500);
  }
}

async function delegate({ tasks, wait = true }) {
  const r = await call(`/api/internal/delegate/${WISP_SESSION}`, { tasks });
  const ok = r.delegations.filter((d) => !d.error);
  const errors = r.delegations.filter((d) => d.error).map((d) => `- ${d.subagent}: ${d.error}`).join('\n');
  if (!ok.length) return `Nothing was delegated.\n${errors}`;
  const head = errors ? `Some tasks were not delegated:\n${errors}\n\n` : '';
  if (!wait) return `${head}Delegated: ${ok.map((d) => `${d.name} (id ${d.id})`).join(', ')}. Collect the reports with subagent_results.`;
  return head + (await results(ok.map((d) => d.id)));
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(path, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(`${WISP_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-wisp-token': WISP_TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`wisp ${res.status}: ${await res.text()}`);
  return res.json();
}

// Poll a question until it's answered ({ answer, … }) or cancelled (null).
async function waitFor(id) {
  for (;;) {
    await sleep(1500);
    let r;
    try {
      r = await call(`/api/internal/ask/${id}`);
    } catch {
      continue; // wisp restarting — keep waiting
    }
    if (r.answer !== undefined) return r;
    if (r.cancelled) return null;
  }
}

async function askUser(args) {
  const { id } = await call(`/api/internal/ask`, { session: WISP_SESSION, ...args });
  return (await waitFor(id))?.answer ?? null;
}

async function approve({ tool_name: tool, input = {} }) {
  let r = await call(`/api/internal/approve`, { session: WISP_SESSION, tool, input });
  if (r.id) r = await waitFor(r.id);
  if (r?.decision === 'allow') return { behavior: 'allow', updatedInput: input };
  if (!r) return { behavior: 'deny', message: 'The user did not answer (the request was cancelled). Do not retry it; carry on without it and say what was skipped.' };
  return { behavior: 'deny', message: r.message ? `The user denied this and said: ${r.message}` : 'The user denied this. Do not retry it; carry on without it or ask how to proceed.' };
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification

  try {
    if (method === 'initialize') {
      send({ id, result: { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wisp', version: '0.1.0' } } });
    } else if (method === 'tools/list') {
      send({ id, result: { tools: [TOOL, LATER, TAG, PR, ...(WISP_WATCH ? [WATCH] : []), SAVE, STUFF, BLOCKS, STATS, SESSIONS, SESSION, ...CREW_TOOLS, ...CONNECTOR_TOOLS, ...CONTROL_TOOLS, ...(WISP_APPROVE ? [APPROVE] : []), ...TEAM_TOOLS, ...(WISP_SPELLS ? SPELL_TOOLS : [])] } });
    } else if (method === 'tools/call' && params?.name === 'ask_user') {
      const answer = await askUser(params.arguments || {});
      const text = answer === null ? 'The user did not answer (the question was cancelled). Use your best judgment and note the assumption.' : `The user answered: ${answer}`;
      send({ id, result: { content: [{ type: 'text', text }] } });
    } else if (method === 'tools/call' && params?.name === 'resume_later') {
      const a = params.arguments || {};
      send({ id, result: { content: [{ type: 'text', text: (await call(`/api/internal/later`, { session: WISP_SESSION, ...a })).text }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_tag') {
      const r = await call(`/api/internal/tags`, { session: WISP_SESSION, tags: params.arguments?.tags });
      send({ id, result: { content: [{ type: 'text', text: r.text }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_pr') {
      const r = await call(`/api/internal/prs`, { session: WISP_SESSION, pr: params.arguments?.pr, remove: !!params.arguments?.remove });
      send({ id, result: { content: [{ type: 'text', text: r.text }] } });
    } else if (method === 'tools/call' && WISP_WATCH && params?.name === 'wisp_watch') {
      const r = await call(`/api/internal/watch`, { session: WISP_SESSION, ...(params.arguments || {}) });
      send({ id, result: { content: [{ type: 'text', text: r.text }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_save') {
      const r = await call(`/api/internal/stuff`, { session: WISP_SESSION, ...(params.arguments || {}) });
      send({ id, result: { content: [{ type: 'text', text: r.text }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_stuff') {
      const a = params.arguments || {};
      const q = new URLSearchParams(Object.entries({ id: a.id, query: a.query, kind: a.kind, limit: a.limit }).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
      send({ id, result: { content: [{ type: 'text', text: (await call(`/api/internal/stuff/${WISP_SESSION}?${q}`)).text }] } });
    } else if (method === 'tools/call' && WISP_APPROVE && params?.name === 'approve') {
      send({ id, result: { content: [{ type: 'text', text: JSON.stringify(await approve(params.arguments || {})) }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_blocks') {
      send({ id, result: { content: [{ type: 'text', text: blockDocs(params.arguments?.types) }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_stats') {
      send({ id, result: { content: [{ type: 'text', text: await stats(params.arguments || {}) }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_sessions') {
      send({ id, result: { content: [{ type: 'text', text: await sessions(params.arguments || {}) }] } });
    } else if (method === 'tools/call' && params?.name === 'wisp_session') {
      send({ id, result: { content: [{ type: 'text', text: await session(params.arguments || {}) }] } });
    } else if (method === 'tools/call' && CREW_TOOLS.some((t) => t.name === params?.name)) {
      send({ id, result: { content: [{ type: 'text', text: await crewTool(params.name, params.arguments || {}) }] } });
    } else if (method === 'tools/call' && CONNECTOR_TOOLS.some((t) => t.name === params?.name)) {
      send({ id, result: { content: [{ type: 'text', text: await connectorTool(params.name, params.arguments || {}) }] } });
    } else if (method === 'tools/call' && CONTROL_TOOLS.some((t) => t.name === params?.name)) {
      send({ id, result: { content: [{ type: 'text', text: await controlTool(params.name, params.arguments || {}) }] } });
    } else if (method === 'tools/call' && params?.name === 'delegate') {
      send({ id, result: { content: [{ type: 'text', text: await delegate(params.arguments || {}) }] } });
    } else if (method === 'tools/call' && params?.name === 'subagent_results') {
      const a = params.arguments || {};
      send({ id, result: { content: [{ type: 'text', text: await results(a.ids, a.wait !== false) }] } });
    } else if (method === 'tools/call' && WISP_SPELLS && SPELL_TOOLS.some((t) => t.name === params?.name)) {
      send({ id, result: { content: [{ type: 'text', text: await spellTool(params.name, params.arguments || {}) }] } });
    } else if (method === 'ping') {
      send({ id, result: {} });
    } else {
      send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    const what = params?.name === 'ask_user' || params?.name === 'approve' ? 'wisp could not reach the user' : 'wisp';
    // A permission prompt that errors would leave the harness guessing: deny, and say why.
    if (params?.name === 'approve') send({ id, result: { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: `${what}: ${err.message}` }) }] } });
    else send({ id, result: { isError: true, content: [{ type: 'text', text: `${what}: ${err.message}` }] } });
  }
});
