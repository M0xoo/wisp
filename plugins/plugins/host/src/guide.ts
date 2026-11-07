// What a Make a plugin agent is told (plan §6.0.3 rule 4: one agent where v1 had Cast a spell and
// Make a pane): v1 server/spell-guide.js and server/pane-guide.js in one guide. The reference comes
// from the same tables the checker uses, so it never drifts from what wisp accepts. The agent's tools
// and its report block keep their v1 names (wisp_spell_*, the `spell` block): agents and released
// clients read them, so they are wire names, not UI copy.

import { SPELL_EXAMPLES } from './examples.ts';
import { ACTIONS, EVENTS, GH_READ, HOOK_ACTIONS, HOOK_IF, STYLE_PROPS, WISP_DATA } from './schema.ts';
import { CARD_HEAD_ORDER, type Vocab } from './vocabulary.ts';

const FIELDS: Readonly<Record<string, string>> = {
  version: '"1.0.0" — bump it when you change a spell the user already has',
  description: 'one sentence',
  harnesses: '["*"] or e.g. ["claude","codex"]: which harnesses its prompt rules, blocks and hooks apply to',
  when: '{ project: [names|ids|paths], agent: [...], mode: [...] } scope for prompt rules, blocks and hooks',
  data: '{ name: { wisp: "/path?query" } | { gh: [args], cwd?: "task", refresh?: seconds } } — fetched by wisp; script functions receive them as their first argument { name: value }. gh args may use {field} templates over the card\'s task (e.g. "{pr.number}").',
  buttons: '[{ id?, slot, label, icon?, title?, badge?: { count: "<data>" } | { text: "{field}" } | { fn, with: [data] }, group?: "name" (float only: folds into one button), corner?: "bottom-left", when?: {hasPr, prState, state, status, agent, project, unread, hasBranch} (card slots), do }]',
  chips: '[{ slot: "card.head" | "launcher.chips" | "composer.chips", text: "{field} template" | fn: "<script fn>" (returns a string), with?: [data], tone?: good|bad|warn|info|neutral, icon?, title?, when?, do? }]',
  panels: '[{ id, title, icon?, as: dialog|drawer|feed|card, slot?: card.top|card.bottom (as card), data: [names], render: "<script fn>", refresh?: { every: seconds, on: [summary, finished] } }] — render returns an array of wisp presentation blocks (stats, chart, markdown, checklist, files, callout, steps, tree, flow, terminal, code, actions with url…, preview, map, app)',
  blocks: '[{ type, doc: "one-line JSON example + when to use it", summary: "{field} template for text-only places", render: "<script fn>" }] — new presentation blocks agents can use; render(block) returns wisp blocks',
  parts: '{ "<part>": { style?: { cssProp: value }, props?: {...}, order?: [...] (card.head only) } }',
  ui: '{ hide: [parts], tokens: { "--accent": "#7c5cff" }, dark: { … tokens for dark mode } }',
  prompt: '["text", { text, when }] — added to agents\' system prompts while the spell is on',
  settings: '{ key: value } — wins over the user\'s setting while the spell is on (theme: "dark" keeps wisp dark)',
  slash: '[{ name, args?, hint?, do }] — /name in a follow-up box; {args} in do\'s text is what the user typed after it',
  commands: '[{ label, keywords?, icon?, key?, do }] — ⌘K items (key: a single key like "g" or "shift+g", only when no built-in uses it)',
  hooks: `[{ on, if?, max?, do }] — on: ${Object.keys(EVENTS).join(' | ')}; if: { ${HOOK_IF.join(', ')} }; do: one of ${[...HOOK_ACTIONS].join(', ')}; max: times per task (default 1)`,
  recipes: '[{ name, prompt with {params}, agent?, mode? }] — saved prompts',
  crew: '[{ key, name, role?, avatar?, brief, cron?: "5-field cron" (empty: only when asked), on?: [finished | done | ci], mode?: plan|edits|auto, agent?, model?, effort?, parallel?: 1-5, kit?: [{ kind: skill|rules, name, description (skills), body }], team?: [{ crew: "<key of another member here>" } | { agent }] }] — crew members the spell brings (at most 10). They join paused; the user reviews each and picks its project (one that starts when CI fails needs one). The spell owns who they are: change them by bumping the version. Prefer mode plan for a reviewer or watcher',
  script: 'JS with `export function name(data, ctx) { return … }` functions. It runs in a sandbox with no network, no DOM and no wisp API: it can only compute and return values (blocks, strings, numbers, lists of links). To make something interactive, return an app block: { type: "app", title, html: "<style>…</style>…<script>…</script>", height?, fallback?: [blocks] }. wisp runs its html in a sandboxed frame with no network, themed by wisp\'s CSS variables (var(--ink), --surface, --line, --accent, …); in it, wisp.send(text) offers text for the user to send to the task as a follow-up, wisp.save(obj) / wisp.state keep its state. Make it work from 320px wide. ctx: { session } (the card\'s task summary, when there is one), { block } for agent blocks (the block is also the first argument).',
};

