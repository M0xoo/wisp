// A repo set up for Conductor (conductor.build) works here too: its setup script runs in a new
// worktree and its run script is what the panel's Run offers, with Conductor's env vars.
//
//   .conductor/settings.toml   [scripts] setup = "…", run = "…" or [scripts.run.<id>] actions
//   conductor.json             { "scripts": { "setup": "…", "run": "…" } }; ignored if the toml exists
//
// Nothing else is used: not scripts.archive, scripts.run_mode, scripts.auto_run_after_setup,
// environment_variables, .conductor/settings.local.toml, ~/.conductor or what's kept only in
// Conductor's app. A file we can't read for sure refuses all of it (problem says why): half a
// config would run the wrong thing, and this one runs programs.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOML = '.conductor/settings.toml';
const JSON_FILE = 'conductor.json';
const win = process.platform === 'win32';

export const isConductorFile = (file) => file === TOML || file === JSON_FILE;

// Where Conductor keeps worktrees. Compared by real path (macOS's /tmp is /private/tmp) and, for a
// folder that's gone, as spelled; home is asked each time, not read at import.
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const fold = (p) => (win ? p.toLowerCase() : p);
const inside = (p, dir) => {
  const rel = path.relative(fold(dir), fold(p));
  return !!rel && rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
};
const spellings = (p) => [...new Set([path.resolve(p), real(p)])];
const under = (p, dirs) => spellings(p).some((x) => dirs.some((d) => spellings(d).some((y) => inside(x, y))));

// One of Conductor's workspaces of the repo checked out at `root`: what wisp may offer to bring in.
export const conductorWorkspace = (p, root, home = os.homedir()) => under(p, [path.join(home, 'conductor', 'workspaces'), path.join(home, 'conductor', 'cloud-workspaces'), path.join(root, '.conductor')]);

// Anywhere that looks like Conductor's, marked or not: the second lock on a worktree that isn't
// wisp's to remove (git.js isForeign). Wider than the offer on purpose.
export const inConductor = (p, home = os.homedir()) => !!p && (String(p).split(/[\\/]/).includes('.conductor') || under(String(p), [path.join(home, 'conductor')]));

