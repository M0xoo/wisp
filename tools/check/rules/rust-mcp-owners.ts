// rust-mcp-owners (ADR-0040): every command wisp.mcp's built-in tools run is registered by some Rust host. A tool
// whose owner command no host registers is offered to every agent and fails on every call ("unknown command"):
// wisp_crew_add and wisp_crew_kit shipped that way. Checked: each id in plugins/mcp/api/src/owners.rs, each typed
// command wisp-mcp-host runs (`typed::<rt::Get>`, `ctx.run::<wisp_x_api::T>`, `run::<c::T>`), and no owner id built
// at run time (`format!` in an `owner(…)`/`run_json(…)` call: the check can't see it, and that's how
// `wisp mcp`'s crew tools reached `crew.crew` and `crew.edit`).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finding } from '../core/report.ts';
import { crates, rustFiles } from '../core/rust.ts';
import type { Finding, Rule } from '../core/types.ts';
import { commandTypes, registered } from './rust-mcp.ts';

const OWNERS = 'plugins/mcp/api/src/owners.rs';
const HOST = 'plugins/mcp/host/src';

/** Every command id a Rust host registers, and each plugin's command types by name (its api and host crates). */
export function registrations(root: string): { ids: Set<string>; types: Map<string, Map<string, string>> } {
  const all = crates(root);
  const types = new Map<string, Map<string, string>>();
  for (const c of all.filter((x) => x.plugin && (x.role === 'api' || x.role === 'host'))) {
    const m = types.get(c.plugin ?? '') ?? new Map<string, string>();
    for (const f of rustFiles(root, `${c.dir}/src`)) for (const [t, id] of commandTypes(readFileSync(join(root, f), 'utf8'))) m.set(t, id);
    types.set(c.plugin ?? '', m);
  }
  const ids = new Set<string>();
  for (const h of all.filter((x) => x.role === 'host')) {
    const own = types.get(h.plugin ?? '') ?? new Map<string, string>();
    for (const f of rustFiles(root, `${h.dir}/src`)) {
      for (const t of registered(readFileSync(join(root, f), 'utf8'))) {
        const id = own.get(t);
        if (id) ids.add(id);
      }
    }
  }
  return { ids, types };
}

/** `wisp_grid_client_api` → `grid-client`. */
const pluginOf = (krate: string): string | undefined => /^wisp_(\w+)_api$/.exec(krate)?.[1]?.replace(/_/g, '-');

export const rustMcpOwners: Rule = {
  id: 'rust-mcp-owners',
  description: "every command wisp.mcp's tools run (owners.rs, the typed commands its host runs) is registered by a Rust host, so no tool fails for every agent (ADR-0040)",
  run(ctx) {
    if (!existsSync(join(ctx.root, OWNERS))) return [];
    const out: Finding[] = [];
    const { ids, types } = registrations(ctx.root);
    readFileSync(join(ctx.root, OWNERS), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        const m = /^\s*pub const (\w+): &str = "([^"]+)"/.exec(line);
        if (m && !ids.has(m[2] ?? '')) out.push(finding(OWNERS, i + 1, 'rust-mcp-owners', `owners::${m[1]} = "${m[2]}": no host registers it, so its MCP tool fails for every agent (register it in its plugin's host and manifest, or remove the tool)`));
      });
    for (const f of rustFiles(ctx.root, HOST)) {
      const text = readFileSync(join(ctx.root, f), 'utf8');
      // `use wisp_runtime_api::commands as rt;` → rt is runtime's
      const alias = new Map<string, string>();
      for (const m of text.matchAll(/use\s+(wisp_\w+_api)(?:::\w+)*\s+as\s+(\w+)\s*;/g)) alias.set(m[2] ?? '', m[1] ?? '');
      text.split('\n').forEach((line, i) => {
        if (/\b(?:owner|run_json)\s*\([^;]*format!\s*\(/.test(line)) out.push(finding(f, i + 1, 'rust-mcp-owners', 'a tool names its owner command at run time (format!): name it in owners.rs or call its typed command, so the check sees it'));
        for (const m of line.matchAll(/\b(?:typed|typed_json|run)::<\s*((?:\w+::)+)(\w+)\s*>/g)) {
          const path = (m[1] ?? '').split('::').filter(Boolean);
          const head = path[0] ?? '';
          const plugin = pluginOf(alias.get(head) ?? head);
          const id = plugin ? types.get(plugin)?.get(m[2] ?? '') : undefined;
          if (id && !ids.has(id)) out.push(finding(f, i + 1, 'rust-mcp-owners', `${m[1]}${m[2]} ("${id}"): no host registers it, so the MCP tool that runs it fails for every caller`));
        }
      });
    }
    return out;
  },
};
