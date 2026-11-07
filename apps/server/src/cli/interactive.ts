// `wisp`, `wisp "task"` and `wisp add [path]`: open the app (or a browser tab), launch from the terminal,
// add projects. The desktop window is the Tauri shell from this version's release (desktop-shell.ts), on
// this Node; it runs the server in its own process, so it outlives this terminal. Without it, or with
// --browser/--no-open, the server runs here. A task or `add` sent to a wisp already running just goes
// over the API, no window.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { WispClient, type Config } from '../client.ts';
import { VERSION } from '../meta.ts';
import { openUrl, sleep, type Ctx } from './context.ts';
import { desktopShell, noAppLine, shellEnv } from './desktop-shell.ts';
import { packageRoot } from './root.ts';

// 150 × 200 ms: the app's first start unpacks and boots a server.
const SERVER_WAIT = { tries: 150, every: 200 };
const REPO_URL = /^(https?:|ssh:|git:|git@|(www\.)?github\.com\/)/i;

interface Project {
  name: string;
  path: string;
}

async function waitForServer(ctx: Ctx, wisp: WispClient): Promise<void> {
  for (let i = 0; i < SERVER_WAIT.tries; i++) {
    if (await wisp.config().then(() => true, () => false)) return;
    await sleep(SERVER_WAIT.every);
  }
  ctx.die('the wisp app did not start in time — try `wisp --browser`');
}

/** Starts the desktop shell, detached; false when there is none here (and says so). */
async function openApp(ctx: Ctx): Promise<boolean> {
  const shell = await desktopShell({ version: VERSION, say: (line) => console.log(line) });
  if (shell.exe === null) {
    console.log(noAppLine(shell.message));
    return false;
  }
  spawn(shell.exe, [], { detached: true, stdio: 'ignore', env: shellEnv(process.env, { port: ctx.flags.port, root: packageRoot().dir }) })
    .on('error', () => {})
    .unref();
  return true; // the app holds the server
}

export async function interactive(ctx: Ctx, words: string[], adding: boolean): Promise<void> {
  const { flags } = ctx;
  const base = `http://localhost:${flags.port}`;
  const wisp = new WispClient({ url: base });
  const running = await wisp.config().then(() => true, () => false);
  const app = flags.open && !flags.browser && (!running || !words.length) ? await openApp(ctx) : false;
  if (app) {
    if (!running) await waitForServer(ctx, wisp);
    console.log(`\n  ◌ wisp is open\n`);
  } else if (!running) {
    const { startServer } = await import('../index.ts');
    // WISP_HOST: in a wisp Grid container the edge reaches wisp through a published port.
    const host = process.env['WISP_HOST'];
    await startServer({ port: flags.port, ...(host ? { host } : {}) });
    console.log(`\n  ◌ wisp is floating at ${base}\n`);
  }
  const done = running || app; // the running wisp, or the app, shows it: nothing more to do here
  let openPath = '/';
  if (adding) {
    await addProject(wisp, words[1]);
    if (done) process.exit(0);
  } else if (words.length) {
    const s = await launchHere(ctx, wisp, words);
    console.log(`  ◌ launched: ${s.title}`);
    openPath = `/#/s/${s.id}`;
    if (done) process.exit(0); // the running wisp will show it in the queue
  }
  if (app) process.exit(0);
  if (flags.open) openUrl(`${base}${openPath}`);
}

async function addProject(wisp: WispClient, target: string | undefined): Promise<void> {
  // A repo URL is cloned by the server (into ~/code unless defaults.cloneDir says otherwise).
  const url = REPO_URL.test(target || '');
  if (url) console.log(`  ◌ cloning ${target}…`);
  const body = url ? { repo: target } : { path: path.resolve(target || process.cwd()) };
  const p = await wisp.request<Project>('POST', '/projects', body).catch((e: unknown) => void console.error(`  ✗ ${e instanceof Error ? e.message : String(e)}`));
  if (p) console.log(`  ✓ project added: ${p.name}  (${p.path})`);
}

async function launchHere(ctx: Ctx, wisp: WispClient, words: string[]): Promise<{ id: string; title: string }> {
  const { flags } = ctx;
  const cfg: Config = await wisp.config();
  const d = cfg.defaults ?? {};
  const agent = flags.agent || d.agent;
  // Models are remembered per agent (ids aren't portable between harnesses).
  const model = flags.model ?? (agent ? d.models?.[agent] : undefined) ?? (agent === d.agent ? d.model : '');
  return wisp.request('POST', '/sessions', { prompt: words.join(' '), cwd: ctx.cwd, agent, mode: flags.mode || d.mode, model, effort: flags.effort || '' });
}
