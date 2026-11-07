// Panes: a My Stuff app pinned beside the open task or on home (v1 web/js/pane-bridge.js, the parts
// the server and the agent's guide share). DOM-free, so the page, the server and the tests check the
// same permission rules.
//
// The app runs on its own origin (the stuff plugin serves it on a port of its own) in a sandboxed
// frame. It never gets wisp's API: `wisp.tasks.list()` and the rest post a message to the parent page,
// which checks the call against what you allowed (`allowed`, a subset of what its wisp-app.json
// `uses`). An app that uses any of this is served with a CSP that keeps its requests on its own origin.

// What an app may ask for, with the words the Allow card shows.
export const PANE_USES: Readonly<Record<string, string>> = {
  'tasks:read': 'See your tasks: title, state, project, branch, PR and the one-line summary of the last answer (not the conversation)',
  'tasks:write': 'Ask to start tasks and send follow-ups (you confirm each one), and mark tasks done',
  'prs:read': 'See your tasks’ pull requests',
  'crew:read': 'See your crew: names, roles and what they’re doing',
  'usage:read': 'See your usage windows: how much of each is gone, when it resets, and what each period cost',
};

// Each call the frame can make, and what it needs.
export const PANE_CALLS: Readonly<Record<string, string>> = {
  'tasks.list': 'tasks:read',
  'tasks.get': 'tasks:read',
  'tasks.watch': 'tasks:read', // wisp.on('tasks', fn)
  'tasks.launch': 'tasks:write',
  'tasks.followUp': 'tasks:write',
  'tasks.done': 'tasks:write',
  'prs.list': 'prs:read',
  'crew.list': 'crew:read',
  'usage.accounts': 'usage:read',
};

const TASK = '{ id, title, state: "running"|"waiting"|"review"|"done", status, project, agent, harness (its name), account, machine, model, mode, branch, summary, live, unread, archived, asks, crew: { id, name } | absent, pr: { number, url, state, draft, checks, review, conflict } | null, createdAt, updatedAt }';
// How to call each of them and what comes back: the agent's reference (paneReference), so nothing it's
// told drifts from what the bridge does. A new call needs an entry (a test checks).
export const CALL_DOCS: Readonly<Record<string, { call: string; returns: string }>> = {
  'tasks.list': { call: 'wisp.tasks.list()', returns: `[Task], every task that isn't archived. Task: ${TASK}` },
  'tasks.get': { call: 'wisp.tasks.get(id)', returns: 'Task; rejects if there is no such task' },
  'tasks.watch': { call: "wisp.on('tasks', fn)", returns: 'fn([Task]) now, then each time tasks change, at most every 300 ms. Returns a function that stops it' },
  'tasks.launch': { call: 'wisp.tasks.launch({ prompt, project })', returns: "Task, or { queued: true }. project: a project's name, or leave it out for no project. Harness and mode are the user's defaults. Opens wisp's card; rejects if they cancel" },
  'tasks.followUp': { call: 'wisp.tasks.followUp(id, text)', returns: "true. Opens wisp's card; rejects if they cancel" },
  'tasks.done': { call: 'wisp.tasks.done(id)', returns: 'true. No card' },
  'prs.list': { call: 'wisp.prs.list()', returns: "[{ number, url, state, draft, checks, review, conflict, repo, task (id), title }], each task's pull requests" },
  'crew.list': { call: 'wisp.crew.list()', returns: '[{ id, name, role, busy, nextAt }]' },
  'usage.accounts': { call: 'wisp.usage.accounts()', returns: '[{ agent, agentName, account, windows: [{ id, label, used (0 to 1), resetsAt (ms) | null, periods, shrink }], burnPerHour (share of the window burnWindow names, per hour, since it started) | null, burnWindow }], one per account. windows is empty when the harness reports none. burnPerHour is null when it is too early to tell; never make one up. periods: newest first, at most 12: [{ end (ms), ms, used | null, inWisp, outside | null, work, unit: "usd"|"mtok", per1 | null, rough?, open?, full?, cut?, cli?: { version?: [from, to], tools?, catalog? } }]. used and outside are null when wisp has no reading of that period, and outside can read low (shares of a move can sum past it). per1 is the work 1% of the window took; null means too little to say. rough: the cost came from differences of cumulative totals, so show it as ≈. open: the current period; cut: it ended before its reset. shrink: weekly windows only, null until there are 2 full periods per side (for Codex also across its December 2026 plan change), and null means say nothing: { state: "less"|"same"|"more", change, recent, before, unit, from (ms), rough?, cli? }. Both are [] and null when history can’t be read' },
};

