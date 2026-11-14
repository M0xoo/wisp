// ARCHITECTURE.md rule 2: cross-package imports go through the package name and its `exports`, never
// a path into another package's files. Also: a workspace import must be declared in package.json,
// because monoflow builds its graph (and so the affected set CI trusts, gate G14) from package.json.

import { finding } from '../core/report.ts';
import { isCode } from '../core/source.ts';
import type { Finding, Pkg, Rule } from '../core/types.ts';

const ID = 'public-entry';

export function exported(pkg: Pkg, subpath: string): boolean {
  const want = subpath === '' ? '.' : `./${subpath}`;
  return pkg.exports.some((k) => {
    if (k === want) return true;
    const star = k.indexOf('*');
    return star >= 0 && want.startsWith(k.slice(0, star)) && want.endsWith(k.slice(star + 1));
  });
}

export const publicEntry: Rule = {
  id: ID,
  description: "imports enter another package through its name and exports; workspace imports are declared",
  run(ctx) {
    const out: Finding[] = [];
    for (const file of ctx.files.filter(isCode)) {
      const own = ctx.pkgOf(file);
      if (!own) continue; // tools/ is not a package
      for (const imp of ctx.imports(file)) {
        const r = ctx.resolve(file, imp.spec);
        if (r.kind === 'relative' && r.pkg !== own) {
          const into = r.pkg ? `import ${r.pkg.name} by name` : 'files outside a package are not importable';
          out.push(finding(file, imp.line, ID, `${imp.spec} escapes ${own.name}: ${into}`));
        }
        if (r.kind !== 'workspace' || r.pkg === own) continue;
        if (!exported(r.pkg, r.subpath)) out.push(finding(file, imp.line, ID, `${imp.spec} reaches into ${r.pkg.name}: import its entry (${r.pkg.exports.join(', ')})`));
        if (!own.declared.has(r.pkg.name)) out.push(finding(file, imp.line, ID, `${r.pkg.name} is imported but not declared in ${own.dir}/package.json (monoflow can't see the edge)`));
      }
    }
    return out;
  },
};
