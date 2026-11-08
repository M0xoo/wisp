// The Rust half of ARCHITECTURE.md's rules (docs/v2-quality-audit.md "Checks to add"), read from the
// workspace's Cargo.toml files and .rs sources (core/rust.ts):
//   rust-layers     a plugin's crates use other plugins' -api crates only; api ↛ core ↛ host within a
//                   plugin; base crates (crates/* but the binary) use no plugin crate
//   rust-sans-io    plugins/*/core, wisp-sync and wisp-protocol: no IO crate, no fs/net/process/clock
//   rust-unsafe     `unsafe` only in crates/wisp-proc/src/sys/
//   rust-sizes      src files over 400 lines and fns over 60 warn, unless a `size-ok:` reason is written
//   rust-manifests  every plugin host has a valid wisp-plugin.json whose commands sit in its namespace
//                   and are named by a capability set
//   rust-resource-kinds  a plugin with tables a user sets up registers a resource kind (its settings are
//                   wisp.settings' `setting` kind), unless plugins/resources/pending-kinds.txt lists it
// Normal and build dependencies count for the layers; dev-dependencies don't (tests may wire anything).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finding } from '../core/report.ts';
import { codeLines, crates, header, isTestFile, rustFiles, testStart, type Crate } from '../core/rust.ts';
import type { Finding, Rule } from '../core/types.ts';

export const RUST_MAX_FILE = 400;
export const RUST_MAX_FN = 60;
const REASON = /size-ok:\s*\S/;

const where = (c: Crate): string => (c.plugin ? `plugins/${c.plugin}/${c.role}` : c.dir);
const manifestOf = (c: Crate): string => `${c.dir}/Cargo.toml`;

export const rustLayers: Rule = {
  id: 'rust-layers',
  description: 'plugin crates use other plugins through their -api crate only; base crates use no plugin',
  run(ctx) {
    const all = crates(ctx.root);
    const byName = new Map(all.map((c) => [c.name, c]));
    const out: Finding[] = [];
    const order = { api: 0, core: 1, host: 2 } as const;
    for (const c of all) {
      for (const name of c.deps) {
        const d = byName.get(name);
        if (!d?.plugin || !d.role) continue;
        const line = c.depLine.get(name) ?? 1;
        const bad = (why: string): void => void out.push(finding(manifestOf(c), line, 'rust-layers', `${c.name} depends on ${name} (${where(d)}): ${why}`));
        if (c.base) bad('a base crate depends on no plugin (ADR-0003)');
        else if (c.plugin && c.role && d.plugin !== c.plugin && d.role !== 'api') bad(`a plugin uses other plugins through their api crate only (wisp-${d.plugin}-api)`);
        else if (c.plugin && c.role && d.plugin === c.plugin && order[d.role] > order[c.role]) bad(`${c.role} sits below ${d.role} (api ← core ← host)`);
      }
    }
    return out;
  },
};

const SANS_IO_CRATES = new Set(['wisp-sync', 'wisp-protocol']);
const IO_DEPS = new Set(['tokio', 'reqwest', 'axum', 'hyper', 'rusqlite', 'wisp-proc', 'wisp-store']);
const IO_CODE: readonly [RegExp, string][] = [
  [/\bstd::fs\b/, 'std::fs'],
  [/\bstd::net\b/, 'std::net'],
  [/\bstd::process\b/, 'std::process'],
  [/\bSystemTime::now\b/, 'SystemTime::now (inject a clock)'],
  [/\bInstant::now\b/, 'Instant::now (inject a clock)'],
  [/\btokio::/, 'tokio'],
];

export const rustSansIo: Rule = {
  id: 'rust-sans-io',
  description: 'core crates, wisp-sync and wisp-protocol do no IO and read no clock',
  run(ctx) {
    const out: Finding[] = [];
    for (const c of crates(ctx.root).filter((x) => x.role === 'core' || SANS_IO_CRATES.has(x.name))) {
      for (const name of c.deps.filter((d) => IO_DEPS.has(d))) out.push(finding(manifestOf(c), c.depLine.get(name) ?? 1, 'rust-sans-io', `${c.name} is sans-IO and depends on ${name}: inject it instead`));
      for (const file of rustFiles(ctx.root, `${c.dir}/src`).filter((f) => !isTestFile(f))) {
        const lines = codeLines(readFileSync(join(ctx.root, file), 'utf8'));
        const end = testStart(lines);
        for (let i = 0; i < end; i++) {
          for (const [re, what] of IO_CODE) if (re.test(lines[i] ?? '')) out.push(finding(file, i + 1, 'rust-sans-io', `${c.name} is sans-IO: no ${what}`));
        }
      }
    }
    return out;
  },
};

const UNSAFE_OK = 'crates/wisp-proc/src/sys/';

