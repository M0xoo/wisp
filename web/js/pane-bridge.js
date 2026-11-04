// Panes: a My Stuff app pinned beside the open task (a tab in the side panel) or on split view's
// home. DOM-free, shared by the server (wisp-app.json, the `panes` setting, /_wisp/pane.js) and the
// page (features/panes.js), so the tests can check the permission rules on their own.
//
// The app runs on its own origin (services/apps.js) in a sandboxed frame. It never gets wisp's API:
// `wisp.tasks.list()` and the rest post a message to the parent page, which checks the call against
// what you allowed when you pinned it (`allowed`, a subset of what its wisp-app.json `uses`) and
// only then calls the real API. An app that uses any of this is served with a CSP that keeps its
// requests on its own origin (its files and its database), and its frame sits in a wrapper whose
// CSP stops it navigating anywhere else (paneFrameCsp). That doesn't make what it reads private:
// Chrome applies no CSP to WebRTC, so treat what a pane reads as visible to whoever wrote it.
// A write is never the frame's to make: wisp's own card asks you first (features/pane-card.js).

import { redactSecrets } from './secret-scan.js';

// What an app may ask for, with the words the Allow card shows.
export const PANE_USES = {
  'tasks:read': 'See your tasks: title, state, project, branch, PR and the one-line summary of the last answer (not the conversation)',
  'tasks:write': 'Ask to start tasks and send follow-ups (you confirm each one), and mark tasks done',
  'prs:read': 'See your tasks’ pull requests',
  'crew:read': 'See your crew: names, roles and what they’re doing',
};

// Each call the frame can make, and what it needs.
export const PANE_CALLS = {
  'tasks.list': 'tasks:read',
  'tasks.get': 'tasks:read',
  'tasks.watch': 'tasks:read', // wisp.on('tasks', fn)
  'tasks.launch': 'tasks:write',
  'tasks.followUp': 'tasks:write',
  'tasks.done': 'tasks:write',
  'prs.list': 'prs:read',
  'crew.list': 'crew:read',
};

// The scopes that change something. A grant of one is tied to the app's code (effectiveGrant).
export const WRITE_USES = ['tasks:write'];
export const PANE_WRITES = Object.keys(PANE_CALLS).filter((m) => WRITE_USES.includes(PANE_CALLS[m]));

export const PANE_WHERE = ['task', 'home'];
export const MAX_PANES = 8;
// At most this many writes a minute from one pane, whatever became of them (a card you cancelled
// counts): a loop in an app can't start a hundred tasks or bury you in cards.
export const PANE_WRITES_PER_MIN = 6;
const MAX_TEXT = 20_000;

// wisp-app.json's "uses": a clean list, or an error for a scope wisp doesn't know.
export function usesOf(manifest) {
  const u = manifest?.uses;
  if (u === undefined || u === null) return [];
  if (!Array.isArray(u)) throw new Error('"uses" in wisp-app.json is a list, like ["tasks:read"].');
  const bad = u.find((x) => !Object.hasOwn(PANE_USES, x));
  if (bad !== undefined) throw new Error(`"uses" in wisp-app.json: ${JSON.stringify(bad)} isn't something an app can use (${Object.keys(PANE_USES).join(', ')}).`);
  return [...new Set(u)];
}

// What a grant may hold: only what the app asks for.
export const grantOf = (uses = [], want = []) => (Array.isArray(want) ? want : []).filter((x, i, a) => uses.includes(x) && a.indexOf(x) === i);

// What the app asks for that you haven't allowed yet.
export const missingOf = (it) => (it?.uses || []).filter((x) => !(it.allowed || []).includes(x));

// What a stored grant is worth now. A write scope holds only for the code you allowed: while the
// app's hash differs (or there's none) the write scopes are off and changed says so. Nothing is
// deleted: going back to that code brings them back. Read scopes aren't tied to the hash.
export function effectiveGrant(allowed = [], grantHash = '', hashNow = '') {
  const list = allowed || [];
  const tied = list.some((x) => WRITE_USES.includes(x));
  if (!tied || (grantHash && grantHash === hashNow)) return { allowed: list, changed: false };
  return { allowed: list.filter((x) => !WRITE_USES.includes(x)), changed: true };
}

// A task the app may not gain a scope under: it's running in Full auto, nobody is reading cards.
// `s` is the page's summary (status) or the server's task (its last turn).
export const runsFullAuto = (s) => !!s && s.mode === 'auto' && (s.state === 'running' || s.status === 'running' || s.turns?.at(-1)?.status === 'running');
export const notWhile = (s) => `Not while ${s.title || 'a task'} runs in Full auto.`;

