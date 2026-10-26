// Signing in to a harness from wisp's page: runs the CLI's own login (claude auth login, codex
// login --device-auth, …) and turns what it prints into a link, a code, and a box for the code to
// paste back. The CLI keeps its login where it always does (~/.claude, ~/.codex, …), so on a wisp
// Grid it lands in the user's own home folder and survives restarts. wisp never sees a password.
//
// They run without a terminal (plain pipes): both claude and codex print their link and code that
// way, and read a pasted code from stdin. One login per harness at a time; it gives up after 15
// minutes.
//
// A harness with several accounts (server/accounts.js) signs each one in on its own: the same login
// with that account's folder in the env, kept apart by `account` (none or 'default': the CLI's own).

import { spawn } from './proc.js'; // runs npm's .cmd shims on Windows
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bad } from './util.js';
import { shq } from './shq.js';

const TIMEOUT_MS = 15 * 60_000;
const KEEP_MS = 5 * 60_000;
const MAX_OUT = 8000;

// What each harness's login is. bin: the CLI (WISP_<ID>_BIN overrides, as the adapters do).
// signedIn(out): true, false, or null when the answer isn't one we know (then nothing is hidden).
// keys: env vars that sign the CLI in without a login. logout: the CLI's sign-out arguments, or a
// function that does it when the CLI has no such command.
const said = (out) => (/not (logged|signed) in/i.test(out) ? false : /(logged|signed) in/i.test(out) ? true : null);
export const LOGINS = {
  claude: { bin: 'claude', env: 'WISP_CLAUDE_BIN', args: ['auth', 'login', '--claudeai'], logout: ['auth', 'logout'], status: ['auth', 'status'], keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'], signedIn: (out) => ({ true: true, false: false })[/"loggedIn":\s*(true|false)/.exec(out)?.[1]] ?? null },
  codex: { bin: 'codex', env: 'WISP_CODEX_BIN', args: ['login', '--device-auth'], logout: ['logout'], status: ['login', 'status'], keys: ['OPENAI_API_KEY', 'CODEX_API_KEY'], signedIn: said },
  cursor: { bin: 'cursor-agent', env: 'WISP_CURSOR_BIN', args: ['login'], logout: ['logout'], status: ['status'], keys: ['CURSOR_API_KEY'], signedIn: said, extraEnv: { NO_OPEN_BROWSER: '1' } },
  grok: { bin: 'grok', env: 'WISP_GROK_BIN', args: ['login', '--device-auth'], logout: ['logout'], status: ['models'], keys: ['XAI_API_KEY'], signedIn: (out) => (/not authenticated/i.test(out) ? false : /logged in/i.test(out) ? true : null) },
  // agy has no login command: a first prompt without a login prints Google's link and reads the
  // code back, then answers it. Its own wait for the code is short (about a minute). It only asks
  // on a terminal, so on Linux (a wisp Grid) it gets one from script(1). Signing out is only /logout
  // inside its own TUI, so wisp removes the login where agy keeps it.
  antigravity: { bin: 'agy', env: 'WISP_ANTIGRAVITY_BIN', args: ['-p', 'Reply with OK.'], tty: true, logout: () => forgetAgy(), status: ['models'], keys: ['GEMINI_API_KEY'], signedIn: (out, code) => (/sign in|authenticat/i.test(out) ? false : code === 0 ? true : null) },
  // Not a harness: GitHub for git push and pull requests (Ship it), on a box with no other way in.
  // Afterwards git uses gh's login, and commits get your GitHub name if git has none.
  gh: { bin: 'gh', env: 'WISP_GH_BIN', tool: true, args: ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key'], logout: ['auth', 'logout', '--hostname', 'github.com'], status: ['auth', 'status', '--hostname', 'github.com'], keys: ['GH_TOKEN', 'GITHUB_TOKEN'], signedIn: said, after: () => gitFromGh() },
};

// Harnesses that sign in with an API key pasted into wisp rather than a login command. opencode's
// own `auth login` only asks on a terminal, so wisp keeps the key where it does (auth.json, as
// `{ type: 'api', key }` per provider); `opencode run` reads it from there. Zen and Go are two
// providers with keys from the same page.
export const KEYS = {
  opencode: {
    env: 'OPENCODE_API_KEY',
    url: 'https://opencode.ai/auth',
    providers: [
      { id: 'opencode', name: 'Zen' },
      { id: 'opencode-go', name: 'Go' },
    ],
    // opencode's data folder (xdg-basedir: the same rule on every OS).
    file: (env = process.env, home = os.homedir()) => path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'opencode', 'auth.json'),
  },
};

function readAuth(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    const v = JSON.parse(text || '{}');
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch {}
  // Never overwrite a file we can't read: it holds the user's other providers' logins too.
  throw bad(`wisp can’t read ${file}: fix or remove it, then try again.`, 409);
}

function writeAuth(file, auth) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Which providers have a key (never the key itself). env: OPENCODE_API_KEY signs in every one.
export function keysOf(id, env = process.env) {
  const k = KEYS[id];
  if (!k) throw bad(`${id} doesn’t sign in with a key.`, 400);
  const auth = readAuth(k.file(env));
  return { agent: id, url: k.url, env: env[k.env] ? k.env : '', providers: k.providers.map((p) => ({ ...p, set: !!auth[p.id] })) };
}

function provider(id, pid) {
  const k = KEYS[id];
  if (!k) throw bad(`${id} doesn’t sign in with a key.`, 400);
  if (!k.providers.some((p) => p.id === pid)) throw bad(`Pick one of ${k.providers.map((p) => p.name).join(', ')}.`, 400);
  return k;
}

export function setKey(id, pid, key, env = process.env) {
  const k = provider(id, pid);
  const v = String(key || '').trim();
  if (!v || v.length > 500 || /\s/.test(v)) throw bad(`Paste the API key from ${k.url}.`, 400);
  const file = k.file(env);
  writeAuth(file, { ...readAuth(file), [pid]: { type: 'api', key: v } });
  return keysOf(id, env);
}

export function removeKey(id, pid, env = process.env) {
  const k = provider(id, pid);
  const file = k.file(env);
  const auth = readAuth(file);
  if (auth[pid]) {
    delete auth[pid];
    writeAuth(file, auth);
  }
  return keysOf(id, env);
}

// Whether a harness is signed in: false only when its CLI says so and no key in the environment
// signs it in instead. Used to keep harnesses you can't use out of the model picker.
export async function signedIn(id, env = process.env) {
  const s = LOGINS[id];
  if (!s?.status || s.keys.some((k) => env[k])) return null;
  const r = await run([bin(s), ...s.status], { timeout: 8_000 });
  return s.signedIn(r.out, r.code);
}

// agy's login: the system keychain on macOS (service "gemini", account "antigravity"), a file in
// ~/.gemini where there's no keychain (Linux, a wisp Grid).
export async function forgetAgy(home = os.homedir(), platform = process.platform) {
  fs.rmSync(path.join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), { force: true });
  if (platform === 'darwin') await run(['security', 'delete-generic-password', '-s', 'gemini', '-a', 'antigravity']);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[()][A-Z0-9]|\r/g;
export const clean = (s) => String(s).replace(ANSI, '');

// What the output says so far: the first link, a one-time code, whether it waits for a paste.
export function parse(text) {
  const t = clean(text);
  const url = /https?:\/\/[^\s"'<>]+/.exec(t)?.[0] || '';
  const code = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/.exec(t.replace(url, ''))?.[1] || '';
  const needsInput = /paste (the )?(authorization )?code|enter (the )?(authorization )?code here|code here if prompted/i.test(t);
  return { url, code, needsInput };
}

const bin = (spec) => process.env[spec.env] || spec.bin;
// The login's command line: under script(1) when the CLI needs a terminal (util-linux's flags).
const loginArgv = (spec) => (spec.tty && process.platform === 'linux' ? ['script', '-qfec', [bin(spec), ...spec.args].map(shq).join(' '), '/dev/null'] : [bin(spec), ...spec.args]);

// After gh signs in: git pushes with its login, and has a name and email for commits.
async function gitFromGh() {
  const gh = process.env.WISP_GH_BIN || 'gh';
  await run([gh, 'auth', 'setup-git', '--hostname', 'github.com']);
  const has = async (k) => (await run(['git', 'config', '--global', k])).out.trim();
  if ((await has('user.name')) && (await has('user.email'))) return;
  const r = await run([gh, 'api', 'user']);
  let u;
  try {
    u = JSON.parse(r.out);
  } catch {
    return;
  }
  if (!u?.login) return;
  if (!(await has('user.name'))) await run(['git', 'config', '--global', 'user.name', u.name || u.login]);
  if (!(await has('user.email'))) await run(['git', 'config', '--global', 'user.email', u.email || `${u.id}+${u.login}@users.noreply.github.com`]);
}

function run(argv, { timeout = 15_000, env = {} } = {}) {
  return new Promise((resolve) => {
    let out = '';
    const p = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => p.kill(), timeout);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', (err) => resolve({ code: -1, out: err.message }));
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out: clean(out) });
    });
  });
}