// The scopes that change something. A grant of one is tied to the app's code (effectiveGrant).
export const WRITE_USES: readonly string[] = ['tasks:write'];
export const PANE_WRITES: readonly string[] = Object.keys(PANE_CALLS).filter((m) => WRITE_USES.includes(PANE_CALLS[m] ?? ''));

export const PANE_WHERE: readonly string[] = ['task', 'home'];
export const MAX_PANES = 8;
// At most this many writes a minute from one pane, whatever became of them (a card you cancelled
// counts): a loop in an app can't start a hundred tasks or bury you in cards.
export const PANE_WRITES_PER_MIN = 6;

/** wisp-app.json's "uses": a clean list; throws for a scope wisp doesn't know. */
export function usesOf(manifest: unknown): string[] {
  const u = typeof manifest === 'object' && manifest !== null ? (manifest as Record<string, unknown>)['uses'] : undefined;
  if (u === undefined || u === null) return [];
  if (!Array.isArray(u)) throw new Error('"uses" in wisp-app.json is a list, like ["tasks:read"].');
  const bad = u.find((x) => typeof x !== 'string' || !Object.hasOwn(PANE_USES, x));
  if (bad !== undefined) throw new Error(`"uses" in wisp-app.json: ${JSON.stringify(bad)} isn't something an app can use (${Object.keys(PANE_USES).join(', ')}).`);
  return [...new Set(u as string[])];
}

/** What a grant may hold: only what the app asks for, once each. */
export const grantOf = (uses: readonly string[] = [], want: unknown = []): string[] =>
  (Array.isArray(want) ? want : []).filter((x, i, a): x is string => typeof x === 'string' && uses.includes(x) && a.indexOf(x) === i);

/** What the app asks for that you haven't allowed yet. */
export const missingOf = (it: { uses?: readonly string[]; allowed?: readonly string[] } | undefined): string[] => (it?.uses ?? []).filter((x) => !(it?.allowed ?? []).includes(x));

/**
 * What a stored grant is worth now. A write scope holds only for the code you allowed: while the app's
 * hash differs (or there's none) the write scopes are off and `changed` says so. Nothing is deleted:
 * going back to that code brings them back. Read scopes aren't tied to the hash.
 */
export function effectiveGrant(allowed: readonly string[] | undefined = [], grantHash = '', hashNow = ''): { allowed: string[]; changed: boolean } {
  const list = [...(allowed ?? [])];
  const tied = list.some((x) => WRITE_USES.includes(x));
  if (!tied || (grantHash && grantHash === hashNow)) return { allowed: list, changed: false };
  return { allowed: list.filter((x) => !WRITE_USES.includes(x)), changed: true };
}

/** A task the app may not gain a scope under: it runs in Full auto, nobody is reading cards. */
export const runsFullAuto = (s: { mode?: string; state?: string; status?: string; running?: boolean; turns?: readonly { status?: string }[] } | null | undefined): boolean =>
  !!s && s.mode === 'auto' && (s.state === 'running' || s.status === 'running' || s.running === true || s.turns?.at(-1)?.status === 'running');
export const notWhile = (s: { title?: string }): string => `Not while ${s.title || 'a task'} runs in Full auto.`;

export interface Pin {
  app: string;
  where: string;
}

/** The `stuff.panes` setting (v1 `panes`): "<app>@task,<app>@home", an app's id or name. Pins, in order. */
export function parsePanes(v: unknown): Pin[] {
  if (typeof v !== 'string' || !v.trim()) return [];
  return v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const i = x.lastIndexOf('@');
      return i > 0 ? { app: x.slice(0, i).trim(), where: x.slice(i + 1).trim() } : { app: x, where: 'task' };
    });
}
export const panesString = (pins: readonly Pin[]): string => pins.map((p) => `${p.app}@${p.where}`).join(',');

/** Which of My Stuff's apps a pin means: its id, else its name or title (any case). */
export function appFor<T extends { id: string; kind: string; name?: string; title?: string; pending?: boolean }>(pin: Pin, items: readonly T[] = []): T | null {
  const apps = items.filter((x) => x.kind === 'app' && !x.pending);
  const k = String(pin.app).toLowerCase();
  return apps.find((x) => x.id === pin.app) ?? apps.find((x) => x.name?.toLowerCase() === k || x.title?.toLowerCase() === k) ?? null;
}