// A number or a date: read so the document parses, never used, so never converted.
class Opaque {
  constructor(raw) {
    this.raw = raw;
  }
}

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
const SCALARS = [
  /\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?/y,
  /\d{2}:\d{2}:\d{2}(?:\.\d+)?/y,
  /0x[\da-fA-F](?:_?[\da-fA-F])*|0o[0-7](?:_?[0-7])*|0b[01](?:_?[01])*/y,
  /[+-]?(?:inf|nan)/y,
  /[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/y,
];

// TOML to Maps (keys stay in file order, even numeric ones, and __proto__ is just a key), arrays,
// strings and booleans. The whole document is read, so a line inside another key's multi-line
// string can't pass for a table. Anything it doesn't know throws with the line: it never guesses.
export function parseToml(input) {
  const text = String(input).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  let i = 0;
  const fail = (msg, at = i) => {
    throw new Error(`line ${text.slice(0, at).split('\n').length}: ${msg}`);
  };
  const match = (re) => {
    re.lastIndex = i;
    const m = re.exec(text);
    if (m) i = re.lastIndex;
    return m;
  };
  const ws = () => match(/[ \t]*/y);
  const trivia = () => match(/(?:[ \t\n]|#[^\n]*)*/y);

  const hex = (n) => {
    const m = match(n === 4 ? /[\da-fA-F]{4}/y : /[\da-fA-F]{8}/y);
    const cp = m ? parseInt(m[0], 16) : -1;
    if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('bad \\u escape');
    return String.fromCodePoint(cp);
  };
  const string = () => {
    const start = i;
    const q = text.startsWith('"""', i) ? '"""' : text.startsWith("'''", i) ? "'''" : text[i];
    const multi = q.length === 3;
    const basic = q[0] === '"';
    i += q.length;
    if (multi && text[i] === '\n') i++;
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string', start);
      if (text.startsWith(q, i)) {
        i += q.length;
        // Up to two quotes may sit right before the closing three.
        for (let n = 0; multi && n < 2 && text[i] === q[0]; n++) out += text[i++];
        return out;
      }
      const c = text[i];
      if (basic && c === '\\') {
        if (multi && match(/\\[ \t]*\n[ \t\n]*/y)) continue; // a line-ending backslash
        const e = text[i + 1];
        i += 2;
        if (e === 'u' || e === 'U') out += hex(e === 'u' ? 4 : 8);
        else if (e in ESCAPES) out += ESCAPES[e];
        else fail(`bad escape \\${e ?? ''}`, i - 2);
        continue;
      }
      if (c === '\n' && !multi) fail('unterminated string', start);
      if (c !== '\n' && c !== '\t' && (c < ' ' || c === '\x7f')) fail('a control character in a string');
      out += c;
      i++;
    }
  };
  const key = () => {
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) fail('a key can’t be a multi-line string');
    if (text[i] === '"' || text[i] === "'") return string();
    return match(/[A-Za-z0-9_-]+/y)?.[0] ?? fail('expected a key');
  };
  const keys = () => {
    const out = [key()];
    while ((ws(), text[i] === '.')) {
      i++;
      ws();
      out.push(key());
    }
    return out;
  };

  const closed = new WeakSet(); // inline tables: nothing adds to them
  const headed = new WeakSet(); // tables a [header] defined: a second one is a duplicate
  const byDots = new WeakSet(); // tables a dotted key made: no header may define them after
  const tableArrays = new WeakSet(); // [[x]]
  const both = (k) => fail(`${k} is both a value and a table`);

  const keyValue = (table) => {
    const dotted = keys();
    const last = dotted.pop();
    let t = table;
    for (const k of dotted) {
      let next = t.get(k);
      if (next === undefined) t.set(k, (next = new Map())), byDots.add(next);
      else if (!(next instanceof Map) || closed.has(next) || headed.has(next)) both(k);
      t = next;
    }
    ws();
    if (text[i] !== '=') fail(`expected = after ${last}`);
    if (t.get(last) instanceof Map) both(last);
    if (t.has(last)) fail(`duplicate key ${last}`);
    i++;
    ws();
    t.set(last, value());
  };
  const inline = () => {
    i++;
    const t = new Map();
    ws();
    if (text[i] === '}') return i++, closed.add(t), t;
    for (;;) {
      ws();
      keyValue(t);
      ws();
      if (text[i] === '}') return i++, closed.add(t), t;
      if (text[i] !== ',') fail('expected , or } in an inline table');
      i++;
    }
  };
  const array = () => {
    i++;
    const out = [];
    for (;;) {
      trivia();
      if (text[i] === ']') return i++, out;
      out.push(value());
      trivia();
      if (text[i] === ',') i++;
      else if (text[i] !== ']') fail('expected , or ] in an array');
    }
  };
  const value = () => {
    const c = text[i];
    if (c === '"' || c === "'") return string();
    if (c === '[') return array();
    if (c === '{') return inline();
    if (match(/true/y)) return true;
    if (match(/false/y)) return false;
    for (const re of SCALARS) {
      const m = match(re);
      if (m) return new Opaque(m[0]);
    }
    return fail('expected a value');
  };

  const root = new Map();
  const header = () => {
    const many = text[i + 1] === '[';
    i += many ? 2 : 1;
    ws();
    const names = keys();
    const last = names.pop();
    let t = root;
    for (const k of names) {
      let next = t.get(k);
      if (tableArrays.has(next)) next = next.at(-1);
      else if (next === undefined) t.set(k, (next = new Map()));
      else if (!(next instanceof Map) || closed.has(next)) both(k);
      t = next;
    }
    if (!text.startsWith(many ? ']]' : ']', i)) fail(`expected ${many ? ']]' : ']'} after the table name`);
    i += many ? 2 : 1;
    const had = t.get(last);
    const fresh = new Map();
    headed.add(fresh);
    if (many) {
      if (tableArrays.has(had)) had.push(fresh);
      else if (had !== undefined) both(last);
      else {
        const list = [fresh];
        tableArrays.add(list);
        t.set(last, list);
      }
      return fresh;
    }
    if (had === undefined) return t.set(last, fresh), fresh;
    if (!(had instanceof Map)) both(last);
    if (headed.has(had) || byDots.has(had) || closed.has(had)) fail(`duplicate table ${last}`);
    headed.add(had);
    return had;
  };

  let table = root;
  for (;;) {
    trivia();
    if (i >= text.length) return root;
    if (text[i] === '[') table = header();
    else keyValue(table);
    match(/[ \t]*(?:#[^\n]*)?/y);
    if (i < text.length && text[i] !== '\n') fail('junk after the value');
  }
}

const wrong = (name, want) => new Error(`${name} must be ${want}`);
const strOf = (v, name) => {
  if (v == null) return null;
  if (typeof v !== 'string') throw wrong(name, 'a string');
  return v.trim() || null;
};
const boolOf = (v, name) => {
  if (v != null && typeof v !== 'boolean') throw wrong(name, 'true or false');
  return !!v;
};
const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : win ? `"${a.replace(/"/g, '\\"')}"` : `'${a.replace(/'/g, `'\\''`)}'`);

// Relative to the workspace, and inside it. null: the workspace itself.
function cwdOf(v, name) {
  const c = strOf(v, name);
  if (!c) return null;
  if (path.isAbsolute(c) || path.win32.isAbsolute(c) || c.split(/[\\/]/).includes('..')) throw new Error(`${name} must stay inside the workspace`);
  const rel = path.normalize(c);
  return rel === '.' ? null : rel;
}

function actionOf(id, a) {
  const name = `scripts.run.${id}`;
  if (!(a instanceof Map)) throw wrong(name, 'a table');
  const args = a.get('args') ?? [];
  if (!Array.isArray(args) || args.some((x) => typeof x !== 'string')) throw wrong(`${name}.args`, 'a list of strings');
  const options = a.get('options') ?? new Map();
  if (!(options instanceof Map)) throw wrong(`${name}.options`, 'a table');
  const where = [a.get('available_in') ?? 'local'].flat();
  if (where.some((x) => typeof x !== 'string')) throw wrong(`${name}.available_in`, '"local", "cloud" or a list of them');
  const command = strOf(a.get('command'), `${name}.command`);
  return {
    command: command && [command, ...args.map(quote)].join(' '),
    cwd: cwdOf(options.get('cwd'), `${name}.options.cwd`),
    isDefault: boolOf(a.get('default'), `${name}.default`),
    shown: !boolOf(a.get('hide'), `${name}.hide`) && where.includes('local'),
  };
}

// The run script: a plain string, or the default of the named actions this computer can run, else
// the first of them.
function runOf(run) {
  if (run == null) return null;
  if (typeof run === 'string') return run.trim() ? { command: run.trim() } : null;
  if (!(run instanceof Map)) throw wrong('scripts.run', 'a string or a table of actions');
  const actions = [...run].map(([id, a]) => actionOf(id, a)).filter((a) => a.shown && a.command);
  const a = actions.find((x) => x.isDefault) || actions[0];
  return a ? { command: a.command, ...(a.cwd && { cwd: a.cwd }) } : null;
}

function scriptsOf(data) {
  const scripts = data.get('scripts');
  if (scripts == null) return { setup: null, run: null };
  if (!(scripts instanceof Map)) throw wrong('scripts', 'a table');
  return { setup: strOf(scripts.get('setup'), 'scripts.setup'), run: runOf(scripts.get('run')) };
}

const load = (root) => {
  for (const file of [TOML, JSON_FILE]) {
    try {
      return { file, text: fs.readFileSync(path.join(root, file), 'utf8') };
    } catch (err) {
      if (err.code !== 'ENOENT') return { file, error: err.message };
    }
  }
  return null;
};

// { file, setup, run: { command, cwd? } | null, problem? }, or null: not set up for Conductor.
// The toml wins even when it can't be read, as in Conductor.
export function conductorScripts(root) {
  const got = load(root);
  if (!got) return null;
  const { file, text, error } = got;
  try {
    if (error) throw new Error(error);
    if (file === TOML) return { file, ...scriptsOf(parseToml(text)) };
    const json = JSON.parse(text.replace(/^\uFEFF/, ''));
    const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
    if (!isObject(json)) throw new Error('it isn’t an object');
    return { file, ...scriptsOf(new Map([['scripts', isObject(json.scripts) ? new Map(Object.entries(json.scripts)) : json.scripts]])) };
  } catch (err) {
    return { file, setup: null, run: null, problem: `couldn't read ${file}: ${err.message}` };
  }
}

// What Conductor gives its scripts. port: the first of ten, PORT..PORT+9.
export const conductorEnv = ({ root, dir, branch, port }) => ({
  CONDUCTOR_ROOT_PATH: String(root),
  CONDUCTOR_WORKSPACE_PATH: String(dir),
  CONDUCTOR_WORKSPACE_NAME: path.basename(dir),
  CONDUCTOR_DEFAULT_BRANCH: branch || 'main',
  CONDUCTOR_PORT: String(port),
  CONDUCTOR_IS_LOCAL: '1',
});