/** The full reference, as JSON (the wisp_spell_schema tool). */
export function spellReference(v: Vocab): Record<string, unknown> {
  return {
    format: 'One JSON object. Required: wispSpell (1), id (lowercase-dashes), name. Everything else is optional.',
    fields: FIELDS,
    templates: "{field} in text, labels, links and gh args is filled from the card's task summary: id, title, state, status, agent, model, mode, project, branch, cwd, preview, pr.number, pr.url, pr.state, pr.checks …; in slash commands {args} too. Missing fields become empty.",
    slots: v.slots,
    parts: [...v.parts],
    partProps: v.partProps,
    cardHeadOrder: CARD_HEAD_ORDER,
    styleProps: STYLE_PROPS,
    tokens: v.tokens,
    icons: v.icons,
    actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, a]) => [k, a.doc])),
    settings: v.settings,
    wispData: WISP_DATA,
    ghReadOnly: Object.fromEntries(Object.entries(GH_READ).map(([k, x]) => [k, x ?? 'GET only'])),
    examples: SPELL_EXAMPLES,
  };
}

const TASK = '{ id, title, state: "running"|"waiting"|"review"|"done", status, project, agent, harness (its name), account, machine, model, mode, branch, summary, live, unread, archived, asks, crew: { id, name } | absent, pr: { number, url, state, draft, checks, review, conflict } | null, createdAt, updatedAt }';
// v1 web/js/pane-bridge.js PANE_USES and CALL_DOCS, as the pane agent read them.
const PANE_USES: readonly (readonly [string, string])[] = [
  ['tasks:read', 'See your tasks: title, state, project, branch, PR and the one-line summary of the last answer (not the conversation)'],
  ['tasks:write', 'Ask to start tasks and send follow-ups (you confirm each one), and mark tasks done'],
  ['prs:read', 'See your tasks’ pull requests'],
  ['crew:read', 'See your crew: names, roles and what they’re doing'],
  ['usage:read', 'See your usage windows: how much of each is gone, when it resets, and what each period cost'],
];
const PANE_CALLS: readonly (readonly [string, string, string])[] = [
  ['wisp.tasks.list()', 'tasks:read', `[Task], every task that isn't archived. Task: ${TASK}`],
  ['wisp.tasks.get(id)', 'tasks:read', 'Task; rejects if there is no such task'],
  ["wisp.on('tasks', fn)", 'tasks:read', 'fn([Task]) now, then each time tasks change, at most every 300 ms. Returns a function that stops it'],
  ['wisp.tasks.launch({ prompt, project })', 'tasks:write', "Task, or { queued: true }. project: a project's name, or leave it out for no project. Harness and mode are the user's defaults. Opens wisp's card; rejects if they cancel"],
  ['wisp.tasks.followUp(id, text)', 'tasks:write', "true. Opens wisp's card; rejects if they cancel"],
  ['wisp.tasks.done(id)', 'tasks:write', 'true. No card'],
  ['wisp.prs.list()', 'prs:read', "[{ number, url, state, draft, checks, review, conflict, repo, task (id), title }], each task's pull requests"],
  ['wisp.crew.list()', 'crew:read', '[{ id, name, role, busy, nextAt }]'],
  ['wisp.usage.accounts()', 'usage:read', '[{ agent, agentName, account, windows: [{ id, label, used (0 to 1), resetsAt (ms) | null, periods, shrink }], burnPerHour | null, burnWindow }], one per account. windows is empty when the harness reports none. burnPerHour is null when it is too early to tell; never make one up'],
];
const MAX_PANES = 8;
const PANE_WRITES_PER_MIN = 6;

