// `npm run typecheck`: every TypeScript program, tests included, in parallel (one tsc per program).
// The programs, between them, cover each package's own tsconfig.json (what monoflow verify runs per package):
// - tsconfig.json: protocol, sync, client, tokens, kernel-side packages, plugin api/host, tools (src + test)
// - tsconfig.web.json: ui, shell, client, every plugins/*/ui and apps/web (src + test + dev + gallery);
//   every web package's tsconfig.json extends it with the same options, so one program checks them all
// - apps/web/tsconfig.dev.json: the web app's dev server, tests and vite configs (node + vite/client types)
// - mobile/web/tsconfig.json: the Android bundle (not an npm workspace, so nothing else checks it)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const PROGRAMS = ['tsconfig.json', 'tsconfig.web.json', 'apps/web/tsconfig.dev.json', 'mobile/web/tsconfig.json'];
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

function run(project: string): Promise<{ project: string; code: number; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [tsc, '-p', project, '--pretty'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => done({ project, code: code ?? 1, out }));
  });
}

const started = performance.now();
const results = await Promise.all(PROGRAMS.map(run));
const failed = results.filter((r) => r.code !== 0);
for (const r of failed) process.stdout.write(`\n── ${r.project}\n${r.out}`);
const secs = ((performance.now() - started) / 1000).toFixed(1);
console.log(failed.length ? `typecheck: ${failed.length} of ${PROGRAMS.length} programs failed (${secs}s)` : `typecheck: ${PROGRAMS.length} programs, 0 errors (${secs}s)`);
process.exitCode = failed.length ? 1 : 0;
