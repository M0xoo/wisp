// ARCHITECTURE.md rule 3: no cycles between packages (declared deps and real imports), and none between
// the files of a package (runtime imports; `import type` is erased, so it can't loop at load time).

import { finding } from '../core/report.ts';
import { isCode } from '../core/source.ts';
import type { Ctx, Finding, Rule } from '../core/types.ts';

const ID = 'cycles';

/** Tarjan's strongly connected components; each one with >1 node, or a self-loop, is a cycle. */
export function stronglyConnected(graph: ReadonlyMap<string, ReadonlySet<string>>): string[][] {
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const out: string[][] = [];
  const strong = (v: string): void => {
    idx.set(v, index);
    low.set(v, index);
    index++;
    stack.push(v);
    on.add(v);
    for (const w of graph.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v) ?? 0, low.get(w) ?? 0));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v) ?? 0, idx.get(w) ?? 0));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string | undefined;
      do {
        w = stack.pop();
        if (w === undefined) break;
        on.delete(w);
        comp.push(w);
      } while (w !== v);
      if (comp.length > 1 || graph.get(v)?.has(v)) out.push(comp.sort());
    }
  };
  for (const v of [...graph.keys()].sort()) if (!idx.has(v)) strong(v);
  return out;
}

/** A concrete loop through `start` inside one component: [start, …, start]. */
export function cyclePath(graph: ReadonlyMap<string, ReadonlySet<string>>, comp: readonly string[], start: string): string[] {
  const inComp = new Set(comp);
  const prev = new Map<string, string>();
  const queue = [start];
  while (queue.length) {
    const v = queue.shift() ?? start;
    for (const w of [...(graph.get(v) ?? [])].sort()) {
      if (!inComp.has(w)) continue;
      if (w === start) {
        const path = [start];
        for (let c: string | undefined = v; c !== undefined && c !== start; c = prev.get(c)) path.splice(1, 0, c);
        return [...path, start];
      }
      if (!prev.has(w)) {
        prev.set(w, v);
        queue.push(w);
      }
    }
  }
  return [start, start];
}

function edge(graph: Map<string, Set<string>>, a: string, b: string): void {
  let s = graph.get(a);
  if (!s) graph.set(a, (s = new Set()));
  s.add(b);
}

function packageCycles(ctx: Ctx): Finding[] {
  const graph = new Map<string, Set<string>>();
  const site = new Map<string, { file: string; line: number }>(); // "a→b" → first import
  for (const p of ctx.pkgs) {
    graph.set(p.name, new Set());
    for (const d of p.declared) {
      edge(graph, p.name, d);
      site.set(`${p.name}→${d}`, { file: `${p.dir}/package.json`, line: 1 });
    }
  }
  for (const file of ctx.files.filter(isCode)) {
    const own = ctx.pkgOf(file);
    if (!own) continue;
    for (const imp of ctx.imports(file)) {
      const r = ctx.resolve(file, imp.spec);
      if (r.kind !== 'workspace' || r.pkg === own) continue;
      edge(graph, own.name, r.pkg.name);
      const key = `${own.name}→${r.pkg.name}`;
      if (!site.has(key) || site.get(key)?.file.endsWith('package.json')) site.set(key, { file, line: imp.line });
    }
  }
  return stronglyConnected(graph).map((comp) => {
    const start = comp[0] ?? '';
    const path = cyclePath(graph, comp, start);
    const at = site.get(`${path[0] ?? ''}→${path[1] ?? ''}`) ?? { file: 'package.json', line: 1 };
    return finding(at.file, at.line, ID, `package cycle: ${path.join(' → ')}`);
  });
}

function fileCycles(ctx: Ctx): Finding[] {
  const out: Finding[] = [];
  const graphs = new Map<string, Map<string, Set<string>>>();
  const site = new Map<string, number>();
  for (const file of ctx.files.filter(isCode)) {
    const owner = ctx.pkgOf(file)?.name ?? '(tools)';
    let g = graphs.get(owner);
    if (!g) graphs.set(owner, (g = new Map()));
    if (!g.has(file)) g.set(file, new Set());
    for (const imp of ctx.imports(file)) {
      if (imp.typeOnly || imp.dynamic) continue; // erased, or lazy by design
      const r = ctx.resolve(file, imp.spec);
      if (r.kind !== 'relative' || !r.file || (ctx.pkgOf(r.file)?.name ?? '(tools)') !== owner) continue;
      edge(g, file, r.file);
      if (!site.has(`${file}→${r.file}`)) site.set(`${file}→${r.file}`, imp.line);
    }
  }
  for (const g of graphs.values()) {
    for (const comp of stronglyConnected(g)) {
      const start = comp[0] ?? '';
      const path = cyclePath(g, comp, start);
      const short = path.map((f) => f.split('/').slice(-2).join('/'));
      out.push(finding(start, site.get(`${start}→${path[1] ?? ''}`) ?? 1, ID, `file cycle: ${short.join(' → ')}`));
    }
  }
  return out;
}

export const cycles: Rule = {
  id: ID,
  description: 'no cycles between packages or between the files of a package',
  run: (ctx) => [...packageCycles(ctx), ...fileCycles(ctx)],
};