// The body of POST /sessions for a pane's task: as New task sends it. `defaults` are the page's
// resolved ones (panes.js launchDefaults); leave mode out and the server falls back to Full auto.
export function launchBody(defaults = {}, prompt = '', project = null) {
  const d = defaults;
  return { prompt, ...(project ? { cwd: project.path } : { scratch: true }), agent: d.agent, mode: d.mode, model: d.model, effort: d.effort, account: d.account || undefined, worktree: d.worktree === 'off' ? false : undefined };
}

// Why a call is refused, or '' when it may go. allowed: what you allowed for this app.
export function refusal(method, allowed = []) {
  const need = Object.hasOwn(PANE_CALLS, method) && PANE_CALLS[method];
  if (!need) return `wisp has no ${String(method).slice(0, 60)}(). Panes can call: ${Object.keys(PANE_CALLS).join(', ')}.`;
  if (!allowed.includes(need)) return `Not allowed: ${method}() needs "${need}". Add it to "uses" in wisp-app.json, then allow it when you pin the app.`;
  return '';
}

// A call's arguments, checked: { args } or { error }.
export function argsOf(method, a = []) {
  const str = (x, n = MAX_TEXT) => (typeof x === 'string' && x.trim() ? x.slice(0, n) : '');
  if (method === 'tasks.get' || method === 'tasks.done') return str(a[0], 40) ? { args: [a[0]] } : { error: `${method}(id) needs a task id.` };
  if (method === 'tasks.followUp') return str(a[0], 40) && str(a[1]) ? { args: [a[0], str(a[1])] } : { error: 'tasks.followUp(id, text) needs a task id and some text.' };
  if (method === 'tasks.launch') {
    const v = a[0] && typeof a[0] === 'object' ? a[0] : { prompt: a[0] };
    if (!str(v.prompt)) return { error: 'tasks.launch({ prompt, project }) needs a prompt.' };
    return { args: [{ prompt: str(v.prompt), project: str(v.project, 200) || undefined }] };
  }
  return { args: [] };
}

