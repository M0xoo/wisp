// The tools every task's agent gets: ask, follow-ups, tags, PRs, the watch page, My Stuff, reads.
// Copied from v1 word for word (server/mcp-ask.js): agents read these, and test/goldens hold v1's own
// tools/list output for every mode. Change one only on purpose, with its golden.

import type { Tool } from './tool.ts';

export const TOOL: Tool = {
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
export const LATER: Tool = {
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
export const TAG: Tool = {
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
export const PR: Tool = {
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
export const WATCH: Tool = {
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
export const SAVE: Tool = {
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
          'Or an app: a folder with index.html (or wisp-app.json naming { name, entry, description, db }). node_modules, .git, .env files, credentials, keys and source maps are left out. ' +
          'An app that keeps data (a demo\'s todos, form entries, scores) can have its own SQLite database: "db": true in wisp-app.json, ' +
          'or "db": "seed.sql" to make its tables (and sample rows) from that file in the app the first time. Its pages use it with ' +
          "import { sql } from '/_wisp/db.js'; then await sql('SELECT * FROM todos WHERE done = ?', 0) gives rows, and a write gives { changes, lastId }. " +
          'One statement per call, ? for values; no ATTACH or PRAGMA. A published app has one database for everyone who opens its link: anyone with the link can read and change its data, so no personal data and no secrets in it.',
      },
      cover: { type: 'string', description: 'With app: a screenshot of it (png/jpg), for its card.' },
      id: { type: 'string', description: 'Update this item instead of adding one: new content (path, text, url or app) and/or title, note, tags.' },
      name: { type: 'string', description: 'File name to keep it under, e.g. "launch-plan.md". Default: the file\'s own name.' },
      title: { type: 'string', description: 'What the user sees on its card, a few words. Default: from the file name.' },
      note: { type: 'string', description: 'Optional: one or two sentences on what it is, to find it by later.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional: 1–5 short words to find it by, e.g. ["logo", "brand"].' },
      pin: {
        type: 'string',
        enum: ['home', 'task'],
        description: 'With an app, in a Make a pane task only (ignored elsewhere): show it as a pane on home, or beside tasks. Pinning grants nothing: the user allows what it uses from its bar.',
      },
      publish: {
        type: 'boolean',
        description:
          'With an app (new, or id alone to act on one they have): true puts it on the user\'s wisp Grid at a public link anyone can open ' +
          '(no sign-in), or updates the link it has with this version; the answer gives the link: send it to the user. false takes the link down. ' +
          'A key or token in its files stops the publish: the answer says which file and line; take it out and publish again. ' +
          'Only when the user asks to publish, deploy, host or share it. Needs them signed in to a wisp Grid (Settings → Cloud), or running in their cloud wisp.',
      },
    },
  },
};

export const STUFF: Tool = {
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
export const APPROVE: Tool = {
  name: 'approve',
  description: 'Internal: wisp asks the user to approve a tool call your permissions do not allow on their own. Never call this yourself.',
  inputSchema: {
    type: 'object',
    properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } },
    required: ['tool_name'],
  },
};

export const BLOCKS: Tool = {
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

export const STATS: Tool = {
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

export const SESSIONS: Tool = {
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

export const SESSION: Tool = {
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
