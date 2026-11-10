// v1-coverage: nothing of v1 gets lost (docs/v2-queue.md, "v1 → v2 coverage sweep"; ADR-0031 keeps the intent).
// Every v1 HTTP route (docs/v1-routes.txt) and every MCP tool, CLI command, setting key and telemetry event
// (docs/v1-surface.txt) has a row in docs/v2-coverage.md or docs/v1-dropped.md, and each row's references
// name something that exists in v2:
//   cmd:<id>        a command a plugin manifest lists
//   setting:<key>   a setting a plugin manifest declares
//   kind:<section>  a resource kind (`KindInfo::new("x", "<section>"`)
//   mcp:<tool>      an MCP tool (plugins/mcp/core/defs/*.json, or named in the MCP plugin's Rust)
//   cli:<verb>      a `wisp` verb named in crates/wisp/src
//   route:<path>    an HTTP route path named in a plugin's or the edge's Rust
//   telemetry:<ev>  a catalogue event (plugins/telemetry/api/src/catalogue.json) that some plugin emits
//   ui:<home>       client-only state (ADR-0006): says where, in words
//   todo:<what>     work, not coverage: a warning each, so the count shows in CI's summary
// A v1 item in neither table, a row for an item v1 doesn't have, or a reference to nothing is an error.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finding } from '../core/report.ts';
import { rustFiles, testStart } from '../core/rust.ts';
import type { Finding, Rule } from '../core/types.ts';

const ID = 'v1-coverage';
const COVERAGE = 'docs/v2-coverage.md';
const DROPPED = 'docs/v1-dropped.md';
const ROUTES = 'docs/v1-routes.txt';
const SURFACE = 'docs/v1-surface.txt';

interface Row {
  key: string;
  refs: string[];
  line: number;
}

