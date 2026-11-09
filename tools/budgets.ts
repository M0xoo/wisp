// Budgets fail CI (ADR-0011, plan §8). The UI half, measured on the build (`npm run build --workspace
// @wisp/web` first): what the first page load needs, brotli-compressed at the quality the edge
// serves (crates/wisp-api statics: brotli 11):
//   initial JS   the entry module and every modulepreload index.html names   ≤ 120 KB br
//   initial CSS  every stylesheet index.html links                              ≤ 30 KB br
// Lazy chunks (a task's view, the palette, a plugin's screens) are listed, not budgeted: they load
// when they show. The server half (cold start, RSS, list query, write amplification, patch latency)
// is measured by the Rust benches (crates/*/benches, spikes/*) and gated there.
//
//   node tools/budgets.ts [--dist=apps/web/dist] [--json]

import { brotliCompressSync, constants } from 'node:zlib';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

export const BUDGETS = { initialJsBr: 120 * 1024, initialCssBr: 30 * 1024 } as const;

/** The durable event log's budgets (ADR-0044), measured and gated by `spikes/events` (it exits 1 on a miss). */
export const EVENT_BUDGETS = {
  /** emit → in-process handler, p99 */
  emitToHandlerP99Ms: 1,
  /** durable appends a second */
  durableAppendPerS: 20_000,
  /** replay of 100 000 events to a durable subscription */
  replay100kMs: 1_000,
  /** the events:* topic to a client, p99 (the sync path's budget: spikes/sync-bench-rs) */
  topicP99Ms: 150,
  /** write amplification on the streaming bench: unchanged, since stream events stay ephemeral */
  writeAmplification: 15,
} as const;

const arg = (name: string): string | undefined => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const dist = arg('dist') ?? join(import.meta.dirname, '..', 'apps', 'web', 'dist');

const br = (buf: Buffer): number => brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: buf.length } }).length;
const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;

export interface Measured {
  initialJs: { files: string[]; raw: number; br: number };
  initialCss: { files: string[]; raw: number; br: number };
  lazy: { file: string; br: number }[];
}

/** The files the first load fetches, read from index.html's tags. */
export function initialFiles(html: string): { js: string[]; css: string[] } {
  const js = new Set<string>();
  const css = new Set<string>();
  for (const m of html.matchAll(/<script\b[^>]*type="module"[^>]*\bsrc="([^"]+)"/g)) if (m[1]) js.add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*\bhref="([^"]+)"/g)) if (m[1]) js.add(m[1]);
  for (const m of html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*\bhref="([^"]+)"/g)) if (m[1]) css.add(m[1]);
  return { js: [...js], css: [...css] };
}

export function measure(dir: string): Measured {
  const html = readFileSync(join(dir, 'index.html'), 'utf8');
  const { js, css } = initialFiles(html);
  const read = (url: string): Buffer => readFileSync(join(dir, url.replace(/^\//, '')));
  const sum = (urls: string[]): { files: string[]; raw: number; br: number } => {
    let raw = 0;
    let b = 0;
    for (const u of urls) {
      const buf = read(u);
      raw += buf.length;
      b += br(buf);
    }
    return { files: urls, raw, br: b };
  };
  const initial = new Set([...js, ...css].map((u) => u.replace(/^\//, '')));
  const assets = existsSync(join(dir, 'assets')) ? readdirSync(join(dir, 'assets')).map((f) => `assets/${f}`) : [];
  const lazy = assets.filter((f) => f.endsWith('.js') && !initial.has(f)).map((file) => ({ file, br: br(readFileSync(join(dir, file))) }));
  return { initialJs: sum(js), initialCss: sum(css), lazy: lazy.sort((a, b) => b.br - a.br) };
}

function main(): void {
  if (!existsSync(join(dist, 'index.html'))) {
    console.error(`budgets: no build at ${relative(process.cwd(), dist)} (npm run build --workspace @wisp/web)`);
    process.exitCode = 1;
    return;
  }
  const m = measure(dist);
  const over: string[] = [];
  if (m.initialJs.br > BUDGETS.initialJsBr) over.push(`initial JS ${kb(m.initialJs.br)} br > ${kb(BUDGETS.initialJsBr)}`);
  if (m.initialCss.br > BUDGETS.initialCssBr) over.push(`initial CSS ${kb(m.initialCss.br)} br > ${kb(BUDGETS.initialCssBr)}`);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ ...m, budgets: BUDGETS, over }, null, 2));
  } else {
    console.log(`initial JS   ${kb(m.initialJs.br).padStart(9)} br  (${kb(m.initialJs.raw)} raw, ${m.initialJs.files.length} files)  budget ${kb(BUDGETS.initialJsBr)}`);
    console.log(`initial CSS  ${kb(m.initialCss.br).padStart(9)} br  (${kb(m.initialCss.raw)} raw, ${m.initialCss.files.length} files)  budget ${kb(BUDGETS.initialCssBr)}`);
    console.log(`lazy chunks  ${m.lazy.length}, largest: ${m.lazy.slice(0, 5).map((l) => `${l.file.replace('assets/', '')} ${kb(l.br)}`).join(', ') || 'none'}`);
    for (const o of over) console.error(`OVER BUDGET: ${o}`);
  }
  process.exitCode = over.length > 0 ? 1 : 0;
}

if (import.meta.filename === process.argv[1]) main();
