// rust-mcp (ADR-0040): every command a plugin manifest lists is registered by its host, so the MCP tool list
// (generated from the catalogue) has it, unless it says "uiOnly": "<why>". Split from rust.ts (its size).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finding } from '../core/report.ts';
import { crates, rustFiles } from '../core/rust.ts';
import type { Finding, Rule } from '../core/types.ts';

/** Every command type an api crate defines, by id: `command!(Name = "id" …)`, `command!(Name, "id", …)` and
 *  `impl Command for Name { const ID: &'static str = "id"; … }`. */
export function commandTypes(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const code = text.replace(/^\s*\/\/.*$/gm, '');
  for (const m of code.matchAll(/command!\(\s*(?:#\[[^\]]*\]\s*)*(\w+)\s*(?:=|,)\s*"([^"]+)"/g)) out.set(m[1] ?? '', m[2] ?? '');
  for (const m of code.matchAll(/impl\s+(?:wisp_kernel::)?Command\s+for\s+(\w+)\s*\{[^}]*?const\s+ID\s*:\s*&'static\s+str\s*=\s*"([^"]+)"/g)) out.set(m[1] ?? '', m[2] ?? '');
  return out;
}

/** The command types a host registers: `.command::<T, …>`, the hosts' `on!(s, st, T, …)` and `on!(T, |…| …)` macros. */
export function registered(text: string): Set<string> {
  // `use …::{Run as RunCmd}`: the alias is the type
  const alias = new Map<string, string>();
  for (const m of text.matchAll(/\b(\w+)\s+as\s+(\w+)\b/g)) alias.set(m[2] ?? '', m[1] ?? '');
  const out = new Set<string>();
  const add = (t: string): void => void out.add(alias.get(t) ?? t);
  for (const m of text.matchAll(/\.command::<\s*(?:\w+::)*(\w+)\s*,/g)) add(m[1] ?? '');
  for (const m of text.matchAll(/\b\w+!\(\s*(?:\w+::)*([A-Z]\w*)\s*,\s*\|/g)) add(m[1] ?? '');
  for (const m of text.matchAll(/\b\w+!\(\s*\w+\s*,\s*[\w.&()]+\s*,\s*(?:\w+::)*([A-Z]\w*)\s*,/g)) add(m[1] ?? '');
  return out;
}

export const rustMcp: Rule = {
  id: 'rust-mcp',
  description: 'every command a manifest lists is registered by its host, so the MCP tool list (generated from the catalogue) has it, unless it says "uiOnly": "<why>" (ADR-0040)',
  run(ctx) {
    const out: Finding[] = [];
    const all = crates(ctx.root);
    // a type's id, per plugin: names like `List` or `Create` repeat across plugins
    const idsOf = (plugin: string | undefined): Map<string, string> => {
      const ids = new Map<string, string>();
      for (const c of all.filter((x) => x.plugin === plugin && (x.role === 'api' || x.role === 'host'))) {
        for (const f of rustFiles(ctx.root, `${c.dir}/src`)) for (const [t, id] of commandTypes(readFileSync(join(ctx.root, f), 'utf8'))) ids.set(t, id);
      }
      return ids;
    };
    for (const c of all.filter((x) => x.role === 'host')) {
      const ids = idsOf(c.plugin);
      const file = `${c.dir}/wisp-plugin.json`;
      if (!existsSync(join(ctx.root, file))) continue;
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(readFileSync(join(ctx.root, file), 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      const reg = new Set<string>();
      for (const f of rustFiles(ctx.root, `${c.dir}/src`)) for (const t of registered(readFileSync(join(ctx.root, f), 'utf8'))) reg.add(ids.get(t) ?? '');
      const cmds = (m['contributes'] as { commands?: unknown } | undefined)?.commands;
      for (const cmd of Array.isArray(cmds) ? (cmds as { id?: unknown; uiOnly?: unknown }[]) : []) {
        const id = typeof cmd?.id === 'string' ? cmd.id : '';
        if (!id) continue;
        if (cmd.uiOnly !== undefined) {
          if (typeof cmd.uiOnly !== 'string' || cmd.uiOnly.trim().length < 8) out.push(finding(file, 1, 'rust-mcp', `command ${id}: "uiOnly" says why it's only for a screen (a sentence), or it's an MCP tool like every command`));
          continue;
        }
        if (!reg.has(id)) out.push(finding(file, 1, 'rust-mcp', `command ${id} is listed but its host registers it nowhere: it isn't in the catalogue, so it's no MCP tool (register it, or mark it "uiOnly": "<why>")`));
      }
    }
    return out;
  },
};
