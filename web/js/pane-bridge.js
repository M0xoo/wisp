// Panes: a My Stuff app pinned beside the open task (a tab in the side panel) or on split view's
// home. DOM-free, shared by the server (wisp-app.json, the `panes` setting, /_wisp/pane.js) and the
// page (features/panes.js), so the tests can check the permission rules on their own.
//
// The app runs on its own origin (services/apps.js) in a sandboxed frame. It never gets wisp's API:
// `wisp.tasks.list()` and the rest post a message to the parent page, which checks the call against
// what you allowed when you pinned it (`allowed`, a subset of what its wisp-app.json `uses`) and
// only then calls the real API. An app that uses any of this is served with a CSP that keeps its
// requests on its own origin (its files and its database), so what it reads can't leave.

// What an app may ask for, with the words the Allow card shows.
export const PANE_USES = {
  'tasks:read': 'See your tasks: title, state, project, branch, PR and the one-line summary of the last answer (not the conversation)',
  'tasks:write': 'Start tasks, send follow-ups and mark tasks done',
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

export const PANE_WHERE = ['task', 'home'];
export const MAX_PANES = 8;
// At most this many writes a minute from one pane: a loop in an app can't start a hundred tasks.
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

const prOf = (p) => (p ? { number: p.number, url: p.url, state: p.state, draft: !!p.draft, checks: p.checks || null, review: p.review || null, conflict: !!p.conflict } : null);

export function lightTask(s) {
  if (!s) return null;
  return {
    id: s.id,
    title: s.title || '',
    state: s.state, // running, waiting, review, done, …
    status: s.status || '', // what its last answer said: done, partial, blocked, info, running
    project: s.project || '',
    agent: s.agent || '',
    model: s.model || '',
    mode: s.mode || '',
    branch: s.branch || '',
    summary: s.preview || '',
    live: s.live || '',
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
    for (const x of all) if (x?.pr && !out.some((o) => o.url === x.pr.url)) out.push({ ...prOf(x.pr), repo: x.repo || s.project || '', task: s.id, title: s.title || '' });
  }
  return out;
}

export const lightMember = (m) => (m ? { id: m.id, name: m.name, role: m.role || '', busy: !!(m.running || m.busy), nextAt: m.nextAt || null } : null);

// --- the frame's side: /_wisp/pane.js -----------------------------------------------------------

// What the app's page loads with <script src="/_wisp/pane.js"></script>: `wisp`, calls that post
// to the parent and resolve with its answer. Outside a pane (opened in a tab) every call refuses.
export const PANE_CLIENT = `(()=>{if(window.wisp&&window.wisp.tasks)return;const inPane=parent!==window;let n=0;const wait=new Map();const subs={};let ctx={where:inPane?'':'tab'};
const call=(method,...args)=>new Promise((ok,no)=>{if(!inPane)return no(new Error('Pin this app as a pane in wisp to use wisp.'+method+'().'));const id=++n;wait.set(id,{ok,no});parent.postMessage({wispPane:1,id,method,args},'*')});
addEventListener('message',(e)=>{if(e.source!==parent)return;const m=e.data||{};if(!m.wispPane)return;if(m.id&&wait.has(m.id)){const w=wait.get(m.id);wait.delete(m.id);m.error?w.no(new Error(m.error)):w.ok(m.result);return}
if(m.event==='context'){ctx=Object.freeze({...m.data});}(subs[m.event]||[]).forEach((f)=>{try{f(m.data)}catch(err){console.error(err)}})});
const on=(ev,fn)=>{(subs[ev]=subs[ev]||[]).push(fn);if(ev==='tasks')call('tasks.watch').catch((err)=>console.warn(err.message));return()=>{subs[ev]=(subs[ev]||[]).filter((f)=>f!==fn)}};
window.wisp=Object.freeze({get context(){return ctx},on,
tasks:Object.freeze({list:()=>call('tasks.list'),get:(id)=>call('tasks.get',id),launch:(o)=>call('tasks.launch',o),followUp:(id,text)=>call('tasks.followUp',id,text),done:(id)=>call('tasks.done',id)}),
prs:Object.freeze({list:()=>call('prs.list')}),crew:Object.freeze({list:()=>call('crew.list')})});
if(inPane)parent.postMessage({wispPane:1,hello:1},'*');})();`;

// An app that uses wisp keeps its requests on its own origin: its files, its database.
export const PANE_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-src 'none'; object-src 'none'; base-uri 'self'";