/** The pane half of the reference: everything a pane can touch (v1 paneReference). */
export function paneReference(): string {
  const scopes = PANE_USES.map(([k, words]) => `- \`${k}\`: ${words}`).join('\n');
  const calls = PANE_CALLS.map(([call, need, returns]) => `- \`${call}\` (needs \`${need}\`) → ${returns}`).join('\n');
  return `## wisp-app.json

{ "name": "…", "description": "one line", "entry": "index.html", "uses": ["…"], "db": true }

name is what its bar shows; entry defaults to index.html; db: true gives it a SQLite database of its own ("db": "seed.sql" makes its tables from that file), which its pages use with import { sql } from '/_wisp/db.js'; once it's published, anyone with the link can read and change that data, so no personal data in it. uses lists what it needs from wisp, from this list and nothing else:

${scopes}

## Its page

<script src="/_wisp/pane.js"></script> gives it \`wisp\`. <link rel="stylesheet" href="/_wisp/pane.css"> gives it wisp's look: the tokens (var(--ink), var(--muted), var(--faint), var(--bg), var(--bg-2), var(--surface), var(--line), var(--line-2), var(--accent)), light and dark, following the user's theme, and .btn, .btn.primary, .card, .chip, .muted, .faint, .sk (a loading placeholder). Use them, and no colours of your own.

Every call returns a promise.

${calls}

- \`wisp.context\`: { where: "task" | "home", task: id | null, theme: "light" | "dark" }.
- \`wisp.on('context', fn)\`: fn(context) when it changes (another task opened, the theme).

Beside tasks, \`context.task\` is the open task: repaint when it changes.

## The rules it lives under

- A call the user hasn't allowed rejects. Nothing is allowed until they press Allow… on the pane's bar, so the first paint must make sense without access: catch the rejection and show its message.
- \`tasks.launch\` and \`tasks.followUp\` open wisp's own card with the exact text, and only the user's Send sends it. They can cancel, and only one card opens at a time. Handle the rejection every time and say so in the page: it is normal, not a crash. Never retry on your own.
- At most ${PANE_WRITES_PER_MIN} writes a minute from a pane, cancelled ones included; past that they reject. Show that error too.
- Changing any file of the app turns \`tasks:write\` off until the user allows it again; its bar says *Changed since allowed*, and read scopes stay. Say this in your answer when the pane has \`tasks:write\`, every time you update it.
- An app that uses wisp may only reach its own address. No external scripts, styles, fonts, images or fetch, so no CDN, whatever wisp_save says about CDNs: bundle everything into the folder. Frames are off.
- Links can't open anything: the frame has no popups and can't leave its own address. A link inside the app works; one to anywhere else fails. Show an address as text.
- There are at most ${MAX_PANES} panes. It is one frame in a side panel about 400px wide, or a tile on home at least 300px wide and 420px tall that the user can resize, and a full page on phones: it must work narrow, and scroll inside itself.`;
}

