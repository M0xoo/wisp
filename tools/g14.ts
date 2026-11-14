// Gate G14 (plan §9.4.5): before PR CI runs only monoflow's affected set, replay merged PRs and check
// that the affected set held every package whose tests failed in that PR's full run (zero misses), and
// that it would have cut tier-1 time by at least half.
//
//   node tools/g14.ts affected [--base=origin/main] [--out=affected.json]
//       The affected set of the current branch: every file changed since the merge-base (and any
//       uncommitted or new file, so it works before a commit too), through
//       `monoflow graph impact` (owner + transitive dependents). Works with any monoflow version (the
//       pinned 8c6bc74 ignores `verify --base`). Files no package owns are listed as unmapped:
//       monoflow counts them as nothing affected (§9.4.4 item 3), and G14 must see that.
//   node tools/g14.ts replay [--last=200] [--repo=WispAgents/wisp] [--json]
//       For the last N merged PRs, downloads the artifacts pr.yml uploaded (g14-affected: the affected
//       set; verify-all-*: the full run) and scores them. PRs whose runs predate v2 CI have no artifacts
//       and are counted as "no data". Needs `gh` signed in.
//
// The pass rule: ≥ 200 PRs with data, 0 misses, median time saved ≥ 50%. One miss and PR CI stays on
// the full suite until monoflow is fixed (fixed, not retried).

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJsonFile, readVerify, type VerifyReport } from './monoflow-report.ts';
import { monoflowBin } from './test.ts';

const ROOT = join(import.meta.dirname, '..');
export const GATE = { prs: 200, misses: 0, saved: 0.5 };

export interface Impact {
  owner: string;
  dependents: string[];
}
export interface Affected {
  base: string;
  changed_files: string[];
  affected_packages: string[];
  unmapped_files: string[];
}

function run(cmd: string, args: readonly string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', maxBuffer: 64 << 20 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() || (r.stderr ?? '').trim() };
}

/** `graph impact` in either version's shape; undefined when no package owns the file. */
export function parseImpact(raw: unknown): Impact | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const j = raw as Record<string, unknown>;
  const owner = j['owning_package'] ?? j['package'];
  if (typeof owner !== 'string' || !owner) return undefined;
  const list = j['transitive_dependents'] ?? j['dependent_packages'] ?? j['direct_dependents'];
  return { owner, dependents: Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [] };
}

/** Union of owners and dependents; one impact query per directory (files of a folder share an owner). */
export function affectedSet(changed: readonly string[], impact: (file: string) => Impact | undefined): Pick<Affected, 'affected_packages' | 'unmapped_files'> {
  const byDir = new Map<string, Impact | undefined>();
  const affected = new Set<string>();
  const unmapped: string[] = [];
  for (const f of changed) {
    const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '.';
    if (!byDir.has(dir)) byDir.set(dir, impact(f));
    const hit = byDir.get(dir);
    if (!hit) unmapped.push(f);
    else for (const p of [hit.owner, ...hit.dependents]) affected.add(p);
  }
  return { affected_packages: [...affected].sort(), unmapped_files: unmapped.sort() };
}

function affectedNow(base: string): Affected {
  const bin = monoflowBin(ROOT);
  if (!bin) throw new Error('monoflow is not installed: node tools/setup-monoflow.ts');
  const mb = run('git', ['merge-base', base, 'HEAD']);
  if (!mb.ok) throw new Error(`no merge-base with ${base} (fetch it, or checkout with fetch-depth: 0): ${mb.out}`);
  // committed, staged and unstaged changes since the merge-base, plus new files: in CI only the first
  const diff = run('git', ['diff', '--name-only', mb.out]);
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard']);
  const changed = [...new Set([diff.out, untracked.out].flatMap((o) => (o ? o.split('\n') : [])))].sort();
  const impact = (file: string): Impact | undefined => {
    const r = run(bin, ['graph', 'impact', file, '--json']);
    try {
      return r.ok ? parseImpact(JSON.parse(r.out)) : undefined;
    } catch {
      return undefined;
    }
  };
  return { base, changed_files: changed, ...affectedSet(changed, impact) };
}

export interface PrData {
  number: number;
  affected: string[];
  unmapped: number;
  full: VerifyReport | undefined;
}
export interface PrScore {
  number: number;
  misses: string[];
  saved: number | undefined; // fraction of the full run's time the affected set would not have run
}

export function scorePr(pr: PrData): PrScore | undefined {
  if (!pr.full) return undefined;
  const inSet = new Set(pr.affected);
  const misses = pr.full.failed.filter((p) => !inSet.has(p));
  const total = Object.values(pr.full.durations).reduce((a, b) => a + b, 0);
  const kept = pr.affected.reduce((a, p) => a + (pr.full?.durations[p] ?? 0), 0);
  return { number: pr.number, misses, saved: total > 0 ? 1 - kept / total : undefined };
}