// Who a login is, from what the CLI says or keeps: { email, plan }. Claude's status is JSON; Codex
// keeps its ChatGPT id token (a JWT with the email and plan) in auth.json.
export function whoIs(id, out, env = process.env) {
  if (id === 'claude') {
    try {
      const j = JSON.parse(String(out).slice(String(out).indexOf('{')));
      return { email: j.email || '', plan: j.subscriptionType ? j.subscriptionType[0].toUpperCase() + j.subscriptionType.slice(1) : '' };
    } catch {
      return {};
    }
  }
  if (id === 'codex') {
    try {
      const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
      const token = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'))?.tokens?.id_token || '';
      const claims = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
      const plan = claims['https://api.openai.com/auth']?.chatgpt_plan_type || '';
      return { email: claims.email || '', plan: plan ? plan[0].toUpperCase() + plan.slice(1) : '' };
    } catch {
      return {};
    }
  }
  return {};
}

// accounts: server/accounts.js, for harnesses with more than one (null: only the CLI's own).
export function createAgentLogin({ onChange = () => {}, onDone = () => {}, accounts = null } = {}) {
  const flows = new Map(); // harness id, or id/account -> flow
  const keyOf = (id, acc) => (acc && acc !== 'default' ? `${id}/${acc}` : id);
  // The account's folder in the env (made ready first); {} for the CLI's own.
  const envOf = (id, acc) => {
    if (!acc || acc === 'default' || !accounts?.supports(id)) return {};
    if (!accounts.get(id, acc)) throw bad('No such account.', 404);
    accounts.prepare(id, acc);
    return accounts.envFor(id, acc);
  };
  const acct = (acc) => (acc && acc !== 'default' ? acc : '');

  const view = (id, f, acc = '') => (f ? { agent: id, account: acct(acc), state: f.state, url: f.url, code: f.code, needsInput: f.needsInput, checking: (f.state === 'running' || f.state === 'waiting') && f.after != null && !f.needsInput, error: f.error || '', output: clean(f.out).split('\n').filter((l) => l.trim()).slice(-6).join('\n'), startedAt: f.startedAt } : { agent: id, account: acct(acc), state: 'idle' });
  const changed = (id, acc) => onChange(view(id, flows.get(keyOf(id, acc)), acc));

  function spec(id) {
    const s = LOGINS[id];
    if (!s && KEYS[id]) throw bad(`${id} signs in with an API key: add one in Settings → Agents.`, 400);
    if (!s) throw bad(`wisp can’t sign in to ${id} for you yet: run its login in a terminal.`, 400);
    return s;
  }

  function finish(id, f, state, error = '') {
    if (f.state !== 'running' && f.state !== 'waiting') return;
    const acc = f.account || '';
    clearTimeout(f.timer);
    Object.assign(f, { state, error });
    if (f.child && f.child.exitCode === null) f.child.kill();
    changed(id, acc);
    if (state === 'done') Promise.resolve(LOGINS[id].after?.()).catch(() => {}).finally(() => onDone(id));
    setTimeout(() => flows.get(keyOf(id, acc)) === f && flows.delete(keyOf(id, acc)), KEEP_MS).unref?.();
  }

  return {
    LOGINS,
    view: (id, acc = '') => (spec(id), view(id, flows.get(keyOf(id, acc)), acc)),

    // Signed in or not, and as whom (kept on the account for the page).
    async status(id, acc = '') {
      const s = spec(id);
      if (!s.status) return { agent: id, account: acct(acc), signedIn: null };
      const env = envOf(id, acc);
      const r = await run([bin(s), ...s.status], { env });
      const signedIn = s.signedIn(r.out, r.code);
      const who = signedIn ? whoIs(id, r.out, { ...process.env, ...env }) : {};
      if (accounts?.multi?.(id) && signedIn !== null) accounts.identify(id, acc || 'default', { ...who, signedIn });
      return { agent: id, account: acct(acc), signedIn, ...who };
    },

    start(id, acc = '') {
      const s = spec(id);
      const env = envOf(id, acc);
      const key = keyOf(id, acc);
      const prev = flows.get(key);
      if (prev && (prev.state === 'running' || prev.state === 'waiting')) return view(id, prev, acc);
      const f = { state: 'running', out: '', url: '', code: '', needsInput: false, startedAt: Date.now(), account: acct(acc) };
      flows.set(key, f);
      const [cmd, ...argv] = loginArgv(s);
      const child = spawn(cmd, argv, { env: { ...process.env, ...env, ...(s.extraEnv || {}), BROWSER: 'false', TERM: 'dumb', COLUMNS: '400' }, stdio: ['pipe', 'pipe', 'pipe'] });
      f.child = child;
      child.stdin.on('error', () => {});
      const take = (d) => {
        f.out = (f.out + d).slice(-MAX_OUT);
        // After a paste, only what the CLI says since then can ask for a code again (a wrong one).
        if (f.after != null) f.after = (f.after + d).slice(-MAX_OUT);
        const p = parse(f.out);
        const was = `${f.url}|${f.code}|${f.needsInput}`;
        Object.assign(f, { url: p.url || f.url, code: p.code || f.code, needsInput: f.after != null ? parse(f.after).needsInput : p.needsInput });
        if (f.url && f.state === 'running') f.state = 'waiting';
        if (`${f.url}|${f.code}|${f.needsInput}` !== was) changed(id, acc);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (err) => finish(id, f, 'failed', `Couldn’t run ${s.bin}: ${err.message}`));
      child.on('close', async (code) => {
        if (f.state !== 'running' && f.state !== 'waiting') return;
        // Trust the CLI's own status over its exit code when it has one.
        const ok = s.status ? (await this.status(id, acc)).signedIn : code === 0;
        finish(id, f, ok ? 'done' : 'failed', ok ? '' : clean(f.out).split('\n').filter((l) => l.trim()).at(-1) || `${s.bin} exited (${code}).`);
      });
      f.timer = setTimeout(() => finish(id, f, 'failed', 'Sign-in timed out. Start again.'), TIMEOUT_MS);
      f.timer.unref?.();
      changed(id, acc);
      return view(id, f, acc);
    },

    // The code the sign-in page showed, pasted back into the CLI.
    input(id, text, acc = '') {
      spec(id);
      const f = flows.get(keyOf(id, acc));
      if (!f || (f.state !== 'running' && f.state !== 'waiting')) throw bad('No sign-in is waiting for a code.', 409);
      const v = String(text || '').trim();
      if (!v || v.length > 4000 || /[\r\n]/.test(v)) throw bad('Paste the code the sign-in page showed.', 400);
      f.child.stdin.write(`${v}\n`);
      f.needsInput = false;
      f.after = ''; // checking the code until the CLI finishes or asks again
      changed(id, acc);
      return view(id, f, acc);
    },

    cancel(id, acc = '') {
      spec(id);
      const f = flows.get(keyOf(id, acc));
      if (f) finish(id, f, 'cancelled');
      return view(id, flows.get(keyOf(id, acc)), acc);
    },

    async logout(id, acc = '') {
      const s = spec(id);
      const env = envOf(id, acc);
      const key = s.keys.find((k) => process.env[k]);
      if (key) throw bad(`${s.bin} is signed in with ${key}: remove it from wisp's environment to sign out.`, 400);
      if (typeof s.logout === 'function') {
        await s.logout();
        // Gone from where we know to look; if the CLI still says signed in, it kept it elsewhere.
        if ((await this.status(id)).signedIn) throw bad(`${s.bin} is still signed in: run ${s.bin} in a terminal and type /logout.`, 502);
      } else {
        const r = await run([bin(s), ...s.logout], { env });
        if (r.code !== 0) throw bad(r.out.trim().split('\n').at(-1) || `${s.bin} exited (${r.code}).`, 502);
      }
      // A finished sign-in no longer says signed in (it's kept a few minutes for the page).
      const f = flows.get(keyOf(id, acc));
      if (f && f.state !== 'running' && f.state !== 'waiting') flows.delete(keyOf(id, acc));
      if (accounts?.multi?.(id)) accounts.identify(id, acc || 'default', { signedIn: false });
      onDone(id);
      return { agent: id, account: acct(acc), signedIn: false };
    },

    // Key sign-ins (opencode): its models are looked up again once a key is added or removed.
    keys: (id) => keysOf(id),
    setKey(id, pid, key) {
      const v = setKey(id, pid, key);
      onDone(id);
      return v;
    },
    removeKey(id, pid) {
      const v = removeKey(id, pid);
      onDone(id);
      return v;
    },

    stop() {
      for (const [id, f] of flows) finish(id, f, 'cancelled');
    },
  };
}
