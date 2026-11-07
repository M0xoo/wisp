// Builds the read-only view of the tree that every rule shares: packages, files, parsed sources and
// import resolution, each computed once.

import { builtinModules } from 'node:module';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import type ts from 'typescript';
import { importsOf, parse } from './source.ts';
import { discover, listFiles } from './workspace.ts';
import type { Ctx, Import, Pkg, Resolved } from './types.ts';

const BUILTINS = new Set(builtinModules);
const EXTENSIONS = ['', '.ts', '.tsx', '.mts', '.js', '.json', '/index.ts', '/index.tsx'];

/** '@wisp/kernel/src/x' → ['@wisp/kernel', 'src/x']; 'solid-js/web' → ['solid-js', 'web'] */
export function splitSpec(spec: string): [string, string] {
  const parts = spec.split('/');
  const n = spec.startsWith('@') ? 2 : 1;
  return [parts.slice(0, n).join('/'), parts.slice(n).join('/')];
}

function resolver(root: string, fileSet: ReadonlySet<string>, pkgOf: (f: string) => Pkg | undefined, pkgByName: ReadonlyMap<string, Pkg>): (from: string, spec: string) => Resolved {
  const resolveFile = (target: string): string | undefined => {
    // `./x.js` written for a `.ts` file (rewriteRelativeImportExtensions) resolves to the .ts
    const bases = target.endsWith('.js') ? [target, `${target.slice(0, -3)}.ts`, `${target.slice(0, -3)}.tsx`] : [target];
    for (const base of bases) {
      for (const ext of EXTENSIONS) {
        const f = base + ext;
        if (fileSet.has(f)) return f;
        if (!f.startsWith('..') && ext === '' && existsSync(join(root, f)) && statSync(join(root, f)).isFile()) return f;
      }
    }
    return undefined;
  };
  return (from, spec) => {
    if (spec.startsWith('node:') || BUILTINS.has(spec.split('/')[0] ?? '')) return { kind: 'node', name: spec };
    if (spec.startsWith('.') || spec.startsWith('/')) {
      const target = posix.normalize(spec.startsWith('/') ? spec.slice(1) : posix.join(posix.dirname(from), spec));
      return { kind: 'relative', target, file: resolveFile(target), pkg: pkgOf(target) };
    }
    const [name, subpath] = splitSpec(spec);
    const pkg = pkgByName.get(name);
    return pkg ? { kind: 'workspace', pkg, subpath } : { kind: 'external', name };
  };
}

export function createCtx(root: string): Ctx {
  const pkgs = discover(root);
  const pkgByName = new Map(pkgs.map((p) => [p.name, p]));
  const files = listFiles(root, pkgs);
  const fileSet = new Set(files);
  // deepest package first, so plugins/x/host wins over a hypothetical plugins/x
  const byDepth = [...pkgs].sort((a, b) => b.dir.length - a.dir.length);
  const texts = new Map<string, string>();
  const sources = new Map<string, ts.SourceFile>();
  const imports = new Map<string, Import[]>();

  const pkgOf = (file: string): Pkg | undefined => byDepth.find((p) => file === p.dir || file.startsWith(`${p.dir}/`));
  const exists = (file: string): boolean => fileSet.has(file) || existsSync(join(root, file));
  const read = (file: string): string => {
    let t = texts.get(file);
    if (t === undefined) {
      t = readFileSync(join(root, file), 'utf8');
      texts.set(file, t);
    }
    return t;
  };
  const source = (file: string): ts.SourceFile => {
    let sf = sources.get(file);
    if (!sf) {
      sf = parse(file, read(file));
      sources.set(file, sf);
    }
    return sf;
  };
  const resolve = resolver(root, fileSet, pkgOf, pkgByName);

  return {
    root,
    pkgs,
    pkgByName,
    files,
    pkgOf,
    exists,
    read,
    source,
    imports(file) {
      let list = imports.get(file);
      if (!list) {
        list = importsOf(source(file));
        imports.set(file, list);
      }
      return list;
    },
    resolve,
  };
}
