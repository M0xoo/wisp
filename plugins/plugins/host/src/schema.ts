// What a v1 spell may hold, as v1's web/js/spell-schema.js said it (the compat path: "spell" stays in
// these names on purpose). The server-side rules live here: actions, hook events, data allowlists,
// style values, block names. The UI vocabulary (slots, parts, props, tokens, icons, settings) is in
// vocabulary.ts, where the shell can add to it.

export const SPELL_VERSION = 1;

export type ActionKind = 'safe' | 'acts' | 'reads' | 'runs';

// What a button, chip, command, slash command or hook can do. kind: what the review says about it.
export const ACTIONS: Readonly<Record<string, { kind: ActionKind; doc: string }>> = {
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
  fork: { kind: 'acts', doc: '{ "fork": { "prompt": "Try it with a lookup table instead", "agent": "", "model": "", "effort": "", "mode": "" } } fork the card\'s task from its latest turn: a new task with its conversation and a copy of its work, on its own branch, that does what prompt says (agent, model, effort, mode: optional, the task\'s own by default)' },
  side: { kind: 'acts', doc: '{ "side": { "prompt": "Review what it changed so far", "agent": "", "model": "", "effort": "" } } start a side discussion about the card\'s task (as /side does): a read-only task of its own, on a page of its own, that reads the task\'s work and hears its latest state with every message, and changes nothing (agent, model, effort: optional, the task\'s own by default)' },
  recipe: { kind: 'acts', doc: '{ "recipe": "name" } run a recipe' },
  ship: { kind: 'acts', doc: '{ "ship": true } open Ship it for the card\'s task' },
  done: { kind: 'acts', doc: '{ "done": true } mark the card\'s task done' },
  archive: { kind: 'acts', doc: '{ "archive": true } archive the card\'s task' },
  compact: { kind: 'acts', doc: '{ "compact": true } compact the card\'s task now: a large Claude task whose cache is still warm (refused otherwise). Buttons only: never from a hook' },
  forLater: { kind: 'acts', doc: '{ "forLater": true } save the card\'s task for later (a finished one; it leaves Needs you for For later)' },
  notify: { kind: 'acts', doc: '{ "notify": "text" } a desktop notification / toast (hooks: your phone, if linked)' },
  webhook: { kind: 'runs', doc: '{ "webhook": "https://…" } POST the task summary as JSON to a URL (hooks)' },
  exec: { kind: 'runs', doc: '{ "exec": "npm run e2e" } run a shell command in the task\'s folder (asks you the first time)' },
};

// Hook events (server side), with what `if` can test.
export const EVENTS: Readonly<Record<string, string>> = {
  'turn.finished': 'A turn ended normally (the agent reported).',
  'turn.failed': 'A turn ended with an error.',
  'session.started': 'A new task started.',
  'session.waiting': 'A task is waiting for your answer.',
};
export const HOOK_IF: readonly string[] = ['status', 'testsFailed', 'agent', 'project', 'hasPr', 'mode'];
export const HOOK_ACTIONS: ReadonlySet<string> = new Set(['reply', 'done', 'archive', 'forLater', 'notify', 'webhook']);

// GET routes a `wisp` data source may read (patterns, :x = one segment).
export const WISP_DATA: readonly string[] = ['/sessions', '/sessions/:id', '/usage', '/usage/tools', '/projects', '/recipes', '/triggers', '/machines', '/agents', '/preferences', '/spells'];

// `gh` data sources: read-only subcommands only (null: any, but only reads).
export const GH_READ: Readonly<Record<string, readonly string[] | null>> = {
  pr: ['list', 'view', 'status', 'checks', 'diff'],
  search: ['prs', 'issues', 'repos', 'commits'],
  issue: ['list', 'view', 'status'],
  run: ['list', 'view'],
  repo: ['view', 'list'],
  release: ['list', 'view'],
  workflow: ['list', 'view'],
  api: null,
};
const GH_WRITE_FLAGS = /^(-X|--method|-f|-F|--field|--raw-field|--input)(=|$)/;

