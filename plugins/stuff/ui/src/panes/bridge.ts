// The pane bridge's wire protocol (v1 web/js/pane-bridge.js): a My Stuff app pinned as a pane runs
// on its own origin in a sandboxed frame and never gets wisp's API. Its `/_wisp/pane.js` posts
// `{ wispPane: 1, id, method, args }` to its parent; wisp's page checks the call against what you
// allowed and answers `{ wispPane: 1, id, result }` or `{ wispPane: 1, id, error }`. wisp also pushes
// `{ wispPane: 1, event, data }` (`context`, `tasks`), and the frame says `{ wispPane: 1, hello: 1 }`
// after each load. These shapes are frozen: apps people already made speak them (goldens in
// test/goldens/pane-bridge.json). Pure: no DOM, no client, so the rules are checked on their own.

/** What an app may ask for (its wisp-app.json `uses`), each with the i18n key of the Allow card's words. */
export const PANE_USES = {
  'tasks:read': 'stuff.pane.use.tasksRead',
  'tasks:write': 'stuff.pane.use.tasksWrite',
  'prs:read': 'stuff.pane.use.prsRead',
  'crew:read': 'stuff.pane.use.crewRead',
  'usage:read': 'stuff.pane.use.usageRead',
} as const satisfies Record<string, string>;
export type PaneUse = keyof typeof PANE_USES;

/** Each call the frame can make, and the scope it needs. */
export const PANE_CALLS = {
  'tasks.list': 'tasks:read',
  'tasks.get': 'tasks:read',
  'tasks.watch': 'tasks:read', // wisp.on('tasks', fn)
  'tasks.launch': 'tasks:write',
  'tasks.followUp': 'tasks:write',
  'tasks.done': 'tasks:write',
  'prs.list': 'prs:read',
  'crew.list': 'crew:read',
  'usage.accounts': 'usage:read',
} as const satisfies Record<string, PaneUse>;
export type PaneMethod = keyof typeof PANE_CALLS;

/** The scopes that change something: a grant of one is tied to the app's code. */
export const WRITE_USES: readonly PaneUse[] = ['tasks:write'];
export const PANE_WRITES: readonly PaneMethod[] = (Object.keys(PANE_CALLS) as PaneMethod[]).filter((m) => WRITE_USES.includes(PANE_CALLS[m]));
export const PANE_WHERE = ['task', 'home'] as const;
export const MAX_PANES = 8;
/** At most this many writes a minute from one pane, whatever became of them (a cancelled card counts). */
export const PANE_WRITES_PER_MIN = 6;
export const MAX_TEXT = 20_000;

export const isUse = (s: unknown): s is PaneUse => typeof s === 'string' && Object.hasOwn(PANE_USES, s);
export const isMethod = (s: unknown): s is PaneMethod => typeof s === 'string' && Object.hasOwn(PANE_CALLS, s);
export const isWrite = (m: string): boolean => (PANE_WRITES as readonly string[]).includes(m);

// --- messages -------------------------------------------------------------------------------------

/** From the frame: a call (`id` counts up from 1 per page load), or its hello after a load. */
export type FrameMessage = { kind: 'hello' } | { kind: 'call'; id: number; method: string; args: unknown[] };

/** To the frame. */
export type PageMessage =
  | { wispPane: 1; id: number; result: unknown }
  | { wispPane: 1; id: number; error: string }
  | { wispPane: 1; event: 'context'; data: PaneContext }
  | { wispPane: 1; event: 'tasks'; data: unknown };

/** What a pane is told about where it is (`wisp.context`); the theme lands on its root's data-theme. */
export interface PaneContext {
  where: 'task' | 'home';
  task: string | null;
  theme: 'light' | 'dark';
}

/**
 * A message from the frame, or undefined for anything that isn't one (other scripts post too).
 * v1 answered only messages with `wispPane` set and an `id`; a hello needs no id.
 */
export function readFrameMessage(data: unknown): FrameMessage | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const m = data as Record<string, unknown>;
  if (!m['wispPane']) return undefined;
  if (m['hello']) return { kind: 'hello' };
  const id = m['id'];
  if (typeof id !== 'number' || !Number.isFinite(id) || id <= 0) return undefined;
  return { kind: 'call', id, method: String(m['method'] ?? ''), args: Array.isArray(m['args']) ? (m['args'] as unknown[]) : [] };
}

