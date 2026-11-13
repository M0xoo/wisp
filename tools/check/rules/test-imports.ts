// A UI test that checks plain code imports plain code (round 107/108: tests that compiled the whole kit took 4–5 s
// under load and timed out). A `*.test.ts` must not reach a `.tsx` through its runtime imports: not directly, not
// through a module that imports one, not through a package entry that pulls in components (the root of @wisp/ui or
// @wisp/shell). Import the plain module, or `@wisp/ui/pure` / `@wisp/shell/pure`. A test that renders a component is
// a `*.test.tsx`, or sits in RENDERS below with the reason.

import { finding } from '../core/report.ts';
import type { Ctx, Finding, Rule } from '../core/types.ts';

const ID = 'test-imports';

/** `*.test.ts` files that render a component (so compiling components is the point). */
export const RENDERS: ReadonlyMap<string, string> = new Map([
  ['packages/shell/test/task-keys.test.ts', 'mounts the shell builtins to drive the task keys'],
  ['plugins/antigravity/ui/test/harness.test.ts', 'renders the harness plugin (setup and setting rows)'],
  ['plugins/claude/ui/test/harness.test.ts', 'renders the harness plugin (setup and setting rows)'],
  ['plugins/codex/ui/test/harness.test.ts', 'renders the harness plugin (setup and setting rows)'],
  ['plugins/copilot/ui/test/harness.test.ts', 'renders the harness plugin (setup and setting rows)'],
  ['plugins/cursor/ui/test/harness.test.ts', 'renders the harness plugin (setup and setting rows)'],
  ['plugins/grok/ui/test/harness.test.ts', 'renders the harness plugin (setup and setting rows)'],
  ['plugins/opencode/ui/test/harness.test.ts', 'renders the harness plugin (setup and setting rows)'],
  ['plugins/ship/ui/test/unsent.test.ts', 'withUnsent runs on the shell context (useShell, usePluginClient from @wisp/shell)'],
]);

/** The file a workspace import lands on, from the package's `exports` (wildcards are not followed). */
function entryFile(ctx: Ctx, from: string, spec: string): string | undefined {
  const r = ctx.resolve(from, spec);
  if (r.kind === 'relative') return r.file;
  if (r.kind !== 'workspace') return undefined;
  const exp = r.pkg.manifest['exports'];
  const key = r.subpath === '' ? '.' : `./${r.subpath}`;
  const target = typeof exp === 'string' && key === '.' ? exp : exp && typeof exp === 'object' ? (exp as Record<string, unknown>)[key] : undefined;
  if (typeof target !== 'string') return undefined;
  const file = `${r.pkg.dir}/${target.replace(/^\.\//, '')}`;
  return ctx.exists(file) ? file : undefined;
}

/** The import chain from `start` to the first `.tsx` it reaches at runtime, or undefined. */
export function tsxChain(ctx: Ctx, start: string, memo: Map<string, readonly string[] | null>): readonly string[] | undefined {
  const walk = (file: string, seen: Set<string>): readonly string[] | null => {
    if (file.endsWith('.tsx')) return [file];
    const known = memo.get(file);
    if (known !== undefined) return known;
    if (seen.has(file)) return null; // a cycle: the other branch decides
    seen.add(file);
    let found: readonly string[] | null = null;
    for (const imp of ctx.imports(file)) {
      if (imp.typeOnly || imp.dynamic) continue;
      const next = entryFile(ctx, file, imp.spec);
      if (!next) continue;
      const sub = walk(next, seen);
      if (sub) {
        found = [file, ...sub];
        break;
      }
    }
    memo.set(file, found);
    return found;
  };
  return walk(start, new Set()) ?? undefined;
}

export const testImports: Rule = {
  id: ID,
  description: 'a UI *.test.ts reaches no .tsx (import plain modules or @wisp/ui/pure, @wisp/shell/pure); one that renders is allow-listed',
  run(ctx) {
    const out: Finding[] = [];
    const memo = new Map<string, readonly string[] | null>();
    for (const file of ctx.files) {
      if (!file.endsWith('.test.ts') || RENDERS.has(file) || !ctx.pkgOf(file)) continue;
      for (const imp of ctx.imports(file)) {
        if (imp.typeOnly || imp.dynamic) continue;
        const next = entryFile(ctx, file, imp.spec);
        const chain = next ? tsxChain(ctx, next, memo) : undefined;
        if (chain) out.push(finding(file, imp.line, ID, `${imp.spec} compiles components (${chain.join(' → ')}): import the plain module or a /pure entry, or allow-list a test that renders`));
      }
    }
    return out;
  },
};
