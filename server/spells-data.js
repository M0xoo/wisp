// Spell data sources, fetched by wisp on a spell's behalf (spell code never fetches anything):
//   { wisp: '/sessions' }      a read-only GET of wisp's own API (an allowlist, see spell-schema.js)
//   { gh: ['pr', 'list', …] }  a read-only GitHub CLI command, in your home folder or the task's
// Each answer is cached for the source's `refresh` seconds and capped at MAX_BYTES.

import os from 'node:os';
import { gh } from './git.js';
import { fillTemplate, ghProblem, wispPathProblem } from '../web/js/spell-schema.js';
import { bad } from './util.js';

const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 20_000;

export function createSpellData(app) {
  const cache = new Map(); // key -> { at, value }

  async function fetchWisp(p) {
    const e = wispPathProblem(p);
    if (e) throw bad(e);
    const res = await fetch(`http://127.0.0.1:${app.port}/api${p.replace(/^\/api(?=\/)/, '')}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    if (text.length > MAX_BYTES) throw bad('That source returned more than 1 MB.');
    if (!res.ok) throw bad(`wisp ${p}: ${res.status}`);
    return JSON.parse(text);
  }

  async function fetchGh(args, cwd) {
    const e = ghProblem(args);
    if (e) throw bad(e);
    let out;
    try {
      out = await gh(cwd, args, { timeout: TIMEOUT_MS });
    } catch (err) {
      throw bad(`gh ${args.slice(0, 2).join(' ')}: ${String(err.message || err).split('\n')[0]}`);
    }
    if (out.length > MAX_BYTES) throw bad('That source returned more than 1 MB.');
    try {
      return JSON.parse(out);
    } catch {
      return out;
    }
  }

  // source: a normalized spell data source; session: the card's task, whose summary fills {field}
  // templates in gh arguments ({pr.number}) and whose folder gh runs in with cwd: 'task'.
  async function get(spellId, name, source, { session = null, summary = null, fresh = false } = {}) {
    const cwd = source.cwd === 'task' && session ? session.worktree?.cwd || session.cwd : os.homedir();
    const args = source.gh?.map((a) => fillTemplate(a, summary || {}));
    const perTask = session && (source.cwd === 'task' || source.gh?.some((a) => /\{/.test(a)) || /\{/.test(source.wisp || ''));
    const key = `${spellId}:${name}:${perTask ? session.id : ''}`;
    const hit = cache.get(key);
    if (!fresh && hit && Date.now() - hit.at < (source.refresh || 60) * 1000) return hit.value;
    const value = source.wisp !== undefined ? await fetchWisp(fillTemplate(source.wisp, summary || {})) : await fetchGh(args, cwd);
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return value;
  }

  return { get, clear: () => cache.clear() };
}