export function verdict(scores: readonly PrScore[]): { pass: boolean; prs: number; misses: number; medianSaved: number | undefined; reasons: string[] } {
  const misses = scores.reduce((a, s) => a + s.misses.length, 0);
  const saved = scores.flatMap((s) => (s.saved === undefined ? [] : [s.saved])).sort((a, b) => a - b);
  const medianSaved = saved.length ? saved[Math.floor(saved.length / 2)] : undefined;
  const reasons: string[] = [];
  if (scores.length < GATE.prs) reasons.push(`${scores.length} PRs with data, the gate needs ${GATE.prs}`);
  if (misses > GATE.misses) reasons.push(`${misses} missed package failures (${scores.filter((s) => s.misses.length).map((s) => `#${s.number}`).join(', ')})`);
  if (medianSaved === undefined || medianSaved < GATE.saved) reasons.push(`median time saved ${medianSaved === undefined ? 'unknown' : `${Math.round(medianSaved * 100)}%`}, the gate needs ${GATE.saved * 100}%`);
  return { pass: reasons.length === 0, prs: scores.length, misses, medianSaved, reasons };
}

function prData(repo: string, pr: { number: number; headRefOid: string }): PrData {
  const runs = run('gh', ['run', 'list', '--repo', repo, '--workflow', 'pr.yml', '--commit', pr.headRefOid, '--json', 'databaseId', '--limit', '5']);
  const ids = runs.ok ? (JSON.parse(runs.out || '[]') as { databaseId: number }[]).map((r) => r.databaseId) : [];
  const out: PrData = { number: pr.number, affected: [], unmapped: 0, full: undefined };
  for (const id of ids) {
    const dir = mkdtempSync(join(tmpdir(), 'g14-'));
    try {
      if (!run('gh', ['run', 'download', String(id), '--repo', repo, '--dir', dir]).ok) continue;
      for (const art of readdirSync(dir)) {
        const files = readdirSync(join(dir, art));
        if (art === 'g14-affected' && files.includes('affected.json')) {
          const a = readJsonFile(join(dir, art, 'affected.json')) as Partial<Affected>;
          out.affected = a.affected_packages ?? [];
          out.unmapped = a.unmapped_files?.length ?? 0;
        }
        if (art.startsWith('verify-all') && files.includes('verify-all.json')) {
          const r = readVerify(readJsonFile(join(dir, art, 'verify-all.json')));
          out.full = out.full ? { ...r, failed: [...new Set([...out.full.failed, ...r.failed])].sort() } : r;
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (out.full) break;
  }
  return out;
}

function replay(last: number, repo: string, json: boolean): boolean {
  const list = run('gh', ['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', String(last), '--json', 'number,headRefOid']);
  if (!list.ok) throw new Error(`gh pr list failed: ${list.out}`);
  const prs = JSON.parse(list.out) as { number: number; headRefOid: string }[];
  const data = prs.map((p) => prData(repo, p));
  const scores = data.flatMap((d) => scorePr(d) ?? []);
  const v = verdict(scores);
  if (json) process.stdout.write(`${JSON.stringify({ verdict: v, prs: data.map((d) => ({ ...d, score: scorePr(d) })) }, null, 2)}\n`);
  else {
    for (const d of data) {
      const s = scorePr(d);
      process.stdout.write(s ? `#${d.number} affected ${d.affected.length} failed ${d.full?.failed.length ?? 0} misses ${s.misses.join(',') || 0} saved ${s.saved === undefined ? '?' : `${Math.round(s.saved * 100)}%`}\n` : `#${d.number} no data\n`);
    }
    process.stdout.write(`G14 ${v.pass ? 'PASS' : 'FAIL'}: ${v.prs}/${prs.length} PRs with data, ${v.misses} misses${v.reasons.length ? `; ${v.reasons.join('; ')}` : ''}\n`);
  }
  return v.pass;
}

if (import.meta.main) {
  const [cmd] = process.argv.slice(2);
  const flag = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  try {
    if (cmd === 'affected') {
      const a = affectedNow(flag('base') ?? 'origin/main');
      const text = `${JSON.stringify(a, null, 2)}\n`;
      const out = flag('out');
      if (out) writeFileSync(out, text);
      else process.stdout.write(text);
    } else if (cmd === 'replay') {
      process.exitCode = replay(Number(flag('last') ?? GATE.prs), flag('repo') ?? 'WispAgents/wisp', process.argv.includes('--json')) ? 0 : 1;
    } else {
      process.stderr.write('usage: node tools/g14.ts affected [--base=origin/main] [--out=f] | replay [--last=200] [--repo=o/r] [--json]\n');
      process.exitCode = 2;
    }
  } catch (e) {
    process.stderr.write(`g14: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  }
}