// Built-in presentation blocks (a spell's agent block type can't reuse these names).
export const BUILTIN_BLOCKS: readonly string[] = ['hero', 'markdown', 'steps', 'stats', 'files', 'diff', 'tests', 'commits', 'graph', 'tree', 'code', 'compare', 'flow', 'chart', 'terminal', 'checklist', 'callout', 'image', 'video', 'preview', 'map', 'doc', 'task', 'question', 'blocked', 'actions', 'next', 'spell', 'app', 'stuff'];

// Slash commands wisp has itself.
export const BUILTIN_SLASH: readonly string[] = ['btw', 'side', 'feedback', 'bug', 'spell'];

// CSS a spell may set on a part (camelCase or kebab-case), and what values look like.
export const STYLE_PROPS: readonly string[] = [
  'color', 'background', 'background-color', 'border', 'border-color', 'border-width', 'border-style', 'border-radius',
  'padding', 'padding-top', 'padding-bottom', 'padding-left', 'padding-right', 'margin', 'margin-top', 'margin-bottom',
  'gap', 'font-size', 'font-weight', 'font-family', 'font-style', 'line-height', 'letter-spacing', 'text-transform',
  'box-shadow', 'opacity', 'order', 'display', 'flex-direction', 'align-items', 'justify-content', 'min-height', 'max-height', 'width', 'max-width',
];
const STYLE_VALUE = /^[#a-z0-9\s.,%()+\-/'"]*$/i;
const BANNED_VALUE = /url\s*\(|image-set|@import|expression\s*\(|\\|;|[{}<>]|attr\s*\(/i;
const DISPLAYS = ['none', 'flex', 'grid', 'block', 'inline-flex', 'inline-block'];

export const kebab = (k: string): string => String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** '' when the declaration is fine, else why not. */
export function styleProblem(prop: string, value: unknown): string {
  const p = kebab(prop);
  if (!STYLE_PROPS.includes(p)) return `${p} isn't a property spells can set`;
  const v = String(value ?? '');
  if (v.length > 120) return `${p}: value too long`;
  if (BANNED_VALUE.test(v) || !STYLE_VALUE.test(v)) return `${p}: value not allowed (no url(), imports or special characters)`;
  if (p === 'display' && !DISPLAYS.includes(v.trim())) return 'display must be none, flex, grid, block, inline-flex or inline-block';
  return '';
}

/** '' when the gh args are read-only, else why not. */
export function ghProblem(args: unknown): string {
  if (!Array.isArray(args) || !args.length || args.some((a) => typeof a !== 'string')) return 'gh needs a list of string arguments';
  const [cmd, sub] = args as string[];
  if (cmd === undefined || !Object.hasOwn(GH_READ, cmd)) return `gh ${cmd} isn't allowed (read-only commands only)`;
  const subs = GH_READ[cmd];
  if (subs === null || subs === undefined) return (args as string[]).some((a) => GH_WRITE_FLAGS.test(a)) ? 'gh api may only read (no -X, -f, -F or --input)' : '';
  if (sub === undefined || !subs.includes(sub)) return `gh ${cmd} ${sub || ''} isn't allowed (read-only commands only)`.replace(/\s+\(/, ' (');
  return '';
}

/** '' when the path is a readable wisp route, else why not. */
export function wispPathProblem(p: unknown): string {
  const s = String(p || '');
  if (!s.startsWith('/')) return 'a wisp data path starts with / (e.g. /sessions)';
  const route = (s.split('?')[0] ?? '').replace(/^\/api(?=\/)/, '');
  const parts = route.split('/').filter(Boolean);
  const ok = WISP_DATA.some((pat) => {
    const segs = pat.split('/').filter(Boolean);
    return segs.length === parts.length && segs.every((x, i) => x.startsWith(':') || x === parts[i]);
  });
  return ok ? '' : `${route} isn't readable by spells (one of ${WISP_DATA.join(', ')})`;
}

/** {field} templates over a context object (dotted paths): "PR #{pr.number}". Missing → ''. */
export function fillTemplate(tpl: unknown, ctx: unknown = {}): string {
  return String(tpl ?? '').replace(/\{([a-zA-Z_][\w.]*)\}/g, (_m, key: string) => {
    let v: unknown = ctx;
    for (const k of key.split('.')) v = v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined;
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  });
}

const asList = (v: unknown): unknown[] => (Array.isArray(v) ? v : [v]);

/** Does a card-scoped `when` match a session summary? */
export function whenMatches(when: Readonly<Record<string, unknown>> | undefined, s: Readonly<Record<string, unknown>> | null | undefined): boolean {
  if (!when) return true;
  if (!s) return false;
  const pr = s['pr'] as Record<string, unknown> | null | undefined;
  const prs = s['prs'] as unknown[] | undefined;
  const has = (k: string): boolean => when[k] !== undefined;
  if (has('hasPr') && !!(pr || prs?.length) !== !!when['hasPr']) return false;
  if (has('prState') && !asList(when['prState']).includes(pr?.['state'])) return false;
  for (const k of ['state', 'status', 'agent']) if (has(k) && !asList(when[k]).includes(s[k])) return false;
  if (has('project') && !asList(when['project']).some((p) => p === s['project'] || p === s['projectId'])) return false;
  if (has('unread') && !!s['unread'] !== !!when['unread']) return false;
  if (has('hasBranch') && !!s['branch'] !== !!when['hasBranch']) return false;
  return true;
}

/** The function names a spell's script exports (`export function name`, `export const name =`). */
export function scriptExports(src = ''): string[] {
  const out = new Set<string>();
  for (const m of String(src).matchAll(/export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) if (m[1]) out.add(m[1]);
  for (const m of String(src).matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) if (m[1]) out.add(m[1]);
  return [...out];
}

/** The script as a classic script returning its functions (what the sandbox runs). */
export function scriptBody(src = ''): string {
  const names = scriptExports(src);
  const body = String(src).replace(/export\s+(?=(?:async\s+)?function|const|let|var)/g, '');
  return `${body}\n;return { ${names.join(', ')} };`;
}

// Panes: My Stuff apps pinned beside tasks or on home (v1 web/js/pane-bridge.js).
export const MAX_PANES = 8;
const PANE_WHERE = ['task', 'home'];
const WIDTHS_MAX = 8;

/** Why a `panes` value can't be kept, or ''. */
export function panesProblem(v: unknown): string {
  if (typeof v !== 'string') return 'panes is a string like "kanban@home,pr-notes@task".';
  if (v.length > 1000) return 'panes is too long.';
  const pins = v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.lastIndexOf('@');
      return i > 0 ? { app: x.slice(0, i).trim(), where: x.slice(i + 1).trim() } : { app: x, where: 'task' };
    });
  if (pins.length > MAX_PANES) return `At most ${MAX_PANES} panes.`;
  const bad = pins.find((p) => !PANE_WHERE.includes(p.where) || !p.app || /[,@<>"]/.test(p.app));
  return bad ? `panes: "${bad.app}@${bad.where}" should be <app id or name>@task or @home.` : '';
}

/** Why a split.panes `widths` prop can't be kept, or ''. */
export function paneWidthsProblem(v: unknown): string {
  const words = 'widths is relative shares like "2,1,1"';
  if (typeof v !== 'string') return `${words}.`;
  const parts = v.split(',').map((x) => x.trim());
  if (parts.length > WIDTHS_MAX) return `${words}: at most ${WIDTHS_MAX} numbers.`;
  if (parts.some((x) => !/^\d+(\.\d+)?$/.test(x) || Number(x) <= 0 || Number(x) > 100)) return `${words}: 1 to ${WIDTHS_MAX} numbers, each above 0 and at most 100.`;
  return '';
}

// ---------- small text helpers (v1 server/util.js) ----------

/** One line, at most n characters. */
export function clip(s: unknown, n = 80): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Kept as written (line breaks too), only capped. */
export function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
