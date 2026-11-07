// wisp.lsp: the editor's language intelligence (v1 server/lsp.js, routes/lsp.js). v1's routes:
//
//   POST /sessions/:id/lsp   { op, path, text, line, col, newName } → { lsp: name, … } or { lsp: null }
//   POST /lsp/install        { lang } npm's servers (TypeScript, Pyright) into <home>/lsp

import { mkdir, readFile } from 'node:fs/promises';
import type { CallContext, PluginContext, Scope } from '@wisp/kernel';
import { type AskArgs, COMMANDS, type LspAnswer, type LspOp, OPS } from '@wisp-plugin/lsp-api';
import { COMMANDS as RUNTIME, type Session } from '@wisp-plugin/runtime-api';
import { type FolderSource, POINTS as TERMINAL_POINTS } from '@wisp-plugin/terminal-api';
import type { Later } from './client.ts';
import { ask, installArgs, Pool, SERVERS, type Spawner } from './lsp.ts';
import { sourceFile } from './source.ts';

const definePlugin = <T extends { id: string; setup(ctx: PluginContext): void | Promise<void> }>(d: T): T => d;

type Result = { status: number; json: unknown };
interface Req {
  readonly params: Readonly<Record<string, string>>;
  readonly caller: { set: string; session?: string };
  body(): Promise<unknown>;
}
interface Http {
  route(method: string, pattern: string, handler: (c: Req) => Promise<Result>, opts: { permission: string; summary?: string }): unknown;
}
interface Exec {
  exec(bin: string, args: readonly string[], opts: { cwd: string; timeoutMs: number }): Promise<{ code: number | null; stderr: string }>;
}

const asObj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
/** v1's `bad()`: a 400 the page shows as it is. */
const bad = (message: string, status = 400): Error & { status: number } => Object.assign(new Error(message), { status });

export function laterIn(scope: Scope): Later {
  return (ms, fn) => {
    const s = scope.child('timer');
    s.timeout(ms, () => (s.dispose(), fn()));
    return () => s.dispose();
  };
}

export interface LspDeps {
  pool: Pool;
  home: string;
  proc: Exec;
  folders: () => readonly FolderSource[];
}

async function rootOf(d: LspDeps, s: Session): Promise<string> {
  for (const src of d.folders()) {
    const f = await src.folder(s).catch(() => null);
    if (f && !f.gone) return f.root;
  }
  return s.cwd;
}

/** One ask, v1's checks first: a known op, a file of the task's, a rename only to a name and not under a running agent. */
export async function askFor(d: LspDeps, s: Session, a: AskArgs): Promise<LspAnswer> {
  if (!OPS.includes(a.op)) throw bad(`op is one of ${OPS.join(', ')}`);
  const root = await rootOf(d, s);
  const file = await sourceFile(root, a.path);
  if (!file) throw bad('That file isn’t in this task’s folder.', 404);
  const text = typeof a.text === 'string' ? a.text : await readFile(file, 'utf8');
  if (a.op === 'rename') {
    // It writes files: not under the agent's feet, and only to a name
    if (s.state === 'running') throw bad('The agent is working on this task: wait for it, or stop it, then rename.', 409);
    if (!/^[A-Za-z_$][\w$]*$/.test(String(a.newName ?? ''))) throw bad('newName is a name: letters, digits, _ and $');
  }
  try {
    return await ask(d.pool, root, a.op, file, text, Number(a.line) || 1, Number(a.col) || 1, a.newName !== undefined ? { newName: a.newName } : {});
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e), 502);
  }
}

/** Install; one at a time. */
export function installer(d: Pick<LspDeps, 'home' | 'proc'>): (lang: string) => Promise<{ ok: true }> {
  let installing: Promise<unknown> | null = null;
  return async (lang) => {
    const how = installArgs(lang, d.home);
    if (!how) throw bad(`wisp installs ${Object.keys(SERVERS).filter((k) => SERVERS[k as keyof typeof SERVERS].npm).join(' and ')} servers; install others yourself`);
    if (installing) throw bad('Already installing a language server', 409);
    const run = (async () => {
      await mkdir(how.dir, { recursive: true });
      return d.proc.exec('npm', how.args, { cwd: how.dir, timeoutMs: 5 * 60_000 });
    })();
    installing = run;
    try {
      const r = await run;
      if (r.code !== 0) throw bad(`Couldn’t install: ${(r.stderr.trim() || `npm exited with ${r.code}`).split('\n').slice(-3).join(' ')}`, 500);
      return { ok: true };
    } finally {
      installing = null;
    }
  };
}

const wire = (e: unknown): Result => {
  const status = typeof (e as { status?: unknown }).status === 'number' ? (e as { status: number }).status : 500;
  return { status, json: { error: e instanceof Error ? e.message : String(e) } };
};

const argsOf = (id: string, b: Record<string, unknown>): AskArgs => ({
  id, op: String(b['op'] ?? '') as LspOp, path: String(b['path'] ?? ''),
  ...(typeof b['text'] === 'string' && { text: b['text'] }),
  ...(b['line'] !== undefined && { line: Number(b['line']) }),
  ...(b['col'] !== undefined && { col: Number(b['col']) }),
  ...(b['newName'] !== undefined && { newName: String(b['newName']) }),
});

export default definePlugin({
  id: 'wisp.lsp',
  setup(ctx: PluginContext) {
    const later = laterIn(ctx.scope);
    const home = ctx.service<{ home: string }>('paths').home;
    const proc = ctx.service<Spawner & Exec>('proc');
    const pool = new Pool({ proc, later, where: { env: process.env, platform: process.platform, home }, pid: process.pid });
    ctx.scope.add(() => pool.stopAll());
    const d: LspDeps = { pool, home, proc, folders: () => ctx.contributions<FolderSource>(TERMINAL_POINTS.folder) };
    const install = installer(d);
    const get = (c: Pick<CallContext, 'run'>, id: string): Promise<Session> => c.run<Session>(RUNTIME.get, { id });
    ctx.command({ id: COMMANDS.ask, readOnly: true, run: async (a: unknown, c: CallContext) => askFor(d, await get(c, String(asObj(a)['id'] ?? '')), argsOf(String(asObj(a)['id'] ?? ''), asObj(a))) });
    ctx.command({ id: COMMANDS.install, run: (a: unknown) => install(String(asObj(a)['lang'] ?? '')) });

    const http = ctx.service<Http>('http');
    http.route('POST', '/sessions/:id/lsp', async (c) => {
      const id = c.params['id'] ?? '';
      const s = await ctx.run<Session>(RUNTIME.get, { id }, { caller: { set: c.caller.set, ...(c.caller.session && { session: c.caller.session }) } }).catch(() => null);
      if (!s) return { status: 404, json: { error: 'no such session' } };
      return askFor(d, s, argsOf(id, asObj(await c.body()))).then((json) => ({ status: 200, json }), wire);
    }, { permission: 'lsp:ask', summary: 'Ask the task’s language server' });
    http.route('POST', '/lsp/install', async (c) => install(String(asObj(await c.body())['lang'] ?? '')).then((json) => ({ status: 200, json }), wire), { permission: 'lsp:install', summary: 'Install a language server' });
  },
});

export { openapi } from './openapi.ts';
