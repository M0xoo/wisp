// How often would Auto have picked what you picked yourself? Replays your own launches (from
// ~/.wisp/sessions, oldest first) through a router that starts empty: before each launch it asks
// for a preview, compares it with what you ran, then learns your pick, as wisp does.
//
//   node scripts/auto-replay.mjs                       this checkout's router
//   node scripts/auto-replay.mjs --router ../wisp/server/router.js   another checkout's (before/after)
//   options: --home <wisp home> (default ~/.wisp)  --goal cheap|balanced|best  --all (ignore the
//   harnesses Settings allows)  --json
//
// Read-only: your router.json is never touched (the replay learns in a scratch folder).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { canon } from '../server/router.js';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const home = arg('home', process.env.WISP_HOME || path.join(os.homedir(), '.wisp'));
const goal = arg('goal', 'balanced');
const routerPath = path.resolve(arg('router', new URL('../server/router.js', import.meta.url).pathname));
const { Router } = await import(pathToFileURL(routerPath).href);
const { adapters } = await import(pathToFileURL(path.join(path.dirname(routerPath), 'adapters/index.js')).href);

const sessions = fs
  .readdirSync(path.join(home, 'sessions'))
  .filter((f) => f.endsWith('.json'))
  .map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(home, 'sessions', f), 'utf8'));
    } catch {
      return null;
    }
  })
  .filter(Boolean)
  .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
const config = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
  } catch {
    return {};
  }
})();
const allowed = process.argv.includes('--all') ? null : config.defaults?.router?.allowed?.length ? config.defaults.router.allowed : null;

// The harnesses and models you had: every harness wisp knows with its listed models, plus every
// model you ever ran.
const seen = new Map();
for (const s of sessions) if (s.agent && adapters[s.agent]) (seen.get(s.agent) || seen.set(s.agent, new Set()).get(s.agent)).add(s.model || '');
const agents = [...seen.keys()].map((id) => {
  const a = adapters[id];
  const ids = new Set([...(a.models || []).map((m) => m.id), ...seen.get(id)]);
  return { id, name: a.name || id, available: true, efforts: a.efforts || [], delegates: a.delegates !== false, models: [...ids].map((m) => ({ id: m, label: (a.models || []).find((x) => x.id === m)?.label || m || 'Default' })) };
});

const mine = sessions.filter((s) => !s.route && !s.kind && s.agent && adapters[s.agent] && s.agent !== 'wisp' && !s.crew && !s.origin && !s.parentId && !s.delegated && s.turns?.[0]?.prompt);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-replay-'));
let t = 0;
const router = new Router(scratch, { now: () => t });
router.prefs = () => ({});
const tally = { n: 0, run: 0, model: 0, harness: 0 };
const byType = {};
const misses = new Map();
for (const s of mine) {
  t = s.createdAt || t;
  const prompt = s.turns[0].prompt;
  const attachments = (s.turns[0].attachments || []).length;
  const pick = router.choose({ prompt, attachments, agents, goal, allowed, preview: true, important: true, explore: false });
  if (!pick) continue;
  const ran = `${s.agent}:${s.model || ''}${s.effort ? `:${s.effort}` : ''}`;
  const sameRun = canon(pick.key) === canon(ran);
  const base = (k) => canon(k).split(':').slice(0, 2).join(':');
  const sameModel = base(pick.key) === base(ran);
  const sameHarness = pick.agent === s.agent;
  const type = pick.route?.type || 'feature';
  const b = (byType[type] ||= { n: 0, run: 0 });
  tally.n++;
  b.n++;
  if (sameRun) (tally.run++, b.run++);
  if (sameModel) tally.model++;
  if (sameHarness) tally.harness++;
  if (!sameRun) {
    const k = `${canon(ran)} → ${canon(pick.key)}`;
    misses.set(k, (misses.get(k) || 0) + 1);
  }
  router.observe?.({ agent: s.agent, model: s.model || '', effort: s.effort || '', prompt, attachments, at: t });
}
fs.rmSync(scratch, { recursive: true, force: true });

const pct = (x, n) => (n ? `${Math.round((x / n) * 100)}%` : '–');
const out = {
  router: routerPath,
  goal,
  allowed,
  launches: tally.n,
  sameRun: pct(tally.run, tally.n),
  sameModel: pct(tally.model, tally.n),
  sameHarness: pct(tally.harness, tally.n),
  byType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, `${pct(v.run, v.n)} of ${v.n}`])),
  misses: [...misses].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => `${n}× ${k}`),
};
if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
else {
  console.log(`Replayed ${out.launches} of your launches through ${path.relative(process.cwd(), routerPath)} (goal ${goal}${allowed ? `, allowed: ${allowed.join(', ')}` : ''})`);
  console.log(`  same run (harness · model · level): ${out.sameRun}`);
  console.log(`  same model, any level:              ${out.sameModel}`);
  console.log(`  same harness:                       ${out.sameHarness}`);
  console.log(`  by kind: ${Object.entries(out.byType).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  if (out.misses.length) console.log(`  where it differed (you → Auto):\n    ${out.misses.join('\n    ')}`);
}