export const rustUnsafe: Rule = {
  id: 'rust-unsafe',
  description: `unsafe only in ${UNSAFE_OK}`,
  run(ctx) {
    const out: Finding[] = [];
    for (const c of crates(ctx.root)) {
      for (const file of rustFiles(ctx.root, c.dir).filter((f) => !f.startsWith(UNSAFE_OK))) {
        codeLines(readFileSync(join(ctx.root, file), 'utf8')).forEach((l, i) => {
          if (/\bunsafe\b/.test(l)) out.push(finding(file, i + 1, 'rust-unsafe', `unsafe outside ${UNSAFE_OK} (the one reviewed module)`));
        });
      }
    }
    return out;
  },
};

/** The fns of a file (outside its test module) longer than the cap: [line, name, length]. */
export function longFns(text: string, max = RUST_MAX_FN): [number, string, number][] {
  const raw = text.split('\n');
  const lines = codeLines(text);
  const end = testStart(lines);
  const out: [number, string, number][] = [];
  for (let i = 0; i < end; i++) {
    const m = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+([A-Za-z0-9_]+)/.exec(lines[i] ?? '');
    if (!m?.[1]) continue;
    // the body: from the first `{` (a `;` first is a declaration) to its matching `}`
    let depth = 0;
    let open = false;
    let j = i;
    scan: for (; j < end; j++) {
      for (const ch of lines[j] ?? '') {
        if (!open && ch === ';') break scan;
        if (ch === '{') {
          depth++;
          open = true;
        } else if (ch === '}' && --depth === 0 && open) break scan;
      }
    }
    if (!open) continue;
    const len = j - i + 1;
    // a reason sits in the comments and attributes right above the fn
    let k = i - 1;
    let ok = false;
    while (k >= 0 && /^\s*(\/\/|#\[|$)/.test(raw[k] ?? '')) ok ||= REASON.test(raw[k--] ?? '');
    if (len > max && !ok) out.push([i + 1, m[1], len]);
  }
  return out;
}

export const rustSizes: Rule = {
  id: 'rust-sizes',
  description: `warn on Rust src files over ${RUST_MAX_FILE} lines and fns over ${RUST_MAX_FN}, unless a size-ok: reason is written`,
  run(ctx) {
    const out: Finding[] = [];
    for (const c of crates(ctx.root)) {
      for (const file of rustFiles(ctx.root, `${c.dir}/src`).filter((f) => !isTestFile(f))) {
        const text = readFileSync(join(ctx.root, file), 'utf8');
        const n = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
        if (n > RUST_MAX_FILE && !REASON.test(header(text))) out.push(finding(file, 1, 'rust-sizes', `${n} lines (soft cap ${RUST_MAX_FILE}): split it, or say why with //! size-ok: in its header`, 'warn'));
        for (const [line, name, len] of longFns(text)) out.push(finding(file, line, 'rust-sizes', `fn ${name} is ${len} lines (soft cap ${RUST_MAX_FN})`, 'warn'));
      }
    }
    return out;
  },
};

interface CapData {
  sets?: { allow?: string[] }[];
}

const glob = (pat: string, s: string): boolean => new RegExp(`^${pat.replace(/\{[^}]*\}/g, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(s);
/** `git.worktree.add` → `git:worktree.add` (wisp-kernel perm::of_command) */
const ofCommand = (id: string): string => (id.includes('.') ? id.replace('.', ':') : `${id}:*`);

function manifestJson(file: string, text: string, out: Finding[]): Record<string, unknown> | undefined {
  try {
    const m: unknown = JSON.parse(text);
    if (m && typeof m === 'object' && !Array.isArray(m)) return m as Record<string, unknown>;
    out.push(finding(file, 1, 'rust-manifests', 'a manifest is a JSON object'));
  } catch (e) {
    out.push(finding(file, 1, 'rust-manifests', `not JSON: ${e instanceof Error ? e.message : String(e)}`));
  }
  return undefined;
}

export const rustManifests: Rule = {
  id: 'rust-manifests',
  description: 'every plugin host has a valid wisp-plugin.json; its commands are in its namespace and named by a capability set',
  run(ctx) {
    const out: Finding[] = [];
    const hosts = crates(ctx.root).filter((c) => c.role === 'host');
    const caps = join(ctx.root, 'crates/wisp-kernel/capabilities.json');
    const data: CapData = existsSync(caps) ? (JSON.parse(readFileSync(caps, 'utf8')) as CapData) : {};
    // as the kernel reads them: `user:full`'s `*` names every command (the user reaches all of them)
    const named = (data.sets ?? []).flatMap((s) => s.allow ?? []);
    const manifests: { c: Crate; file: string; m: Record<string, unknown> }[] = [];
    for (const c of hosts) {
      const file = `${c.dir}/wisp-plugin.json`;
      const isPlugin = rustFiles(ctx.root, `${c.dir}/src`).some((f) => /impl\s+(?:wisp_kernel::)?Plugin\s+for\b/.test(readFileSync(join(ctx.root, f), 'utf8')));
      // every host crate is a plugin: a manifest beside its Cargo.toml and an `impl Plugin`
      if (!isPlugin) out.push(finding(manifestOf(c), 1, 'rust-manifests', `${c.name} is a plugin host but implements no Plugin`));
      if (!existsSync(join(ctx.root, file))) {
        out.push(finding(manifestOf(c), 1, 'rust-manifests', `${c.name} is a plugin host but has no wisp-plugin.json beside its Cargo.toml`));
        continue;
      }
      const m = manifestJson(file, readFileSync(join(ctx.root, file), 'utf8'), out);
      if (m) manifests.push({ c, file, m });
    }
    // a plugin's own permissions (its plugin:<id> set) name commands too, for every manifest
    const granted = [...named, ...manifests.flatMap(({ m }) => (Array.isArray(m['permissions']) ? (m['permissions'] as unknown[]).filter((p): p is string => typeof p === 'string') : []))];
    for (const { c, file, m } of manifests) {
      const id = typeof m['id'] === 'string' ? m['id'] : '';
      if (m['wispPlugin'] !== 1) out.push(finding(file, 1, 'rust-manifests', '"wispPlugin" must be 1'));
      if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(id)) out.push(finding(file, 1, 'rust-manifests', `"id" ${JSON.stringify(id)} is not <publisher>.<name>`));
      if (typeof m['version'] !== 'string' || !/^\d+\.\d+\.\d+/.test(m['version'])) out.push(finding(file, 1, 'rust-manifests', '"version" is semver'));
      const builtin = (m['server'] as { builtin?: unknown } | undefined)?.builtin;
      if (typeof builtin === 'string' && builtin.replace(/_/g, '-') !== c.name) out.push(finding(file, 1, 'rust-manifests', `server.builtin ${builtin} is not this crate (${c.name})`));
      const ns = id.split('.').slice(1).join('.');
      const cmds: unknown = (m['contributes'] as { commands?: unknown } | undefined)?.commands ?? [];
      if (!Array.isArray(cmds)) out.push(finding(file, 1, 'rust-manifests', 'contributes.commands must be a list of {id, title}'));
      for (const cmd of Array.isArray(cmds) ? (cmds as unknown[]) : []) {
        // as Manifest::parse (wisp-kernel manifest_contrib.rs) reads it
        if (!cmd || typeof cmd !== 'object') {
          out.push(finding(file, 1, 'rust-manifests', `contributes.commands: ${JSON.stringify(cmd)} must be {id, title}`));
          continue;
        }
        const { id: rawId, title } = cmd as { id?: unknown; title?: unknown };
        const cid = typeof rawId === 'string' ? rawId : '';
        if (typeof title !== 'string' || !title) out.push(finding(file, 1, 'rust-manifests', `command ${cid}: every command has a title (the palette shows it)`));
        if (!cid.startsWith(`${ns}.`)) out.push(finding(file, 1, 'rust-manifests', `command ${cid} is outside the plugin's namespace (${ns}.*)`));
        else if (!granted.some((p) => glob(p, ofCommand(cid)))) out.push(finding(file, 1, 'rust-manifests', `command ${cid} (${ofCommand(cid)}) is named by no capability set: default deny makes it unreachable`));
      }
    }
    return out;
  },
};

