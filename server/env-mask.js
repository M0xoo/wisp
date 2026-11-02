// .env masking (defaults.maskEnvFiles, on unless set to 'off'): what a task shows of a .env or
// .env.* file goes to the page as KEY=•••• — the edits wisp captured, the Changes panel's diff, a
// diff block about one, and what a command that read one printed. The page's Reveal asks for one
// view unmasked (GET /sessions/:id/unmasked, or /changes?reveal=<path>). The store keeps the real
// text: rollback, revert and the agent need it. It's for screens, screen shares and phones on a
// table, not a wall: whoever can open the page can press Reveal.

import path from 'node:path';

export const DOTS = '••••';

// .env, .env.local, .env.production…; not the templates people commit (.env.example, .env.sample,
// .env.local.example).
export function isEnvFile(file) {
  const base = path.posix.basename(String(file || '').replace(/\\/g, '/'));
  return /^\.env(\.[\w.-]+)?$/.test(base) && !/\.(example|sample)$/i.test(base);
}

export const maskOn = (config) => config?.defaults?.maskEnvFiles !== 'off';

// KEY=value, export KEY=value, KEY: value. The value goes (quotes and all), a trailing comment too.
const LINE = /^(\s*(?:export\s+)?[A-Za-z_][\w.-]*\s*[=:]\s*)(\S.*)$/;

// changed: keys whose value this line should say changed (an edit's after side), so a diff still
// shows which values an edit touched.
export function maskLine(line, changed) {
  const m = LINE.exec(line);
  if (!m) return line;
  const key = m[1].replace(/^\s*(?:export\s+)?/, '').replace(/\s*[=:]\s*$/, '');
  return `${m[1]}${DOTS}${changed?.has(key) ? ' (changed)' : ''}`;
}

export const maskText = (text, changed) => (typeof text === 'string' ? text.split('\n').map((l) => maskLine(l, changed)).join('\n') : text);

const values = (text) => {
  const out = new Map();
  for (const l of String(text || '').split('\n')) {
    const m = LINE.exec(l);
    if (m) out.set(m[1].replace(/^\s*(?:export\s+)?/, '').replace(/\s*[=:]\s*$/, ''), m[2]);
  }
  return out;
};

// One captured edit { before, after }: masked on both sides, a key whose value it changed marked so
// the diff still has a line to show.
export function maskEdit(e) {
  if (!e || typeof e !== 'object') return e;
  const was = values(e.before);
  const changed = new Set([...values(e.after)].filter(([k, v]) => was.has(k) && was.get(k) !== v).map(([k]) => k));
  return { ...e, before: maskText(e.before), after: maskText(e.after, changed) };
}

// A command line that names a .env file (cat .env, head -5 apps/web/.env.local, Get-Content .env).
// Not .env.example; not `source .env`'s silence (no output to mask anyway).
const ENV_WORD = /(?:^|[\s'"`=(<>|;&/\\])(\.env(?:\.[\w.-]+)?)(?=$|[\s'"`)|;&>])/g;
export function namesEnvFile(cmd) {
  for (const m of String(cmd || '').matchAll(ENV_WORD)) if (isEnvFile(m[1])) return true;
  return false;
}

const q = (o) => new URLSearchParams(o).toString();

// An activity step: its output masked when it read a .env file. masked is the query that Reveal
// sends for it.
export function maskStep(a, turnId) {
  if (!a?.output || !(isEnvFile(a.file) || namesEnvFile(a.detail) || namesEnvFile(a.label))) return a;
  return { ...a, output: maskText(a.output), masked: q(a.call ? { turn: turnId, call: a.call } : { turn: turnId, step: a.t }) };
}

// A turn's captured change to a .env file: its edits masked, the file from before it too.
export function maskChange(c, turnId) {
  if (!c || !isEnvFile(c.file)) return c;
  const out = { ...c, edits: Array.isArray(c.edits) ? c.edits.map(maskEdit) : c.edits, masked: q({ turn: turnId, file: c.file }) };
  if (typeof c.beforeFile === 'string') out.beforeFile = maskText(c.beforeFile);
  return out;
}

// A presentation block about a .env file: a diff's hand-picked before/after, a code snippet.
export function maskBlock(b, turnId, i) {
  if (!b || !isEnvFile(b.file || b.path)) return b;
  if (b.type === 'diff' && (b.before !== undefined || b.after !== undefined)) return { ...maskEdit(b), masked: q({ turn: turnId, block: i }) };
  if (b.type === 'code' && typeof b.code === 'string') return { ...b, code: maskText(b.code), masked: q({ turn: turnId, block: i }) };
  return b;
}

export function maskTurn(t) {
  if (!t || t.stub) return t;
  const blocks = t.presentation?.blocks;
  return {
    ...t,
    ...(Array.isArray(t.activity) && { activity: t.activity.map((a) => maskStep(a, t.id)) }),
    ...(Array.isArray(t.changes) && { changes: t.changes.map((c) => maskChange(c, t.id)) }),
    ...(Array.isArray(blocks) && { presentation: { ...t.presentation, blocks: blocks.map((b, i) => maskBlock(b, t.id, i)) } }),
  };
}

// A session as the page gets it (with its childSessions).
export function maskSession(s) {
  if (!s || typeof s !== 'object') return s;
  return {
    ...s,
    ...(Array.isArray(s.turns) && { turns: s.turns.map(maskTurn) }),
    ...(s.childSessions && { childSessions: Object.fromEntries(Object.entries(s.childSessions).map(([k, x]) => [k, maskSession(x)])) }),
  };
}

// A Changes panel file (git diff rows): each row's text masked, so a changed value is a − and a +
// line that both read KEY=••••. reveal: paths the page asked to see as they are.
export function maskChangesFile(f, reveal) {
  if (!f || f.binary || !isEnvFile(f.path) || reveal?.has(f.path)) return f;
  return { ...f, rows: Array.isArray(f.rows) ? f.rows.map(maskRow) : f.rows, masked: true };
}
export const maskRow = (r) => (typeof r?.text === 'string' ? { ...r, text: maskLine(r.text) } : r);

// What Reveal returns: the one thing the query names, from the stored session as it is.
export function unmasked(s, query) {
  const t = s?.turns?.find((x) => x.id === query.get('turn'));
  if (!t) return null;
  if (query.has('call')) return t.activity?.findLast((a) => a.call === query.get('call')) || null;
  if (query.has('step')) return t.activity?.findLast((a) => String(a.t) === query.get('step')) || null;
  if (query.has('file')) {
    const c = t.changes?.find((x) => x.file === query.get('file'));
    if (!c) return null;
    const { beforeFile, ...rest } = c; // only rollback reads it
    return rest;
  }
  if (query.has('block')) return t.presentation?.blocks?.[Number(query.get('block'))] || null;
  return null;
}
