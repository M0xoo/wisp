// Spells: what a spell may add to wisp, change in it or hide, in one DOM-free table that the
// server (validation, the Cast a spell agent's schema tool) and the page (applying spells) share.
//
// A spell never sees wisp's DOM. It names slots (places to add things) and parts (things to
// restyle or hide) from this list, and wisp maps them to its markup. Renaming a class in wisp
// means updating the selector here, not breaking every spell.

export const SPELL_VERSION = 1;

// Where buttons, chips and panels can be added.
export const SLOTS = {
  topbar: 'The top bar, next to Automations and Search: a labelled button with an optional count.',
  float: 'Floating buttons, stacked in a bottom corner of the window. Buttons with the same group fold into one that fans out.',
  palette: 'An item in the ⌘K palette.',
  'feed.top': 'Above the feed: a panel pinned there (panels only).',
  'launcher.bar': 'In the prompt box bar, before Send.',
  'launcher.chips': 'Chips under the prompt box (chips and buttons).',
  'composer.bar': "In a card's follow-up box bar, before Send.",
  'composer.chips': 'Chips above a card\'s follow-up box (quick replies).',
  'card.head': "A chip in a card's head, before the time.",
  'card.hover': 'A small icon button on a card head, shown on hover.',
  'card.menu': "An item in a card's right-click menu.",
  'card.top': 'A panel at the top of an open card (panels only).',
  'card.bottom': 'A panel at the bottom of an open card, above the follow-up box (panels only).',
  'sidebar.top': 'Split view: a button at the top of the task list, next to New task.',
  'split.head': "Split view: a button in the open task's header, next to its title (acts on that task).",
  'split.details': "Split view: a button in the open task's details column, under its actions (acts on that task).",
  'term.head': "A button in the header of a task's terminal (take over in wisp), before End (acts on that task).",
};

export const CARD_SLOTS = new Set(['composer.bar', 'composer.chips', 'card.head', 'card.hover', 'card.menu', 'card.top', 'card.bottom', 'split.head', 'split.details', 'term.head']);

// The layouts (the `view` setting): feed = one column, cards open in place; split = cards in a
// sidebar, the open one in the main pane. Split needs a window at least SPLIT_MIN_WIDTH wide.
export const VIEWS = ['feed', 'split'];
// Light or dark: system follows the OS (the page's `prefers-color-scheme`).
export const THEMES = ['system', 'light', 'dark'];
export const SPLIT_MIN_WIDTH = 900;
// With no layout picked, windows this wide open in split view and narrower ones in the feed.
export const SPLIT_DEFAULT_WIDTH = 1280;

