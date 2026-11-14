// Scaffolds a plugin: plugins/<name>/{api,host,ui}, each a workspace package with package.json,
// tsconfig.json, src/ and test/, plus host/wisp-plugin.json and a README (ARCHITECTURE.md, the
// add-plugin skill). Never overwrites: an existing plugins/<name> is refused.
//
//   node tools/new-plugin.ts <name> [--tier builtin|exec] [--id <plugin id>] [--root <dir>]
//
// <name> is the folder and the command prefix (lowercase, digits, dashes: 'my-prs'); the plugin id
// defaults to wisp.<name>. 'builtin' runs in-process; 'exec' is a subprocess over JSON-RPC.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { names, scaffold } from './plugin-templates.ts';

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const PLUGIN_ID = /^[a-z][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;

export interface Options {
  name: string;
  tier: 'builtin' | 'exec';
  id: string | undefined;
  root: string;
}

/** Reads argv; a string is the usage error. */
export function parseArgs(argv: readonly string[], cwdRoot: string): Options | string {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq > 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
    else flags.set(a.slice(2), argv[++i] ?? '');
  }
  const [name] = positional;
  if (!name || positional.length > 1) return 'usage: node tools/new-plugin.ts <name> [--tier builtin|exec] [--id <plugin id>]';
  if (!NAME.test(name)) return `"${name}" is not a plugin name: lowercase letters, digits and dashes, like "my-prs"`;
  const tier = flags.get('tier') ?? 'builtin';
  if (tier !== 'builtin' && tier !== 'exec') return `--tier is builtin or exec, not "${tier}"`;
  const id = flags.get('id');
  if (id !== undefined && !PLUGIN_ID.test(id)) return `--id "${id}" is not a plugin id: dot-separated lowercase segments, like "acme.my-prs"`;
  const unknown = [...flags.keys()].filter((k) => !['tier', 'id', 'root'].includes(k));
  if (unknown.length) return `unknown flag --${unknown.join(', --')}`;
  return { name, tier, id, root: resolve(flags.get('root') ?? cwdRoot) };
}

/** Writes the scaffold; returns the files written (relative) or an error. */
export function create(o: Options): string[] | string {
  const dir = join(o.root, 'plugins', o.name);
  if (existsSync(dir)) return `plugins/${o.name} already exists: pick another name, or extend it by hand`;
  const files = scaffold(names(o.name, o.tier, o.id));
  for (const [rel, body] of files) {
    mkdirSync(dirname(join(o.root, rel)), { recursive: true });
    writeFileSync(join(o.root, rel), body);
  }
  return [...files.keys()];
}

if (import.meta.main) {
  const o = parseArgs(process.argv.slice(2), join(import.meta.dirname, '..'));
  const made = typeof o === 'string' ? o : create(o);
  if (typeof made === 'string') {
    process.stderr.write(`${made}\n`);
    process.exit(1);
  }
  if (typeof o !== 'string') {
    process.stdout.write(`${made.map((f) => `  + ${f}`).join('\n')}\n`);
    process.stdout.write(`plugins/${o.name}: ${made.length} files. Next:\n`);
    process.stdout.write(`  1. name ${o.name}.hello in packages/kernel/src/capabilities.ts (default deny: npm run check fails until then)\n`);
    process.stdout.write('  2. npm install --no-audit --no-fund   (links the three new workspaces)\n');
    process.stdout.write(`  3. .agents/bin/monoflow verify --affected && npm run check\n`);
  }
}