const PENDING = 'plugins/resources/pending-kinds.txt';

/** `plugins/resources/pending-kinds.txt`: plugin → why it has no kind yet. */
function pending(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const file = join(root, PENDING);
  if (!existsSync(file)) return out;
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((l, i) => {
      const name = l.split('#')[0]?.trim() ?? '';
      if (name) out.set(name, i + 1);
    });
  return out;
}

export const rustResourceKinds: Rule = {
  id: 'rust-resource-kinds',
  description: 'a plugin with tables a user configures registers a resource kind (wisp as code, ADR-0028); declared settings are the setting kind’s',
  run(ctx) {
    const out: Finding[] = [];
    const listed = pending(ctx.root);
    for (const c of crates(ctx.root).filter((x) => x.role === 'host' && x.plugin)) {
      const plugin = c.plugin ?? '';
      const files = rustFiles(ctx.root, `${c.dir}/src`).filter((f) => !isTestFile(f));
      const text = files.map((f) => readFileSync(join(ctx.root, f), 'utf8')).join('\n');
      // declared settings are wisp.settings' `setting` kind already; tables are the plugin's own to declare
      const tables = /Migration::sql\(/.test(text);
      const hasKind = /RESOURCE_KIND/.test(text);
      const line = listed.get(plugin);
      if (tables && !hasKind && line === undefined) {
        out.push(finding(manifestOf(c), 1, 'rust-resource-kinds', `${plugin} keeps tables but registers no resource kind (resource.kind@1): add one, or list it in ${PENDING} with why`));
      }
      if (hasKind && line !== undefined) out.push(finding(PENDING, line, 'rust-resource-kinds', `${plugin} has a resource kind now: take it off ${PENDING}`));
    }
    return out;
  },
};

export const RUST_RULES: readonly Rule[] = [rustLayers, rustSansIo, rustUnsafe, rustSizes, rustManifests, rustResourceKinds];