/** `| kind | \`item\` | refs… |` rows of a markdown table; the header and rule lines are skipped. */
export function tableRows(text: string): Row[] {
  const out: Row[] = [];
  text.split('\n').forEach((l, i) => {
    const cells = l.split('|').map((c) => c.trim());
    if (cells.length < 4 || cells[1] === 'kind' || /^-+$/.test(cells[1] ?? '')) return;
    const kind = cells[1] ?? '';
    const item = (cells[2] ?? '').replace(/^`|`$/g, '');
    const refs = [...(cells[3] ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
    out.push({ key: kind === 'route' ? item : `${kind} ${item}`, refs, line: i + 1 });
  });
  return out;
}

/** v1's items as row keys: `GET /x` for a route, `<kind> <item>` for the rest. */
export function v1Items(routes: string, surface: string): string[] {
  const lines = (t: string): string[] => t.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return [...lines(routes), ...lines(surface)];
}

function json(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  } catch {
    return undefined;
  }
}

/** What v2 has, read once per run. */
interface V2 {
  commands: Set<string>;
  settings: Set<string>;
  rust: string; // every non-test Rust source but the telemetry catalogue's own crate
  cli: string;
  mcp: Set<string>;
  catalogue: Set<string>;
}

function readV2(root: string): V2 {
  const commands = new Set<string>();
  const settings = new Set<string>();
  const plugins = existsSync(join(root, 'plugins')) ? readdirSync(join(root, 'plugins')) : [];
  for (const p of plugins) {
    const m = json(join(root, 'plugins', p, 'host', 'wisp-plugin.json')) as { contributes?: { commands?: { id?: string }[]; settings?: { key?: string }[] } } | undefined;
    for (const c of m?.contributes?.commands ?? []) if (c.id) commands.add(c.id);
    for (const s of m?.contributes?.settings ?? []) if (s.key) settings.add(s.key);
  }
  const src = (dir: string): string =>
    rustFiles(root, dir)
      .filter((f) => !f.includes('/tests/'))
      .map((f) => {
        const lines = readFileSync(join(root, f), 'utf8').split('\n');
        return lines.slice(0, testStart(lines)).join('\n');
      })
      .join('\n');
  const rust = [...plugins.flatMap((p) => ['host', 'core', 'api'].filter((r) => !(p === 'telemetry' && r === 'api')).map((r) => src(`plugins/${p}/${r}/src`))), src('crates'), src('apps/grid')].join('\n');
  const mcp = new Set<string>();
  const defs = join(root, 'plugins/mcp/core/defs');
  for (const f of existsSync(defs) ? readdirSync(defs) : []) {
    const text = f.endsWith('.json') ? readFileSync(join(defs, f), 'utf8') : '';
    for (const m of text.matchAll(/"name"\s*:\s*"([a-z_]+)"/g)) mcp.add(m[1] ?? '');
  }
  const cat = json(join(root, 'plugins/telemetry/api/src/catalogue.json'));
  const catalogue = new Set(Array.isArray(cat) ? cat.map((e: { name?: string }) => e.name ?? '') : []);
  return { commands, settings, rust, cli: src('crates/wisp/src'), mcp, catalogue };
}

const lit = (s: string): string => `"${s}"`;
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Why `ref` names nothing in v2, or '' when it does; 'todo' for work. */
export function checkRef(ref: string, v2: V2): string {
  const at = ref.indexOf(':');
  const kind = at < 0 ? ref : ref.slice(0, at);
  const what = at < 0 ? '' : ref.slice(at + 1);
  if (!what) return `\`${ref}\` names nothing (kind:value)`;
  switch (kind) {
    case 'cmd':
      return v2.commands.has(what) ? '' : `command ${what} is in no plugin manifest`;
    case 'setting':
      return v2.settings.has(what) ? '' : `setting ${what} is declared by no plugin manifest`;
    case 'kind':
      return new RegExp(`KindInfo::new\\(\\s*"[a-z_-]+",\\s*"${escape(what)}"`).test(v2.rust) ? '' : `no resource kind has the section ${what}`;
    case 'mcp':
      return v2.mcp.has(what) || v2.rust.includes(lit(what)) ? '' : `MCP tool ${what} is defined nowhere`;
    case 'cli':
      return v2.cli.includes(lit(what)) ? '' : `\`wisp ${what}\` is no verb in crates/wisp`;
    case 'route':
      return v2.rust.includes(lit(what)) ? '' : `no plugin or edge serves the route ${what}`;
    case 'telemetry':
      if (!v2.catalogue.has(what)) return `telemetry event ${what} isn't in the catalogue`;
      return v2.rust.includes(lit(what)) ? '' : `telemetry event ${what} is in the catalogue but no plugin emits it`;
    case 'ui':
      return what.trim().length >= 8 ? '' : `\`${ref}\`: say where the client keeps it, in words`;
    case 'todo':
      return 'todo';
    default:
      return `unknown reference kind ${kind} (cmd, setting, kind, mcp, cli, route, telemetry, ui, todo)`;
  }
}

export const v1Coverage: Rule = {
  id: ID,
  description: 'every v1 route, MCP tool, CLI command, setting and telemetry event maps to the v2 piece that serves it (docs/v2-coverage.md) or is dropped with a reason (docs/v1-dropped.md)',
  run(ctx) {
    const at = (f: string): string => join(ctx.root, f);
    if (!existsSync(at(ROUTES)) || !existsSync(at(SURFACE))) return [];
    const out: Finding[] = [];
    const items = v1Items(readFileSync(at(ROUTES), 'utf8'), readFileSync(at(SURFACE), 'utf8'));
    const known = new Set(items);
    const rows = existsSync(at(COVERAGE)) ? tableRows(readFileSync(at(COVERAGE), 'utf8')) : [];
    const dropped = existsSync(at(DROPPED)) ? tableRows(readFileSync(at(DROPPED), 'utf8')) : [];
    const mapped = new Map<string, Row>();
    for (const r of rows) {
      if (mapped.has(r.key)) out.push(finding(COVERAGE, r.line, ID, `${r.key} has two rows`));
      mapped.set(r.key, r);
      if (!known.has(r.key)) out.push(finding(COVERAGE, r.line, ID, `${r.key} is no v1 item (docs/v1-routes.txt, docs/v1-surface.txt)`));
    }
    for (const d of dropped) {
      if (!known.has(d.key)) out.push(finding(DROPPED, d.line, ID, `${d.key} is no v1 item`));
      if (mapped.has(d.key)) out.push(finding(DROPPED, d.line, ID, `${d.key} is both mapped and dropped`));
    }
    const gone = new Set(dropped.map((d) => d.key));
    for (const it of items) if (!mapped.has(it) && !gone.has(it)) out.push(finding(COVERAGE, 1, ID, `v1's ${it} maps to nothing in v2: add its row (the v2 command, setting or event that serves it), or drop it in ${DROPPED} with a reason`));
    const v2 = readV2(ctx.root);
    let todo = 0;
    for (const r of rows) {
      if (!r.refs.length) out.push(finding(COVERAGE, r.line, ID, `${r.key}: no v2 reference`));
      for (const ref of r.refs) {
        const why = checkRef(ref, v2);
        if (why === 'todo') todo += 1;
        else if (why) out.push(finding(COVERAGE, r.line, ID, `${r.key}: ${why}`));
      }
    }
    if (todo) out.push(finding(COVERAGE, 1, ID, `${todo} v1 items are still work (todo: rows); each is built with a named test`, 'warn'));
    return out;
  },
};
