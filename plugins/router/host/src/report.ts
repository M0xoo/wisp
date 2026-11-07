// Settings → Auto (v1 Router.report): every harness · model, the thinking levels it has a record at,
// each with its record overall and per kind, your picks of it, and the latest routes.

import { splitKey, TYPES } from '@wisp-plugin/router-api';
import type { AgentInfo, ArmReport, RouterReport } from '@wisp-plugin/router-api';
import { counts } from './estimate.ts';
import { baseOf, candidates, canon, effortLabel, PRIOR_INFO, round, ruleMatches, tierOf } from './keys.ts';
import type { Router } from './router.ts';
import { splitStat } from './state.ts';

/** Every key worth a row, and its label where a harness here names it. */
function keysOf(r: Router, agents: readonly AgentInfo[]): { rows: string[]; labels: Map<string, string> } {
  const armKeys = new Set(r.st.arms.keys());
  const levels = [...r.st.stats.keys()].map((sk) => splitStat(sk).key).filter((k) => splitKey(k).effort);
  const keys = new Set([...armKeys, ...candidates(agents, armKeys).map((c) => c.key), ...levels]);
  const names = new Map(candidates(agents, new Set([...keys].map(baseOf))).map((c) => [c.key, c.label]));
  const labels = new Map<string, string>();
  for (const k of keys) {
    const name = names.get(baseOf(k));
    const e = splitKey(k).effort;
    if (name) labels.set(k, `${name}${e ? ` · ${effortLabel(e)}` : ''}`);
  }
  // One row per run: claude: and claude:opus:medium are the same one.
  const rows = new Map<string, string>();
  for (const k of keys) {
    const c = canon(k);
    const have = rows.get(c);
    if (!have || (labels.has(k) && !labels.has(have)) || (labels.has(k) && k.length < have.length)) rows.set(c, k);
  }
  return { rows: [...rows.values()], labels };
}

function armRow(r: Router, k: string, label: string | undefined, rules: { blocked: string[]; prefer: string[] }): ArmReport {
  const now = r.now();
  const e = r.estimate('*', k);
  const byType: ArmReport['byType'] = {};
  for (const t of TYPES) {
    const c = counts(r.st, t, k, now);
    if (c.n) byType[t] = { n: c.n, chance: round(r.estimate(t, k).mean) };
  }
  const state = r.st.arms.get(baseOf(k))?.state ?? (label ? 'ready' : 'gone');
  const cool = r.cooling(k);
  const picks = r.picks('*', k).all;
  const shown = cool && state !== 'gone' ? 'cooling' : state === 'ready' && !e.prior && !e.inherited && !e.nAll && !picks ? 'untried' : state;
  const global = (list: string[]): boolean => list.some((x) => !x.includes('@') && ruleMatches(x, k));
  return {
    key: k, ...splitKey(k), canon: canon(k), label: label ?? k, tier: tierOf(k), ...(cool && { coolingUntil: cool.until, coolingWhy: cool.why }),
    state: shown, chance: round(e.mean), n: e.n, usd: round(e.usd), minutes: round(e.minutes, 1), prior: e.prior, inherited: e.inherited, from: e.from,
    picks, blocked: global(rules.blocked), preferred: global(rules.prefer), byType,
  };
}

type Recent = RouterReport['recent'][number];

export function report(r: Router, agents: readonly AgentInfo[]): RouterReport {
  const { rows, labels } = keysOf(r, agents);
  const p = r.prefs();
  const rules = { blocked: p.blocked ?? [], prefer: p.prefer ?? [] };
  const arms = rows
    .map((k) => armRow(r, k, labels.get(k), rules))
    .filter((a) => a.state !== 'gone' || a.n)
    .sort((x, y) => y.picks - x.picks || y.chance - x.chance);
  const routes = [...r.st.routes].map(([id, x]) => ({ ...x, id }));
  let picks = 0;
  for (const [k, x] of r.st.taste) if (k.startsWith('*|')) picks += x.n;
  const recent = routes
    .filter((x) => !x.manual)
    .sort((x, y) => y.at - x.at)
    .slice(0, 30)
    .map((x): Recent => ({
      id: x.id, key: x.key, type: x.type, r: x.r, at: x.at, signals: x.signals,
      ...(x.label !== undefined && { label: x.label }), ...(x.goal !== undefined && { goal: x.goal }), ...(x.chance !== undefined && { chance: x.chance }),
      ...(x.explored !== undefined && { explored: x.explored }), ...(x.trying !== undefined && { trying: x.trying }), ...(x.why !== undefined && { why: x.why }),
    }));
  return {
    priors: PRIOR_INFO,
    learned: routes.filter((x) => x.r !== null).length,
    routed: routes.filter((x) => !x.manual).length,
    picks: Math.round(picks),
    corrections: r.st.pairs.length,
    arms,
    recent,
  };
}
