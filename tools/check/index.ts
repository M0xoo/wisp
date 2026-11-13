// `npm run check`: the structure rules of ARCHITECTURE.md over every workspace package and tools/.
// Prints `file:line rule message` per finding (warnings as `warn:<rule>`), then one summary line.
// Exits 1 on any error; warnings never fail.
//
//   node tools/check/index.ts                     every rule
//   node tools/check/index.ts --rule=layers,css   some rules
//   node tools/check/index.ts --json              findings as JSON (for scripts and CI annotations)
//   node tools/check/index.ts --quiet             errors only
//   node tools/check/index.ts --root=<dir>        another tree (the tests use fixture trees)

import { join, resolve } from 'node:path';
import { createCtx } from './core/ctx.ts';
import { finding, formatFinding, sortFindings } from './core/report.ts';
import type { Finding, Rule } from './core/types.ts';
import { RULES } from './rules/index.ts';

export interface CheckResult {
  findings: Finding[];
  errors: number;
  warnings: number;
  files: number;
  ms: number;
}

export async function runCheck(root: string, rules: readonly Rule[] = RULES): Promise<CheckResult> {
  const t0 = performance.now();
  const ctx = createCtx(root);
  const all: Finding[] = [];
  for (const rule of rules) {
    try {
      all.push(...(await rule.run(ctx)));
    } catch (e) {
      // a crashing rule is an error, never a silent pass
      all.push(finding('tools/check', 1, rule.id, `rule crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`));
    }
  }
  const findings = sortFindings(all);
  const errors = findings.filter((f) => f.severity === 'error').length;
  return { findings, errors, warnings: findings.length - errors, files: ctx.files.length, ms: performance.now() - t0 };
}

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const root = resolve(arg('root') ?? join(import.meta.dirname, '..', '..'));
  const only = arg('rule')?.split(',');
  const unknown = only?.filter((id) => !RULES.some((r) => r.id === id)) ?? [];
  if (unknown.length) {
    process.stderr.write(`unknown rule ${unknown.join(', ')}; rules: ${RULES.map((r) => r.id).join(', ')}\n`);
    process.exit(2);
  }
  const rules = only ? RULES.filter((r) => only.includes(r.id)) : RULES;
  const res = await runCheck(root, rules);
  const quiet = process.argv.includes('--quiet');
  const shown = quiet ? res.findings.filter((f) => f.severity === 'error') : res.findings;
  if (process.argv.includes('--json')) process.stdout.write(`${JSON.stringify({ ...res, findings: shown }, null, 2)}\n`);
  else {
    for (const f of shown) process.stdout.write(`${formatFinding(f)}\n`);
    // warnings by rule, so a migrating rule's count (rust-typed-commands) shows in the summary
    const byRule = new Map<string, number>();
    for (const f of res.findings) if (f.severity === 'warn') byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
    const warns = [...byRule].map(([r, n]) => `${r} ${n}`).join(', ');
    process.stdout.write(`check: ${res.errors} error${res.errors === 1 ? '' : 's'}, ${res.warnings} warning${res.warnings === 1 ? '' : 's'}${warns ? ` [${warns}]` : ''} (${rules.length} rules, ${res.files} files, ${Math.round(res.ms)} ms)\n`);
  }
  process.exitCode = res.errors ? 1 : 0;
}

if (import.meta.main) await main();