// --- the frame's side: /_wisp/pane.js and /_wisp/pane.css ----------------------------------------

// What the app's page loads with <script src="/_wisp/pane.js"></script>: `wisp`, calls that post to
// the parent and resolve with its answer. Outside a pane (opened in a tab) every call refuses.
export const PANE_CLIENT = `(()=>{if(window.wisp&&window.wisp.tasks)return;const inPane=parent!==window;let n=0;const wait=new Map();const subs={};let ctx={where:inPane?'':'tab'};
const call=(method,...args)=>new Promise((ok,no)=>{if(!inPane)return no(new Error('Pin this app as a pane in wisp to use wisp.'+method+'().'));const id=++n;wait.set(id,{ok,no});parent.postMessage({wispPane:1,id,method,args},'*')});
addEventListener('message',(e)=>{if(e.source!==parent&&e.source!==parent.parent)return;const m=e.data||{};if(!m.wispPane)return;if(m.id&&wait.has(m.id)){const w=wait.get(m.id);wait.delete(m.id);m.error?w.no(new Error(m.error)):w.ok(m.result);return}
if(m.event==='context'){ctx=Object.freeze({...m.data});if(ctx.theme)document.documentElement.dataset.theme=ctx.theme}(subs[m.event]||[]).forEach((f)=>{try{f(m.data)}catch(err){console.error(err)}})});
const on=(ev,fn)=>{(subs[ev]=subs[ev]||[]).push(fn);if(ev==='tasks')call('tasks.watch').catch((err)=>console.warn(err.message));return()=>{subs[ev]=(subs[ev]||[]).filter((f)=>f!==fn)}};
window.wisp=Object.freeze({get context(){return ctx},on,
tasks:Object.freeze({list:()=>call('tasks.list'),get:(id)=>call('tasks.get',id),launch:(o)=>call('tasks.launch',o),followUp:(id,text)=>call('tasks.followUp',id,text),done:(id)=>call('tasks.done',id)}),
prs:Object.freeze({list:()=>call('prs.list')}),crew:Object.freeze({list:()=>call('crew.list')}),usage:Object.freeze({accounts:()=>call('usage.accounts')})});
if(inPane)parent.postMessage({wispPane:1,hello:1},'*');})();`;

// /_wisp/pane.css's kit, after wisp's tokens: an app looks at home with these few classes.
export const PANE_KIT = `
:where(html) { color-scheme: light dark; }
:where(*) { scrollbar-width: thin; scrollbar-color: var(--line-2) transparent; }
body { padding: 12px; font: 13px/1.45 var(--sans); }
.btn { display: inline-flex; align-items: center; gap: 6px; min-height: 28px; padding: 0 10px; font: inherit; color: var(--ink); background: var(--surface); border: 1px solid var(--line-2); border-radius: 8px; cursor: pointer; }
.btn:hover { background: var(--bg-2); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { color: var(--bg); background: var(--ink); border-color: var(--ink); }
.btn.primary:hover { opacity: 0.86; }
.btn:active { transform: scale(0.96); }
@media (hover: none) { .btn:hover { background: var(--surface); } .btn.primary:hover { background: var(--ink); opacity: 1; } }
@media (pointer: coarse) { .btn { min-height: 44px; } }
:where(.card) { padding: 10px 12px; background: var(--surface); border: 1px solid var(--line); border-radius: 10px; }
:where(.chip) { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; font-size: 11.5px; color: var(--muted); background: var(--bg-2); border-radius: 99px; }
:where(.muted) { color: var(--muted); }
:where(.faint) { color: var(--faint); }
:where(.sk) { display: block; background: var(--bg-2); animation: sk-pulse 1.4s ease-in-out infinite; }
@keyframes sk-pulse { 50% { opacity: 0.5; } }
@media (prefers-reduced-motion: reduce) { :where(.sk) { animation: none; } }
`;

// An app that uses wisp keeps its requests on its own origin: its files, its database. One that
// doesn't keeps its network, but an app on loopback can't frame wisp's http page and steal clicks.
export const PANE_APP_CSP = "frame-src 'self' https: data: blob:";
export const PANE_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'";
