// A spell's data sources, fetched by wisp on its behalf (spell code never fetches anything), as v1
// server/spells-data.js did:
//   { wisp: '/sessions' }      a read-only GET of wisp's own API (an allowlist, schema.ts)
//   { gh: ['pr', 'list', …] }  a read-only GitHub CLI command, in the home folder or the task's
// Each answer is cached for the source's `refresh` seconds and capped at MAX_BYTES.

import { bad, messageOf } from './errors.ts';
import { fillTemplate, ghProblem, wispPathProblem } from './schema.ts';
import type { DataSource } from './types.ts';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 20_000;
const CACHE_MAX = 500;

export interface DataDeps {
  now(): number;
  homedir: string;
  /** a GET of wisp's own API, as the plugin manager (read-only routes only reach here) */
  wispGet(path: string): Promise<{ status: number; text: string }>;
  gh(args: readonly string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

/** The task a card shows: its folder (or worktree) and its summary, whose fields fill {templates}. */
export interface DataTask {
  id: string;
  cwd: string;
  summary: Record<string, unknown>;
}

export interface DataSources {
  get(spellId: string, name: string, source: Partial<DataSource> & { wisp?: string; gh?: string[]; refresh?: number; cwd?: string }, o?: { task?: DataTask | null; fresh?: boolean }): Promise<unknown>;
  clear(): void;
}

export function createDataSources(d: DataDeps): DataSources {
  const cache = new Map<string, { at: number; value: unknown }>();

  async function fetchWisp(p: string): Promise<unknown> {
    const e = wispPathProblem(p);
    if (e) throw bad(e);
    const res = await d.wispGet(p.replace(/^\/api(?=\/)/, ''));
    if (res.text.length > MAX_BYTES) throw bad('That source returned more than 1 MB.');
    if (res.status >= 400) throw bad(`wisp ${p}: ${res.status}`);
    return JSON.parse(res.text) as unknown;
  }

  async function fetchGh(args: readonly string[], cwd: string): Promise<unknown> {
    const e = ghProblem(args);
    if (e) throw bad(e);
    let out: string;
    try {
      const r = await d.gh(args, cwd, TIMEOUT_MS);
      if (r.code !== 0) throw new Error(r.stderr || `exit ${r.code}`);
      out = r.stdout;
    } catch (err) {
      throw bad(`gh ${args.slice(0, 2).join(' ')}: ${messageOf(err).split('\n')[0]}`);
    }
    if (out.length > MAX_BYTES) throw bad('That source returned more than 1 MB.');
    try {
      return JSON.parse(out) as unknown;
    } catch {
      return out;
    }
  }

  return {
    async get(spellId, name, source, o = {}) {
      const task = o.task ?? null;
      const summary = task?.summary ?? {};
      const cwd = source.cwd === 'task' && task ? task.cwd : d.homedir;
      const args = source.gh?.map((a) => fillTemplate(a, summary));
      const perTask = !!task && (source.cwd === 'task' || !!source.gh?.some((a) => /\{/.test(a)) || /\{/.test(source.wisp ?? ''));
      const key = `${spellId}:${name}:${perTask && task ? task.id : ''}`;
      const hit = cache.get(key);
      if (!o.fresh && hit && d.now() - hit.at < (source.refresh || 60) * 1000) return hit.value;
      const value = source.wisp !== undefined ? await fetchWisp(fillTemplate(source.wisp, summary)) : await fetchGh(args ?? [], cwd);
      cache.set(key, { at: d.now(), value });
      if (cache.size > CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return value;
    },
    clear: () => cache.clear(),
  };
}