export const answer = (id: number, result: unknown): PageMessage => ({ wispPane: 1, id, result });
export const failure = (id: number, error: string): PageMessage => ({ wispPane: 1, id, error });
export const contextEvent = (data: PaneContext): PageMessage => ({ wispPane: 1, event: 'context', data });
export const tasksEvent = (data: unknown): PageMessage => ({ wispPane: 1, event: 'tasks', data });

// --- what may go ----------------------------------------------------------------------------------

/** Why a call is refused, or '' when it may go. `allowed`: what you allowed for this app. */
export function refusal(method: string, allowed: readonly string[] = []): string {
  if (!isMethod(method)) return `wisp has no ${String(method).slice(0, 60)}(). Panes can call: ${Object.keys(PANE_CALLS).join(', ')}.`;
  const need = PANE_CALLS[method];
  if (!allowed.includes(need)) return `Not allowed: ${method}() needs "${need}". Add it to "uses" in wisp-app.json, then allow it when you pin the app.`;
  return '';
}

export interface LaunchArgs {
  prompt: string;
  project: string | undefined;
}
export type CheckedArgs = { args: [] } | { args: [string] } | { args: [string, string] } | { args: [LaunchArgs] } | { error: string };

const str = (x: unknown, n = MAX_TEXT): string => (typeof x === 'string' && x.trim() ? x.slice(0, n) : '');

/** A call's arguments, checked and capped before anything runs. A pane can't pick the mode or harness. */
export function argsOf(method: string, a: readonly unknown[] = []): CheckedArgs {
  if (method === 'tasks.get' || method === 'tasks.done') return str(a[0], 40) ? { args: [a[0] as string] } : { error: `${method}(id) needs a task id.` };
  if (method === 'tasks.followUp') return str(a[0], 40) && str(a[1]) ? { args: [a[0] as string, str(a[1])] } : { error: 'tasks.followUp(id, text) needs a task id and some text.' };
  if (method === 'tasks.launch') {
    const first = a[0];
    const v = first && typeof first === 'object' ? (first as Record<string, unknown>) : { prompt: first };
    if (!str(v['prompt'])) return { error: 'tasks.launch({ prompt, project }) needs a prompt.' };
    return { args: [{ prompt: str(v['prompt']), project: str(v['project'], 200) || undefined }] };
  }
  return { args: [] };
}

/** wisp-app.json's `uses`: a clean list, or an error naming the scope wisp doesn't know. */
export function usesOf(manifest: { uses?: unknown } | null | undefined): PaneUse[] {
  const u = manifest?.uses;
  if (u === undefined || u === null) return [];
  if (!Array.isArray(u)) throw new Error('"uses" in wisp-app.json is a list, like ["tasks:read"].');
  const bad = u.find((x) => !isUse(x));
  if (bad !== undefined) throw new Error(`"uses" in wisp-app.json: ${JSON.stringify(bad)} isn't something an app can use (${Object.keys(PANE_USES).join(', ')}).`);
  return [...new Set(u as PaneUse[])];
}

/**
 * The wrapper around an app's frame: no sandbox and no scripts, only a CSP. A frame's navigations
 * answer to the CSP of the document holding it, so this is what stops `location = 'https://…?' + data`.
 * Exact http(s) origins, never a wildcard: anything else is dropped.
 */
export function paneFrameCsp(origins: readonly unknown[] = []): string {
  const ok = origins.filter((o, i, a): o is string => typeof o === 'string' && /^https?:\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/.test(o) && a.indexOf(o) === i);
  return `default-src 'none'; style-src 'unsafe-inline'; frame-src ${ok.join(' ') || "'none'"}`;
}

/** What the confirm card shows: anything that doesn't print, or reorders text around it, as `<U+…>`. */
// eslint-disable-next-line no-control-regex -- the point is to catch control characters
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;
export const showInvisible = (text: unknown): string =>
  String(text ?? '').replace(INVISIBLE, (c) => `<U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`);
export const hasInvisible = (c: string): boolean => showInvisible(c) !== c;
