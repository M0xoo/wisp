// Gate G6 (plan §9.1): recorded raw output from every CLI parses the same in v2 as in v1. Test
// support only (`@wisp/harness-kit/g6`), never imported by shipped code.
//
// A fixture is a CLI's stdout as it came (`<name>.jsonl`), with `<name>.meta.json`: the exit (code,
// stderr), the run options the turn had, and whether the run was stopped. `<name>.v1.json` is what
// v1's adapter reported for those bytes (the golden). Both v1's adapter and the v2 module run
// `cli.mjs` as their CLI, so the whole path (process, line splitting, the parser) is compared.

import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The CLI both sides run: it records (tee) or replays (cli.mjs). */
export const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export interface FixtureMeta {
  exit: { code: number | null; signal?: string | null; stderr: string };
  /** run options besides the prompt: prior, unknownPrior, mode, fork, … */
  opts?: Record<string, unknown>;
  /** the run was stopped once its output was in (FAKE_HANG): stop() after `stopAfter` events */
  stopAfter?: number;
  /** keys dropped before comparing, as paths: 'stats.durationMs' (a clock reading) */
  drop?: string[];
  argv?: string[];
  note?: string;
}

export interface Fixture {
  name: string;
  file: string;
  meta: FixtureMeta;
  golden: unknown[] | null;
}

export async function loadFixtures(dir: string): Promise<Fixture[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -'.jsonl'.length)).sort();
  const read = async (f: string): Promise<unknown> => JSON.parse(await readFile(path.join(dir, f), 'utf8')) as unknown;
  return Promise.all(
    names.map(async (name) => ({
      name,
      file: path.join(dir, `${name}.jsonl`),
      meta: (await read(`${name}.meta.json`).catch(() => ({ exit: { code: 0, stderr: '' } }))) as FixtureMeta,
      golden: (await read(`${name}.v1.json`).catch(() => null)) as unknown[] | null,
    })),
  );
}

/** The env that makes cli.mjs print this fixture. */
export const replayEnv = (f: Fixture): Record<string, string> => ({
  WISP_REPLAY_FILE: f.file,
  WISP_REPLAY_EXIT: String(f.meta.exit.code ?? 1),
  WISP_REPLAY_STDERR: f.meta.exit.stderr,
  ...(f.meta.stopAfter !== undefined && { WISP_REPLAY_HANG: '1' }),
});

const dropPath = (v: unknown, keys: string[]): void => {
  if (!v || typeof v !== 'object') return;
  const [head, ...rest] = keys;
  if (head === undefined) return;
  const o = v as Record<string, unknown>;
  if (!rest.length) delete o[head];
  else dropPath(o[head], rest);
};

const escaped = (s: string): string => JSON.stringify(s).slice(1, -1);

/**
 * Events as JSON says them (undefined keys gone), with the run's folder as @CWD@ (both spellings,
 * /tmp and /private/tmp), minus the dropped keys.
 */
export function normalize(events: readonly unknown[], drop: readonly string[] = [], cwds: readonly string[] = []): unknown[] {
  let text = JSON.stringify(events);
  for (const c of [...new Set(cwds)].sort((a, b) => b.length - a.length)) text = text.replaceAll(escaped(c), '@CWD@');
  const out = JSON.parse(text) as unknown[];
  for (const e of out) for (const d of drop) dropPath(e, d.split('.'));
  return out;
}

export interface RunLike {
  run(o: Record<string, unknown> & { onEvent(e: unknown): void }): { stop(): void; done: Promise<void> };
}

/** Runs a harness (v1 adapter or v2 module) over a fixture and collects what it reports. */
export async function collect(h: RunLike, f: Fixture, base: Record<string, unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  const stopAfter = f.meta.stopAfter;
  let handle: { stop(): void; done: Promise<void> } | undefined;
  let stopped = false;
  handle = h.run({
    ...base,
    ...f.meta.opts,
    onEvent: (e: unknown) => {
      events.push(e);
      if (stopAfter !== undefined && !stopped && events.length >= stopAfter) {
        stopped = true;
        // After this tick, as a user's click would come: never from inside the event.
        setImmediate(() => handle?.stop());
      }
    },
  });
  await handle.done;
  return events;
}

/** v1's adapter for `id`, or null once v1 is gone. The bin env var must be set before the first call. */
export async function v1Adapter(id: string): Promise<RunLike | null> {
  const file = path.join(ROOT, 'server', 'adapters', `${id}.js`);
  try {
    await readFile(file);
  } catch {
    return null;
  }
  const mod = (await import(pathToFileURL(file).href)) as { default: RunLike };
  return mod.default;
}

export async function scratch(prefix: string): Promise<{ dir: string; done(): Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `wisp-g6-${prefix}-`));
  return { dir, done: () => rm(dir, { recursive: true, force: true }) };
}

export async function writeGolden(f: Fixture, events: readonly unknown[], cwds: readonly string[]): Promise<void> {
  await writeFile(f.file.replace(/\.jsonl$/, '.v1.json'), `${JSON.stringify(normalize(events, f.meta.drop, cwds), null, 1)}\n`);
}