// The `panes` setting: "<app>@task,<app>@home", where <app> is an app's id in My Stuff or its
// name. Pins, in order: [{ app, where }].
export function parsePanes(v) {
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
export const panesString = (pins) => pins.map((p) => `${p.app}@${p.where}`).join(',');

// Why a `panes` value can't be kept, or ''.
export function panesProblem(v) {
  if (typeof v !== 'string') return 'panes is a string like "kanban@home,pr-notes@task".';
  if (v.length > 1000) return 'panes is too long.';
  const pins = parsePanes(v);
  if (pins.length > MAX_PANES) return `At most ${MAX_PANES} panes.`;
  const bad = pins.find((p) => !PANE_WHERE.includes(p.where) || !p.app || /[,@<>"]/.test(p.app));
  return bad ? `panes: "${bad.app}@${bad.where}" should be <app id or name>@task or @home.` : '';
}

// Which of My Stuff's apps a pin means: its id, else its name or title (any case).
export function appFor(pin, items = []) {
  const apps = items.filter((x) => x.kind === 'app' && !x.pending);
  const k = String(pin.app).toLowerCase();
  return apps.find((x) => x.id === pin.app) || apps.find((x) => x.name?.toLowerCase() === k || x.title?.toLowerCase() === k) || null;
}

// --- what the frame gets: light shapes, never turns ------------------------------------------

// A secret a task's title or summary happens to quote stays out of the frame: the shared scanner,
// plus what's too short for it to be sure of but plainly a secret here.
const MORE_SECRETS = [/\bBearer\s+[\w.~+/=-]{8,}/gi, /\bsk-[A-Za-z0-9_-]{12,}/g, /\b[\w.-]*(?:KEY|TOKEN|SECRET|PASSWORD)[\w.-]*\s*=(?!=)\s*\S+/gi];
export function scrubSecrets(text) {
  return MORE_SECRETS.reduce((out, re) => out.replace(re, '[redacted]'), redactSecrets(text).text);
}

const prOf = (p) => (p ? { number: p.number, url: p.url, state: p.state, draft: !!p.draft, checks: p.checks || null, review: p.review || null, conflict: !!p.conflict } : null);

export function lightTask(s) {
  if (!s) return null;
  return {
    id: s.id,
    title: scrubSecrets(s.title || ''),
    state: s.state, // running, waiting, review, done, …
    status: s.status || '', // what its last answer said: done, partial, blocked, info, running
    project: s.project || '',
    agent: s.agent || '',
    model: s.model || '',
    mode: s.mode || '',
    branch: s.branch || '',
    summary: scrubSecrets(s.preview || ''),
    live: scrubSecrets(s.live || ''),
    unread: !!s.unread,
    archived: !!s.archived,
    asks: !!s.asks,
    ...(s.crew && { crew: { id: s.crew.id, name: s.crew.name } }),
    pr: prOf(s.pr),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// Tasks you'd see in the list: not the tour, not spells being cast, not deleted copies.
export const listedTasks = (sessions) => [...sessions].filter((s) => s && !s.pending && s.agent !== 'wisp' && s.kind !== 'spell');

export function lightPrs(sessions) {
  const out = [];
  for (const s of listedTasks(sessions)) {
    const all = [...(s.pr ? [{ repo: s.project, pr: s.pr }] : []), ...(s.prs || [])];
    for (const x of all) if (x?.pr && !out.some((o) => o.url === x.pr.url)) out.push({ ...prOf(x.pr), repo: x.repo || s.project || '', task: s.id, title: scrubSecrets(s.title || '') });
  }
  return out;
}

export const lightMember = (m) => (m ? { id: m.id, name: m.name, role: m.role || '', busy: !!(m.running || m.busy), nextAt: m.nextAt || null } : null);

// --- the frame's side: /_wisp/pane.js -----------------------------------------------------------

// What the app's page loads with <script src="/_wisp/pane.js"></script>: `wisp`, calls that post
// to the parent and resolve with its answer. Outside a pane (opened in a tab) every call refuses.
// The parent is the wrapper frame, which has no scripts: wisp's page listens on it and answers
// from itself, so an answer's source is the parent's parent.
export const PANE_CLIENT = `(()=>{if(window.wisp&&window.wisp.tasks)return;const inPane=parent!==window;let n=0;const wait=new Map();const subs={};let ctx={where:inPane?'':'tab'};
const call=(method,...args)=>new Promise((ok,no)=>{if(!inPane)return no(new Error('Pin this app as a pane in wisp to use wisp.'+method+'().'));const id=++n;wait.set(id,{ok,no});parent.postMessage({wispPane:1,id,method,args},'*')});
addEventListener('message',(e)=>{if(e.source!==parent&&e.source!==parent.parent)return;const m=e.data||{};if(!m.wispPane)return;if(m.id&&wait.has(m.id)){const w=wait.get(m.id);wait.delete(m.id);m.error?w.no(new Error(m.error)):w.ok(m.result);return}
if(m.event==='context'){ctx=Object.freeze({...m.data});}(subs[m.event]||[]).forEach((f)=>{try{f(m.data)}catch(err){console.error(err)}})});
const on=(ev,fn)=>{(subs[ev]=subs[ev]||[]).push(fn);if(ev==='tasks')call('tasks.watch').catch((err)=>console.warn(err.message));return()=>{subs[ev]=(subs[ev]||[]).filter((f)=>f!==fn)}};
window.wisp=Object.freeze({get context(){return ctx},on,
tasks:Object.freeze({list:()=>call('tasks.list'),get:(id)=>call('tasks.get',id),launch:(o)=>call('tasks.launch',o),followUp:(id,text)=>call('tasks.followUp',id,text),done:(id)=>call('tasks.done',id)}),
prs:Object.freeze({list:()=>call('prs.list')}),crew:Object.freeze({list:()=>call('crew.list')})});
if(inPane)parent.postMessage({wispPane:1,hello:1},'*');})();`;

// An app that uses wisp keeps its requests on its own origin: its files, its database.
// An app that doesn't use wisp keeps its network, but an app on loopback can't frame wisp's http page and steal clicks.
export const PANE_APP_CSP = "frame-src 'self' https: data: blob:";
export const PANE_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'";

// The wrapper around an app's frame: no sandbox and no scripts of its own, only a CSP. A frame's
// navigations answer to the CSP of the document holding it, and the sandbox has no such rule, so
// this is what stops `location = 'https://…?' + data` and a meta refresh. Exact origins, never a
// wildcard: whatever isn't an http(s) origin is dropped.
export function paneFrameCsp(origins = []) {
  const ok = origins.filter((o, i, a) => typeof o === 'string' && /^https?:\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/.test(o) && a.indexOf(o) === i);
  return `default-src 'none'; style-src 'unsafe-inline'; frame-src ${ok.join(' ') || "'none'"}`;
}

// The wrapper's document (the iframe's srcdoc). csp is paneFrameCsp's: origins can't hold a quote.
export const paneWrapperDoc = (csp) => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style></head><body></body></html>`;

// What the card shows: anything that doesn't print, or reorders what's around it, as a visible
// <U+202E>. Newlines and tabs stay. Tag characters (U+E0000…) spell text only an agent reads.
const INVISIBLE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u00AD\u034F\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB\u{E0000}-\u{E007F}]/gu;
export const showInvisible = (text) => String(text ?? '').replace(INVISIBLE, (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);
