// ui-commands: the UI never sends what no server handles, never waits on what no server writes, and no plugin UI
// sits unregistered (docs/v2-round-7.md: Settings had never opened; 59 commands had no server).
//
//   - every command id a UI package defines (`defineCommand({ id: '…' })` in packages/*/src, plugins/*/ui/src) is
//     listed by a plugin manifest (`contributes.commands`) and handled: the plugin's host or core (or a crate) names
//     the id, or the command's type from its api (`command!(Apps = "terminal.apps")` → `Apps`). Naming it in the api
//     alone is not a handler: `terminal.apps` was listed (ui-only) and declared, and nothing served it (round 15);
//   - every `plugin:<id>:<name>` topic a UI watches is named in some plugin's Rust (a writer publishes it);
//   - every plugins/*/ui is registered by apps/web: a default export from src/index.ts(x) (the glob in
//     apps/web/src/plugins.ts) or an import in apps/web/src.
//
// Errors, not warnings: a gap fails CI.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { finding } from '../core/report.ts';
import type { Finding, Rule } from '../core/types.ts';

const RULE = 'ui-commands';

function walk(dir: string, keep: (f: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'target' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, keep, out);
    else if (keep(p)) out.push(p);
  }
  return out;
}

const dirs = (d: string): string[] => (existsSync(d) ? readdirSync(d).filter((n) => statSync(join(d, n)).isDirectory()) : []);

/** `defineCommand(… id: 'x' …)`: each id with its line. */
export function commandsIn(text: string): { id: string; line: number }[] {
  const out: { id: string; line: number }[] = [];
  for (const m of text.matchAll(/defineCommand\b/g)) {
    const at = (m.index ?? 0) + m[0].length;
    const id = /id:\s*'([^']+)'/.exec(text.slice(at, at + 400));
    if (id?.[1]) out.push({ id: id[1], line: text.slice(0, at).split('\n').length });
  }
  return out;
}

/** The command types an api crate declares, id → type: `Apps = "terminal.apps"`, `SetPublished, "stuff.setPublished"`, or
 * `impl Command for View { const ID = "ship.view" }`. */
export function commandTypes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(/(?:^|[(\s])([A-Z]\w*)\s*[=,]\s*"([a-z][\w-]*\.[\w.-]+)"/gm)) if (m[1] && m[2] && !out.has(m[2])) out.set(m[2], m[1]);
  // `impl Command for View { const ID: &'static str = "ship.view"; … }`
  for (const m of text.matchAll(/impl\s+(?:[\w:]+::)?Command\s+for\s+(\w+)\s*\{[^}]*?const\s+ID\s*:[^=]*=\s*"([^"]+)"/g)) if (m[1] && m[2]) out.set(m[2], m[1]);
  return out;
}

/** Does the handling side (host/core/crates text) serve `id`: its id string, or its api type as a word. */
export function handles(served: string, id: string, type: string | undefined): boolean {
  return served.includes(`"${id}"`) || (type !== undefined && new RegExp(`\\b${type}\\b`).test(served));
}

/** `'plugin:<id>:<name>'` topics a UI file names, with their lines. */
export function topicsIn(text: string): { topic: string; line: number }[] {
  return [...text.matchAll(/'(plugin:[\w.-]+:[\w.-]+)'/g)].map((m) => ({ topic: m[1] ?? '', line: text.slice(0, m.index ?? 0).split('\n').length }));
}

export const uiCommands: Rule = {
  id: RULE,
  description: 'every command a UI sends is listed and registered by a plugin, every topic it watches has a writer, every plugin UI is registered',
  run(ctx) {
    const root = ctx.root;
    const rel = (p: string): string => relative(root, p).split('\\').join('/');
    const out: Finding[] = [];
    // the server side: listed ids per plugin folder, and every plugin's Rust text
    const listed = new Map<string, string>(); // command id → plugin folder
    const rust = new Map<string, string>(); // plugin folder → its api+host+core Rust
    const served = new Map<string, string>(); // plugin folder → its host+core Rust (where handlers live)
    const types = new Map<string, string>(); // command id → its api type
    for (const p of dirs(join(root, 'plugins'))) {
      const m = join(root, 'plugins', p, 'host', 'wisp-plugin.json');
      if (existsSync(m)) {
        try {
          const j = JSON.parse(readFileSync(m, 'utf8')) as { contributes?: { commands?: { id?: string }[] } };
          for (const c of j.contributes?.commands ?? []) if (c.id) listed.set(c.id, p);
        } catch {
          // a broken manifest is rust-manifests' finding
        }
      }
      const read = (k: string): string => walk(join(root, 'plugins', p, k, 'src'), (f) => f.endsWith('.rs')).map((f) => readFileSync(f, 'utf8')).join('\n');
      const api = read('api');
      for (const [id, type] of commandTypes(api)) types.set(id, type);
      served.set(p, `${read('host')}\n${read('core')}`);
      rust.set(p, `${api}\n${served.get(p) ?? ''}`);
    }
    const crates = walk(join(root, 'crates'), (f) => f.endsWith('.rs')).map((f) => readFileSync(f, 'utf8')).join('\n');
    const allRust = [...rust.values()].join('\n') + crates;
    // the UI side
    const uiRoots = [...dirs(join(root, 'packages')).map((d) => join(root, 'packages', d, 'src')), ...dirs(join(root, 'plugins')).map((d) => join(root, 'plugins', d, 'ui', 'src'))];
    for (const file of uiRoots.flatMap((d) => walk(d, (f) => /\.tsx?$/.test(f)))) {
      const text = readFileSync(file, 'utf8');
      for (const { id, line } of commandsIn(text)) {
        const owner = listed.get(id);
        if (!owner) out.push(finding(rel(file), line, RULE, `the UI sends ${id}, which no plugin manifest lists: rename it to the server's id or add the command`));
        else if (!(rust.get(owner) ?? '').includes(`"${id}"`)) out.push(finding(rel(file), line, RULE, `the UI sends ${id}: plugins/${owner} lists it but its Rust never names it (no handler)`));
        else if (!handles(`${served.get(owner) ?? ''}\n${crates}`, id, types.get(id))) out.push(finding(rel(file), line, RULE, `the UI sends ${id}: plugins/${owner} declares it but nothing registers a handler (its host never names ${types.get(id) ?? id})`));
      }
      for (const { topic, line } of topicsIn(text)) {
        if (!allRust.includes(`"${topic}"`)) out.push(finding(rel(file), line, RULE, `the UI watches ${topic}, which no server writes`));
      }
    }
    // every plugin UI is registered by apps/web
    const web = walk(join(root, 'apps', 'web', 'src'), (f) => /\.tsx?$/.test(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
    for (const p of dirs(join(root, 'plugins'))) {
      const ui = join(root, 'plugins', p, 'ui');
      if (!existsSync(join(ui, 'package.json'))) continue;
      const index = ['index.ts', 'index.tsx'].map((n) => join(ui, 'src', n)).find((f) => existsSync(f));
      const pkg = (JSON.parse(readFileSync(join(ui, 'package.json'), 'utf8')) as { name?: string }).name ?? '';
      const byDefault = index !== undefined && /export default\b/.test(readFileSync(index, 'utf8'));
      const imported = pkg !== '' && web.includes(`'${pkg}'`);
      if (!byDefault && !imported) out.push(finding(rel(join(ui, 'package.json')), 1, RULE, `${pkg || `plugins/${p}/ui`} is registered nowhere: give src/index.ts a default definePluginUi(…), or register it in apps/web`));
    }
    return out;
  },
};