const PANE_EXAMPLE = `wisp-app.json:

{ "name": "Running now", "description": "How many of your tasks are running.", "uses": ["tasks:read"] }

index.html:

<!doctype html>
<meta charset="utf-8">
<title>Running now</title>
<link rel="stylesheet" href="/_wisp/pane.css">
<script src="/_wisp/pane.js"></script>
<div class="card"><b id="count">…</b> <span class="muted">running</span></div>
<p class="muted" id="note"></p>
<script>
  const paint = (tasks) => {
    document.getElementById('count').textContent = tasks.filter((t) => t.state === 'running').length;
  };
  // Refused until the user allows tasks:read from the pane's bar: say so, and wait.
  wisp.tasks.list().then((tasks) => {
    paint(tasks);
    wisp.on('tasks', paint);
  }, (err) => {
    document.getElementById('note').textContent = err.message;
  });
</script>`;

/** The system-prompt section for a Make a plugin task. `tool`: how this harness names wisp's ask tool. */
export function makeGuide(tool = 'mcp__wisp__ask_user'): string {
  const t = (name: string): string => tool.replace(/ask_user$/, name);
  return `

## This task: make a plugin for wisp

The user wants to change wisp itself, without anyone editing wisp's code. A plugin does it in one of
two ways. Pick the smaller one that does what was asked:

- **A declarative plugin**: one JSON object wisp layers over itself at runtime. It adds buttons,
  panels and blocks agents can use, restyles or hides parts of the UI, sets settings, changes how
  agents behave. It is written in the v1 format (\`wispSpell: 1\`), which wisp converts to a plugin
  when the user keeps it. You don't edit files and you don't run commands for it.
- **A pane**: a small web app that lives in wisp, in My Stuff, pinned beside the user's tasks or on
  home. It can read their tasks and more through wisp, if they allow it. Build one only when a
  declarative plugin can't do it (a board, a form, a tool with its own state).

### A declarative plugin

1. Call \`wisp_spell_schema\` (${t('wisp_spell_schema')}) for the full reference: slots, parts, actions,
   icons, tokens, data sources, examples. Use only what it lists.
2. Call \`wisp_spells\` (${t('wisp_spells')}) to see what the user has already. To change one, keep its id and
   bump its version; to remove one, end with \`{"type":"spell","remove":"<id>"}\` (remove at the top
   level of the block, no spell object).
3. If you read data (a \`wisp\` or \`gh\` source), call \`wisp_spell_data\` (${t('wisp_spell_data')}) with the
   source to see the real shape before writing script that reads it.
4. Call \`wisp_spell_check\` (${t('wisp_spell_check')}) with your plugin until it says ok. It validates and
   compiles the script (without running it) and says in plain words what the plugin does.
5. End with a report whose blocks include exactly one \`spell\` block:
   {"type":"spell","spell":{ …the whole plugin… }}
   Put a hero first (what the plugin does, in a line), then that block, then anything worth
   knowing (what you assumed, what it can't do). Keep it short: the block itself shows the user
   a preview and what changes. wisp installs it only when the user clicks **Keep** on your report.

Rules: prefer the smallest plugin that does what was asked. Never invent slots, parts, actions or
fields. Script functions are pure: no fetch, no DOM, no globals — they get data and return values.
If the ask needs something plugins can't do yet, say so in a callout and do the closest thing they can.

### A pane

You are in an empty folder of your own.

1. If what they want is really unclear, ask with ${tool}. Otherwise just build it.
2. Build it in a folder here: index.html (with its JS and CSS, one file if that's reasonable; plain HTML and JS, no build step) and wisp-app.json.
3. Ask for the least it needs. Never ask for tasks:write when reading is enough, and leave "uses" out if it needs nothing from wisp.
4. wisp_save it with app: <the folder> and pin: "home" for a whole-workspace tool (a board, a queue) or pin: "task" for something about the open task. Read what the save answers: it says whether it pinned.
5. To change it, edit your folder and wisp_save with the same id and app: <the folder>. The pane reloads on its own, in place. Never touch wisp's own copy, and don't save a second app.
6. End with a stuff block with its id. Tell the user in one or two sentences what it does and, if it uses wisp, that it does nothing until they press Allow… on its bar.

${paneReference()}

## A whole pane

The user asked: A pane with a count of my running tasks

${PANE_EXAMPLE}`;
}
