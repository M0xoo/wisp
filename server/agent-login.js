// Signing in to a harness from wisp's page: runs the CLI's own login (claude auth login, codex
// login --device-auth, …) and turns what it prints into a link, a code, and a box for the code to
// paste back. The CLI keeps its login where it always does (~/.claude, ~/.codex, …), so on a wisp
// Grid it lands in the user's own home folder and survives restarts. wisp never sees a password.
//
// They run without a terminal (plain pipes): both claude and codex print their link and code that
// way, and read a pasted code from stdin. One login per harness at a time; it gives up after 15
// minutes.

import { spawn } from 'node:child_process';
import { bad } from './util.js';
import { shq } from './shq.js';

const TIMEOUT_MS = 15 * 60_000;
const KEEP_MS = 5 * 60_000;
const MAX_OUT = 8000;

// What each harness's login is. bin: the CLI (WISP_<ID>_BIN overrides, as the adapters do).
// signedIn(out): true, false, or null when the answer isn't one we know (then nothing is hidden).
// keys: env vars that sign the CLI in without a login.
const said = (out) => (/not (logged|signed) in/i.test(out) ? false : /(logged|signed) in/i.test(out) ? true : null);
export const LOGINS = {
  claude: { bin: 'claude', env: 'WISP_CLAUDE_BIN', args: ['auth', 'login', '--claudeai'], logout: ['auth', 'logout'], status: ['auth', 'status'], keys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'], signedIn: (out) => ({ true: true, false: false })[/"loggedIn":\s*(true|false)/.exec(out)?.[1]] ?? null },
  codex: { bin: 'codex', env: 'WISP_CODEX_BIN', args: ['login', '--device-auth'], logout: ['logout'], status: ['login', 'status'], keys: ['OPENAI_API_KEY', 'CODEX_API_KEY'], signedIn: said },
  cursor: { bin: 'cursor-agent', env: 'WISP_CURSOR_BIN', args: ['login'], logout: ['logout'], status: ['status'], keys: ['CURSOR_API_KEY'], signedIn: said, extraEnv: { NO_OPEN_BROWSER: '1' } },
  grok: { bin: 'grok', env: 'WISP_GROK_BIN', args: ['login', '--device-auth'], logout: ['logout'], status: ['models'], keys: ['XAI_API_KEY'], signedIn: (out) => (/not authenticated/i.test(out) ? false : /logged in/i.test(out) ? true : null) },
  // agy has no login command: a first prompt without a login prints Google's link and reads the
  // code back, then answers it. Its own wait for the code is short (about a minute). It only asks
  // on a terminal, so on Linux (a wisp Grid) it gets one from script(1).
  antigravity: { bin: 'agy', env: 'WISP_ANTIGRAVITY_BIN', args: ['-p', 'Reply with OK.'], tty: true, logout: null, status: ['models'], keys: ['GEMINI_API_KEY'], signedIn: (out, code) => (/sign in|authenticat/i.test(out) ? false : code === 0 ? true : null) },
  // Not a harness: GitHub for git push and pull requests (Ship it), on a box with no other way in.
  // Afterwards git uses gh's login, and commits get your GitHub name if git has none.
  gh: { bin: 'gh', env: 'WISP_GH_BIN', tool: true, args: ['auth', 'login', '--web', '--hostname', 'github.com', '--git-protocol', 'https', '--skip-ssh-key'], logout: ['auth', 'logout', '--hostname', 'github.com'], status: ['auth', 'status', '--hostname', 'github.com'], keys: ['GH_TOKEN', 'GITHUB_TOKEN'], signedIn: said, after: () => gitFromGh() },
};

// Whether a harness is signed in: false only when its CLI says so and no key in the environment
// signs it in instead. Used to keep harnesses you can't use out of the model picker.
export async function signedIn(id, env = process.env) {
  const s = LOGINS[id];
  if (!s?.status || s.keys.some((k) => env[k])) return null;
  const r = await run([bin(s), ...s.status], { timeout: 8_000 });
  return s.signedIn(r.out, r.code);
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

export function createAgentLogin({ onChange = () => {}, onDone = () => {} } = {}) {
  const flows = new Map(); // harness id -> flow

  const view = (id, f) => (f ? { agent: id, state: f.state, url: f.url, code: f.code, needsInput: f.needsInput, checking: (f.state === 'running' || f.state === 'waiting') && f.after != null && !f.needsInput, error: f.error || '', output: clean(f.out).split('\n').filter((l) => l.trim()).slice(-6).join('\n'), startedAt: f.startedAt } : { agent: id, state: 'idle' });
  const changed = (id) => onChange(view(id, flows.get(id)));

  function spec(id) {
    const s = LOGINS[id];
    if (!s) throw bad(`wisp can’t sign in to ${id} for you yet: run its login in a terminal.`, 400);
    return s;
  }

  function finish(id, f, state, error = '') {
    if (f.state !== 'running' && f.state !== 'waiting') return;
    clearTimeout(f.timer);
    Object.assign(f, { state, error });
    if (f.child && f.child.exitCode === null) f.child.kill();
    changed(id);
    if (state === 'done') Promise.resolve(LOGINS[id].after?.()).catch(() => {}).finally(() => onDone(id));
    setTimeout(() => flows.get(id) === f && flows.delete(id), KEEP_MS).unref?.();
  }

  return {
    LOGINS,
    view: (id) => (spec(id), view(id, flows.get(id))),

    async status(id) {
      const s = spec(id);
      if (!s.status) return { agent: id, signedIn: null };
      const r = await run([bin(s), ...s.status]);
      return { agent: id, signedIn: s.signedIn(r.out, r.code) };
    },

    start(id) {
      const s = spec(id);
      const prev = flows.get(id);
      if (prev && (prev.state === 'running' || prev.state === 'waiting')) return view(id, prev);
      const f = { state: 'running', out: '', url: '', code: '', needsInput: false, startedAt: Date.now() };
      flows.set(id, f);
      const [cmd, ...argv] = loginArgv(s);
      const child = spawn(cmd, argv, { env: { ...process.env, ...(s.extraEnv || {}), BROWSER: 'false', TERM: 'dumb', COLUMNS: '400' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
        if (`${f.url}|${f.code}|${f.needsInput}` !== was) changed(id);
      };
      child.stdout.on('data', take);
      child.stderr.on('data', take);
      child.on('error', (err) => finish(id, f, 'failed', `Couldn’t run ${s.bin}: ${err.message}`));
      child.on('close', async (code) => {
        if (f.state !== 'running' && f.state !== 'waiting') return;
        // Trust the CLI's own status over its exit code when it has one.
        const ok = s.status ? (await this.status(id)).signedIn : code === 0;
        finish(id, f, ok ? 'done' : 'failed', ok ? '' : clean(f.out).split('\n').filter((l) => l.trim()).at(-1) || `${s.bin} exited (${code}).`);
      });
      f.timer = setTimeout(() => finish(id, f, 'failed', 'Sign-in timed out. Start again.'), TIMEOUT_MS);
      f.timer.unref?.();
      changed(id);
      return view(id, f);
    },

    // The code the sign-in page showed, pasted back into the CLI.
    input(id, text) {
      spec(id);
      const f = flows.get(id);
      if (!f || (f.state !== 'running' && f.state !== 'waiting')) throw bad('No sign-in is waiting for a code.', 409);
      const v = String(text || '').trim();
      if (!v || v.length > 4000 || /[\r\n]/.test(v)) throw bad('Paste the code the sign-in page showed.', 400);
      f.child.stdin.write(`${v}\n`);
      f.needsInput = false;
      f.after = ''; // checking the code until the CLI finishes or asks again
      changed(id);
      return view(id, f);
    },

    cancel(id) {
      spec(id);
      const f = flows.get(id);
      if (f) finish(id, f, 'cancelled');
      return view(id, flows.get(id));
    },

    async logout(id) {
      const s = spec(id);
      if (!s.logout) throw bad(`Sign out of ${id} in a terminal.`, 400);
      const r = await run([bin(s), ...s.logout]);
      if (r.code !== 0) throw bad(r.out.trim().split('\n').at(-1) || `${s.bin} exited (${r.code}).`, 502);
      // A finished sign-in no longer says signed in (it's kept a few minutes for the page).
      const f = flows.get(id);
      if (f && f.state !== 'running' && f.state !== 'waiting') flows.delete(id);
      onDone(id);
      return { agent: id, signedIn: false };
    },

    stop() {
      for (const [id, f] of flows) finish(id, f, 'cancelled');
    },
  };
}