// Parts: things a spell can restyle, give props or hide. Selectors are wisp's own markup.
// Never here: questions, approvals, waiting pills, the spell review and Settings → Spells.
export const PARTS = {
  topbar: '#topbar',
  'topbar.brand': '#topbar .brand',
  'topbar.projects': '#projects',
  'topbar.machines': '#machinesBtn',
  // In a browser tab only: the invite to the desktop app, and its card.
  'topbar.getapp': '#getAppBtn',
  'getapp.card': '.getapp',
  'topbar.automations': '#autoBtn',
  'topbar.search': '#searchBtn',
  'topbar.settings': '#settingsBtn',
  'topbar.view': '#viewBtn',
  feed: '#feed',
  'section.done': '#secDone',
  'section.archived': '#secArchived',
  toTop: '#toTop',
  launcher: '#launcher',
  'launcher.input': '#prompt',
  'launcher.projects': '#launcher .l-projects',
  'launcher.attach': '#attach',
  'launcher.where': '#whereBtn',
  'launcher.mode': '#mode',
  'launcher.harness': '#runner',
  'launcher.compare': '#compareBtn',
  'launcher.team': '#teamBtn',
  'launcher.worktree': '#wtBtn',
  'launcher.send': '#launch',
  'launcher.recipes': '#launcher .l-recipes',
  composer: '.composer',
  'composer.input': '.composer .reply',
  'composer.attach': '.composer .c-attach',
  'composer.mode': '.composer .c-mode',
  'composer.harness': '.composer .c-runner',
  'composer.place': '.composer .c-place',
  'composer.hint': '.composer .c-hint',
  'composer.ship': '.composer .c-ship',
  'composer.done': '.composer .c-done',
  'composer.queue': '.composer .c-queue',
  'composer.send': '.composer .send',
  'composer.btwTip': '.w-tip',
  card: '#feed .item',
  'card.head': '#feed .it-head',
  'card.dot': '#feed .it-head .q-dot',
  'card.title': '#feed .it-title',
  'card.sub': '#feed .it-sub',
  'card.live': '#feed .q-live',
  'card.side': '#feed .it-side',
  'card.pr': '#feed .it-side .pill.pr',
  'card.model': '#feed .it-side .model-logo',
  'card.machine': '#feed .it-side .q-machine',
  'card.project': '#feed .it-side .q-proj',
  'card.time': '#feed .it-side .q-time',
  'card.quickDone': '#feed .it-quick',
  'card.body': '#feed .it-body',
  // Split view only (body.split): the task list on one side, the open task on the other.
  sidebar: 'body.split .feed-wrap',
  // The top bar is the sidebar's head there; Get the app, Machines and Automations sit in its foot.
  'sidebar.foot': '#splitFoot',
  'sidebar.new': '#splitNew',
  'sidebar.grip': '#splitGrip',
  'split.main': '#splitMain',
  'split.home': '#splitHome',
  'split.greeting': '#splitHome .sh-hello',
  'split.next': '#splitHome .sh-next',
  'split.head': '#splitHead',
  'split.title': '#splitHead .sh-title',
  'split.body': 'body.split #feed .item.open > .it-body',
  // The open task's details column, fixed on the right while its body scrolls: what the card head
  // says (state, PR, harness, project, time), how it runs (branch, mode, …), its PR and its actions.
  'split.details': 'body.split #feed .item.open > .it-body > .it-bar',
  'split.pr': 'body.split #feed .item.open .it-bar > .pr-strip',
  'split.actions': 'body.split #feed .item.open .it-bar > .it-actions',
  // Take over in wisp: the task's terminal (a sheet, over the open task in split view, full
  // screen on a phone), its header, the screen and the phone's row of keys (Esc, Tab, Ctrl, arrows).
  term: '#term .tm-box',
  'term.head': '#term .tm-head',
  'term.screen': '#term .tm-screen',
  'term.keys': '#term .tm-keys',
  // Settings: the dialog, its list of sections, and the head with the pane's name and close button.
  'settings': '.modal.sx',
  'settings.nav': '.sx-nav',
  'settings.head': '.sx-top',
  // Settings → Machines: whether other devices can reach this computer over SSH.
  'settings.reachable': '.sx-reach',
  // Machines: the three-step explainer, and the password box when a machine won't let this one in.
  'machines.howto': '.mc-howto',
  'machines.letin': '.mc-letin',
  'machines.cloud': '.mc-cloud',
  // Settings → Cloud: your cloud computers, and signing in to a wisp Grid.
  'settings.cloud': '.sx-cloud',
  'settings.cloud.computer': '.cl-card',
  'settings.cloud.signin': '.cl-signin',
  // Settings → Connect, on a cloud computer: how to open it through its grid.
  'settings.connect': '.sx-connect',
  // Settings → Agents: signing in to a harness (its link, code and paste box).
  'settings.agent.signin': '.sx-login',
  // The image viewer: a picture from a reply or an attachment, full screen to zoom into, and its zoom buttons.
  viewer: '.lb',
  'viewer.bar': '.lb-bar',
};

// The pieces of a card head, for `parts["card.head"].order`.
export const CARD_HEAD_ORDER = { pill: '.pill:not(.pr)', pr: '.pill.pr', model: '.model-logo', machine: '.q-machine', project: '.q-proj', time: '.q-time', spells: '.sp-chip' };

