// Reads a `monoflow verify --json` result (any monoflow version: 8c6bc74 lists `results`, later ones
// `failed` and `errors`) and prints it compactly; in GitHub Actions it also appends a markdown table to
// the job summary. Used by the CI workflows and by tools/g14.ts.
//
//   node tools/monoflow-report.ts <verify.json> [--title=<heading>] [--affected=<affected.json>]

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface VerifyReport {
  status: string;
  durationMs: number;
  affected: string[];
  failed: string[];
  /** per-package seconds, when the version reports them */
  durations: Record<string, number>;
  total: number;
  /** what the failures said, `package: message`, for the log */
  details: string[];
}

const DETAIL_KEYS = ['message', 'error', 'output', 'stderr'];
const clip = (s: string): string => (s.length > 4000 ? `${s.slice(0, 4000)}…` : s);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Lines that name what failed: a Rust panic or FAILED test, a node:test/vitest failure, an error line. */
const FAILURE_LINE = /panicked at|^test .* FAILED$|^---- .* ----$|^failures:|^not ok |✖|FAIL |^error(\[|:)/;

/**
 * A command that failed with no file:line diagnostics comes back as `execution_failure`, and monoflow keeps very
 * little of its output: the last 1500 characters, then the first 400 of those (2a86d14, CompactFailure and
 * DedupeErrors), so a `cargo test` that stops at its failing binary shows the binaries before it, not the test.
 * Neither the JSON nor any log keeps the rest; say so, name any failure lines that survived, and give the command
 * that shows the whole output (monoflow's own `cargo test -p <crate>` for a crate, with every binary run).
 */
export function clippedHint(message: string, targets: string[], dir: string, isCrate = (d: string): boolean => existsSync(join(d, 'Cargo.toml'))): string {
  const named = message.split('\n').map((l) => l.trim()).filter((l) => FAILURE_LINE.test(l));
  const rerun = isCrate(dir) ? targets.map((t) => `cargo test -p ${t} --no-fail-fast`).join('; ') : `the test script in ${dir}`;
  return [
    named.length ? `failing: ${named.join(' | ')}` : 'monoflow cut the failing test out of its message (it keeps ~400 characters near the end of the output)',
    `to see it: ${rerun}`,
  ].join('; ');
}

export function readVerify(raw: unknown): VerifyReport {
  const j = isObj(raw) ? raw : {};
  const failed = new Set<string>();
  const durations: Record<string, number> = {};
  const details: string[] = [];
  const detail = (who: string, r: Record<string, unknown>): void => {
    const text = DETAIL_KEYS.map((k) => r[k]).find((v): v is string => typeof v === 'string' && v.length > 0);
    if (text) details.push(`${who}: ${clip(text)}`);
  };
  for (const r of Array.isArray(j['results']) ? j['results'] : []) {
    if (!isObj(r) || typeof r['target'] !== 'string') continue;
    durations[r['target']] = num(r['duration_ms']) / 1000;
    if (r['status'] === 'failed' || r['status'] === 'error') {
      failed.add(r['target']);
      detail(r['target'], r);
    }
  }
  if (isObj(j['failed'])) for (const k of Object.keys(j['failed'])) failed.add(k);
  for (const e of Array.isArray(j['errors']) ? j['errors'] : []) {
    if (!isObj(e)) continue;
    const targets = strings(e['targets']);
    for (const t of targets) failed.add(t);
    const who = typeof e['file'] === 'string' ? e['file'] : targets.join(', ');
    detail(who, e);
    if (e['code'] === 'execution_failure') details.push(`${who}: ${clippedHint(typeof e['message'] === 'string' ? e['message'] : '', targets, who)}`);
  }
  return {
    status: typeof j['status'] === 'string' ? j['status'] : 'unknown',
    durationMs: num(j['duration_ms']),
    affected: strings(j['affected_packages']).sort(),
    failed: [...failed].sort(),
    durations,
    total: num(j['total_targets']),
    details,
  };
}

export function readJsonFile(path: string): unknown {
  const text = readFileSync(path, 'utf8').trim();
  // monoflow may print a line of text before its JSON
  const start = text.indexOf('{');
  return JSON.parse(start > 0 ? text.slice(start) : text);
}

export function markdown(title: string, r: VerifyReport, affected?: { affected_packages?: string[]; unmapped_files?: string[] }): string {
  const lines = [`### ${title}`, '', `**${r.status}** · ${r.total} targets · ${(r.durationMs / 1000).toFixed(1)} s`, ''];
  if (r.failed.length) lines.push(`Failed: ${r.failed.map((f) => `\`${f}\``).join(', ')}`, '');
  // what each failure said, so the job summary shows it without opening the log
  if (r.details.length) lines.push('<details><summary>What failed</summary>', '', '```', ...r.details, '```', '', '</details>', '');
  if (affected) {
    const a = affected.affected_packages ?? [];
    lines.push(`Affected set (report-only, gate G14): ${a.length ? a.map((p) => `\`${p}\``).join(', ') : '_none_'}`, '');
    const u = affected.unmapped_files ?? [];
    if (u.length) lines.push(`<details><summary>${u.length} changed files outside every package</summary>`, '', ...u.map((f) => `- \`${f}\``), '', '</details>', '');
  }
  return `${lines.join('\n')}\n`;
}

if (import.meta.main) {
  const [file] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const flag = (n: string): string | undefined => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  if (!file || !existsSync(file)) {
    process.stderr.write('usage: node tools/monoflow-report.ts <verify.json> [--title=…] [--affected=affected.json]\n');
    process.exit(2);
  }
  let raw: unknown;
  try {
    raw = readJsonFile(file);
  } catch (e) {
    // the verify step's exit code already failed the job; say why the report is empty
    process.stdout.write(`monoflow: ${file} is not JSON (${e instanceof Error ? e.message : String(e)})\n`);
    process.exit(0);
  }
  const r = readVerify(raw);
  const affFile = flag('affected');
  let aff: unknown;
  try {
    aff = affFile && existsSync(affFile) ? readJsonFile(affFile) : undefined;
  } catch {
    aff = undefined; // an affected step that failed leaves nothing to show
  }
  const affected = isObj(aff) ? { affected_packages: strings(aff['affected_packages']), unmapped_files: strings(aff['unmapped_files']) } : undefined;
  process.stdout.write(`monoflow: ${r.status}, ${r.total} targets, ${(r.durationMs / 1000).toFixed(1)} s${r.failed.length ? `, failed: ${r.failed.join(', ')}` : ''}\n`);
  for (const d of r.details) process.stdout.write(`  ${d.replace(/\n/g, '\n    ')}\n`);
  if (affected) process.stdout.write(`affected: ${affected.affected_packages.join(', ') || 'none'}${affected.unmapped_files.length ? ` (+${affected.unmapped_files.length} files outside every package)` : ''}\n`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary) appendFileSync(summary, markdown(flag('title') ?? 'monoflow verify', r, affected));
}