// Props a part publishes (anything else is refused).
export const PART_PROPS = {
  'launcher.input': { placeholder: 'string', rows: 'int', maxRows: 'int', monospace: 'bool', fontSize: 'int' },
  'composer.input': { placeholder: 'string', rows: 'int', maxRows: 'int', monospace: 'bool', fontSize: 'int' },
  card: { density: ['compact', 'comfortable'] },
  'card.sub': { lines: 'int' },
  sidebar: { width: 'px', side: ['left', 'right'], details: ['minimal', 'full'] }, // side: left unless set
  'split.main': { readWidth: 'px' },
  'split.details': { width: 'px' },
  'split.home': { greeting: 'string' },
  term: { fontSize: 'int' },
};

// What a prop type accepts: int is 1–40, px is a size in pixels.
export const PROP_RANGE = { int: [1, 40], px: [160, 1600] };

// CSS a spell may set on a part (camelCase or kebab-case), and what values look like.
export const STYLE_PROPS = [
  'color', 'background', 'background-color', 'border', 'border-color', 'border-width', 'border-style', 'border-radius',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'margin', 'margin-top', 'margin-bottom',
  'gap', 'font-size', 'font-weight', 'font-family', 'font-style', 'line-height', 'letter-spacing', 'text-transform',
  'box-shadow', 'opacity', 'order', 'display', 'flex-direction', 'align-items', 'justify-content', 'min-height', 'max-height', 'width', 'max-width',
];
const STYLE_VALUE = /^[#a-z0-9\s.,%()+\-/'"]*$/i;
const BANNED_VALUE = /url\s*\(|image-set|@import|expression\s*\(|\\|;|[{}<>]|attr\s*\(/i;

export const kebab = (k) => String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

// '' when the declaration is fine, else why not.
export function styleProblem(prop, value) {
  const p = kebab(prop);
  if (!STYLE_PROPS.includes(p)) return `${p} isn't a property spells can set`;
  const v = String(value ?? '');
  if (v.length > 120) return `${p}: value too long`;
  if (BANNED_VALUE.test(v) || !STYLE_VALUE.test(v)) return `${p}: value not allowed (no url(), imports or special characters)`;
  if (p === 'display' && !['none', 'flex', 'grid', 'block', 'inline-flex', 'inline-block'].includes(v.trim())) return 'display must be none, flex, grid, block, inline-flex or inline-block';
  return '';
}

// Design tokens from web/css/tokens.css a spell may set.
export const TOKENS = ['--accent', '--accent-ink', '--accent-soft', '--bg', '--bg-2', '--surface', '--surface-2', '--ink', '--ink-2', '--muted', '--faint', '--line', '--line-2', '--good', '--bad', '--warn', '--info', '--radius', '--sans', '--mono', '--display', '--shadow-1', '--shadow-2'];

// Icons from the page's sprite (#i-<name>).
export const ICONS = ['check', 'x', 'skip', 'minus', 'plus', 'chevron', 'arrow', 'external', 'file', 'folder', 'dots', 'copy', 'branch', 'github', 'info', 'warn', 'ask', 'lock', 'pen', 'spark', 'wizard', 'stop', 'merge', 'send', 'enter', 'queue', 'clip', 'terminal', 'done', 'archive', 'trash', 'settings', 'read', 'search', 'web', 'agent', 'plan', 'tool', 'stats', 'rerun', 'replay', 'transcript', 'text', 'back', 'update', 'menu', 'bolt', 'clock', 'laptop', 'server', 'cloud', 'thumb-up', 'thumb-down', 'play', 'split', 'feed', 'bell', 'sun', 'moon'];

// What a button, chip, command, slash command or hook can do. kind: what the review says about it.
//   safe: changes nothing outside the page · acts: does something for you, only when you click
//   runs: runs a command on your computer
export const ACTIONS = {
  open: { kind: 'safe', doc: '{ "open": "https://…/{pr.number}" } open one http(s) link (a {field} template)' },
  openAll: { kind: 'safe', doc: '{ "openAll": { "data": "prs", "field": "url" } } open every link in a data source (at most 20). Or { "fn": "name" }: a script function returning links, each of which must appear in the spell\'s data' },
  panel: { kind: 'safe', doc: '{ "panel": "id" } open one of this spell\'s panels' },
  insert: { kind: 'safe', doc: '{ "insert": "text" } put text into the box at the caret (prompt box or follow-up box)' },
  copy: { kind: 'safe', doc: '{ "copy": "{branch}" } copy text' },
  toast: { kind: 'safe', doc: '{ "toast": "text" } show a short message' },
  setLaunch: { kind: 'safe', doc: '{ "setLaunch": { "agent": "codex", "model": "", "effort": "high", "mode": "plan" } } set the prompt box pickers' },
  send: { kind: 'acts', doc: '{ "send": "text" } send a follow-up to the card\'s task right away' },
  reply: { kind: 'acts', doc: '{ "reply": "text" } same as send, used by hooks' },
  launchWith: { kind: 'acts', doc: '{ "launchWith": { "agent": "codex", "mode": "plan", "effort": "high", "text": "optional prefix" } } launch what is in the prompt box with these settings' },
  launch: { kind: 'acts', doc: '{ "launch": { "prompt": "…", "agent": "", "mode": "plan", "cwd": "" } } start a new task (cwd empty = the current project)' },
  rerun: { kind: 'acts', doc: '{ "rerun": { "agent": "codex", "model": "", "effort": "", "mode": "plan", "prompt": "optional, defaults to the task\'s first request" } } run the card\'s task again as a new task on another harness' },
  recipe: { kind: 'acts', doc: '{ "recipe": "name" } run a recipe' },
  ship: { kind: 'acts', doc: '{ "ship": true } open Ship it for the card\'s task' },
  done: { kind: 'acts', doc: '{ "done": true } mark the card\'s task done' },
  archive: { kind: 'acts', doc: '{ "archive": true } archive the card\'s task' },
  notify: { kind: 'acts', doc: '{ "notify": "text" } a desktop notification / toast (hooks: your phone, if linked)' },
  webhook: { kind: 'runs', doc: '{ "webhook": "https://…" } POST the task summary as JSON to a URL (hooks)' },
  exec: { kind: 'runs', doc: '{ "exec": "npm run e2e" } run a shell command in the task\'s folder (asks you the first time)' },
};

// Hook events (server side), with what `if` can test.
export const EVENTS = {
  'turn.finished': 'A turn ended normally (the agent reported).',
  'turn.failed': 'A turn ended with an error.',
  'session.started': 'A new task started.',
  'session.waiting': 'A task is waiting for your answer.',
};
export const HOOK_IF = ['status', 'testsFailed', 'agent', 'project', 'hasPr', 'mode'];
export const HOOK_ACTIONS = new Set(['reply', 'done', 'archive', 'notify', 'webhook']);

// Settings a spell may set (while on). Telemetry, feedback and anything secret are not here.
export const SETTINGS = {
  view: VIEWS,
  theme: THEMES,
  editor: ['vscode', 'cursor', 'windsurf', 'zed', 'idea', 'none'],
  // Take over in: wisp (a terminal in the page), auto, or a terminal app (not a custom command).
  terminal: ['auto', 'wisp', 'terminal', 'iterm', 'warp', 'cmux', 'wt', 'powershell', 'cmd', 'ghostty', 'kitty', 'wezterm', 'gnome-terminal', 'konsole', 'xfce4-terminal', 'alacritty', 'xterm'],
  transcript: ['on', 'off'],
  worktree: ['on', 'off'],
  followUp: ['queue', 'interrupt'],
  mode: ['plan', 'edits', 'auto'],
  agent: 'string',
  model: 'string',
  effort: 'string',
  learn: ['on', 'off'],
  fixConflicts: ['on', 'off'],
  notify: ['on', 'off'],
};

// GET routes a `wisp` data source may read (patterns, :x = one segment).
export const WISP_DATA = ['/sessions', '/sessions/:id', '/usage', '/usage/tools', '/projects', '/recipes', '/triggers', '/machines', '/agents', '/preferences', '/spells'];

// `gh` data sources: read-only subcommands only.
export const GH_READ = { pr: ['list', 'view', 'status', 'checks', 'diff'], search: ['prs', 'issues', 'repos', 'commits'], issue: ['list', 'view', 'status'], run: ['list', 'view'], repo: ['view', 'list'], release: ['list', 'view'], workflow: ['list', 'view'], api: null };
const GH_WRITE_FLAGS = /^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)/;

// '' when the gh args are read-only, else why not.
export function ghProblem(args) {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string')) return 'gh needs a list of string arguments';
  const [cmd, sub] = args;
  if (!(cmd in GH_READ)) return `gh ${cmd} isn't allowed (read-only commands only)`;
  if (cmd === 'api') {
    if (args.some((a) => GH_WRITE_FLAGS.test(a))) return 'gh api may only read (no -X, -f, -F or --input)';
    return '';
  }
  if (!GH_READ[cmd].includes(sub)) return `gh ${cmd} ${sub || ''} isn't allowed (read-only commands only)`.replace(/\s+\(/, ' (');
  return '';
}

// '' when the path is a readable wisp route, else why not.
export function wispPathProblem(p) {
  const s = String(p || '');
  if (!s.startsWith('/')) return 'a wisp data path starts with / (e.g. /sessions)';
  const route = s.split('?')[0].replace(/^\/api(?=\/)/, '');
  const parts = route.split('/').filter(Boolean);
  const ok = WISP_DATA.some((pat) => {
    const segs = pat.split('/').filter(Boolean);
    return segs.length === parts.length && segs.every((x, i) => x.startsWith(':') || x === parts[i]);
  });
  return ok ? '' : `${route} isn't readable by spells (one of ${WISP_DATA.join(', ')})`;
}

// Built-in presentation blocks (a spell's agent block type can't reuse these names).
export const BUILTIN_BLOCKS = ['hero', 'markdown', 'steps', 'stats', 'files', 'diff', 'tests', 'commits', 'graph', 'tree', 'code', 'compare', 'flow', 'chart', 'terminal', 'checklist', 'callout', 'image', 'question', 'blocked', 'actions', 'next', 'spell'];

// {field} templates over a context object (dotted paths): "PR #{pr.number}". Missing → ''.
export function fillTemplate(tpl, ctx = {}) {
  return String(tpl ?? '').replace(/\{([a-zA-Z_][\w.]*)\}/g, (_, key) => {
    const v = key.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), ctx);
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

// Does a card-scoped `when` match a session summary?
//   { hasPr, state: [...], status: [...], agent: [...], project: [...], unread, running }
export function whenMatches(when, s) {
  if (!when) return true;
  if (!s) return false;
  const list = (v) => (Array.isArray(v) ? v : [v]);
  if (when.hasPr !== undefined && !!s.pr !== !!when.hasPr) return false;
  if (when.prState !== undefined && !list(when.prState).includes(s.pr?.state)) return false;
  if (when.state !== undefined && !list(when.state).includes(s.state)) return false;
  if (when.status !== undefined && !list(when.status).includes(s.status)) return false;
  if (when.agent !== undefined && !list(when.agent).includes(s.agent)) return false;
  if (when.project !== undefined && !list(when.project).some((p) => p === s.project || p === s.projectId)) return false;
  if (when.unread !== undefined && !!s.unread !== !!when.unread) return false;
  if (when.hasBranch !== undefined && !!s.branch !== !!when.hasBranch) return false;
  return true;
}

// The function names a spell's script exports (`export function name`, `export const name =`).
export function scriptExports(src = '') {
  const out = new Set();
  for (const m of String(src).matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of String(src).matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) out.add(m[1]);
  return [...out];
}

// The script as a classic script defining its functions on `__spell` (what the sandbox runs).
export function scriptBody(src = '') {
  const names = scriptExports(src);
  const body = String(src).replace(/export\s+(?=(?:async\s+)?function|const|let|var)/g, '');
  return `${body}\n;return { ${names.join(', ')} };`;
}
