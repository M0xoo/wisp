// ARCHITECTURE.md rule 6 (plan §6.2, §6.5, ADR-0003, ADR-0008). Every plugins/*/host/wisp-plugin.json
// validates (with @wisp/kernel's validateManifest once the kernel exports it), plugin ids are unique,
// every command is named by some capability set (default deny: packages/kernel/src/capabilities.ts),
// every extension point has a version, and every service method maps to a permission.
//
// Commands come from the manifest's contributes.commands and from `ctx.command({ id })` calls in the
// host; a command the host registers but the manifest doesn't declare is an error too. A bare '*' in a
// capability set names nothing (user:full allows '*'; that would make every command "named"): a
// command is named when an allow list or a deny's permission covers it by its own prefix.

import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { finding } from '../core/report.ts';
import { isCode, isTest, lineOf, objectProp, stringProp, unwrap, visit } from '../core/source.ts';
import { isRecord } from '../core/workspace.ts';
import type { Ctx, Finding, Rule } from '../core/types.ts';
import { serviceFindings } from './manifest-services.ts';

const ID = 'manifests';
export const KERNEL_INDEX = 'packages/kernel/src/index.ts';
export const CAPABILITIES = 'packages/kernel/src/capabilities.ts';

type Validate = (m: unknown) => unknown;

function exportsName(ctx: Ctx, file: string, name: string): boolean {
  if (!ctx.exists(file)) return false;
  let found = false;
  visit(ctx.source(file), (n) => {
    const exported = ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported && ts.isFunctionDeclaration(n) && n.name?.text === name) found = true;
    if (exported && ts.isVariableStatement(n) && n.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)) found = true;
    if (ts.isExportSpecifier(n) && n.name.text === name) found = true;
  });
  return found;
}

async function loadValidator(ctx: Ctx): Promise<Validate | string> {
  if (!exportsName(ctx, KERNEL_INDEX, 'validateManifest')) return `${KERNEL_INDEX} doesn't export validateManifest yet: only the built-in minimum was checked`;
  try {
    const mod: unknown = await import(pathToFileURL(join(ctx.root, KERNEL_INDEX)).href);
    const fn = isRecord(mod) ? mod['validateManifest'] : undefined;
    return typeof fn === 'function' ? (m: unknown): unknown => Reflect.apply(fn, undefined, [m]) : `${KERNEL_INDEX}: validateManifest is not a function`;
  } catch (e) {
    return `${KERNEL_INDEX} failed to load (${e instanceof Error ? e.message : String(e)}): only the built-in minimum was checked`;
  }
}

/** Whatever shape the kernel's validator answers in (true, string[], {ok, errors}, throws), as messages. */
export function toErrors(r: unknown): string[] {
  if (r === true || r === undefined || r === null) return [];
  if (r === false) return ['invalid manifest'];
  if (typeof r === 'string') return [r];
  if (Array.isArray(r)) return r.flatMap((x) => (typeof x === 'string' ? [x] : isRecord(x) ? [[x['path'], x['message']].filter((s) => typeof s === 'string').join(': ') || JSON.stringify(x)] : [String(x)]));
  if (isRecord(r)) {
    if (r['ok'] === true || r['valid'] === true) return [];
    for (const k of ['errors', 'error', 'issues', 'message']) if (k in r) return toErrors(r[k]);
    if (r['ok'] === false || r['valid'] === false) return ['invalid manifest'];
    return []; // a returned manifest: valid
  }
  return [];
}

function minimum(m: unknown): string[] {
  if (!isRecord(m)) return ['a manifest is a JSON object'];
  const errs: string[] = [];
  if (m['wispPlugin'] !== 1) errs.push('wispPlugin must be 1');
  for (const k of ['id', 'version', 'api']) if (typeof m[k] !== 'string' || !m[k]) errs.push(`${k} must be a non-empty string`);
  return errs;
}

/**
 * What capabilities.ts names: the strings of every `allow` list and every `permission:` (a deny names
 * a command too: someone decided about it). Prose (`why`) is not a name. A file without either shape
 * falls back to all of its string literals.
 */
export function capabilityNames(sf: ts.SourceFile): string[] {
  const named: string[] = [];
  const all: string[] = [];
  const strings = (e: ts.Node, into: string[]): void =>
    visit(e, (n) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) into.push(n.text);
    });
  visit(sf, (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) all.push(n.text);
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name)) {
      if (n.name.text === 'allow' || n.name.text === 'permission') strings(n.initializer, named);
    }
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && /allow/i.test(n.name.text) && n.initializer) strings(n.initializer, named);
  });
  return named.length ? named : all;
}

export function names(pattern: string, candidates: readonly string[]): boolean {
  const p = pattern.replace(/\{.*\}$/, '');
  if (p === '*' || p === '') return false;
  if (!p.includes('*')) return candidates.includes(p);
  const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
  return candidates.some((c) => re.test(c));
}

interface Command {
  id: string;
  permission: string | undefined;
  file: string;
  line: number;
}

function hostCommands(ctx: Ctx, dir: string): Command[] {
  const out: Command[] = [];
  for (const file of ctx.files.filter((f) => f.startsWith(`${dir}/`) && isCode(f) && !isTest(f))) {
    const sf = ctx.source(file);
    visit(sf, (n) => {
      if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression) || n.expression.name.text !== 'command') return;
      const arg = n.arguments[0] ? unwrap(n.arguments[0]) : undefined;
      if (!arg || !ts.isObjectLiteralExpression(arg) || !objectProp(arg, 'run')) return;
      const id = stringProp(arg, 'id');
      if (id) out.push({ id, permission: stringProp(arg, 'permission'), file, line: lineOf(sf, n) });
    });
  }
  return out;
}

function lineIn(text: string, needle: string): number {
  const at = text.indexOf(needle);
  return at < 0 ? 1 : text.slice(0, at).split('\n').length;
}

function list(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? v.filter(isRecord) : [];
}

function checkContributes(file: string, text: string, m: Record<string, unknown>, caps: string[] | undefined, host: Command[]): Finding[] {
  const out: Finding[] = [];
  const contributes = isRecord(m['contributes']) ? m['contributes'] : {};
  for (const p of list(contributes['points'])) {
    const v = p['version'];
    if (!(typeof v === 'number' && Number.isInteger(v) && v >= 1)) out.push(finding(file, lineIn(text, `"${String(p['id'])}"`), ID, `extension point ${String(p['id'])} needs an integer version ≥ 1`));
  }
  const declared = list(contributes['commands']).flatMap((c) => (typeof c['id'] === 'string' ? [c['id']] : []));
  const commands: Command[] = declared.map((id) => ({ id, permission: host.find((h) => h.id === id)?.permission, file, line: lineIn(text, `"${id}"`) }));
  for (const h of host) {
    if (!declared.includes(h.id)) {
      out.push(finding(h.file, h.line, ID, `command ${h.id} is registered but not in ${file} contributes.commands`));
      commands.push(h);
    }
  }
  if (!caps) return commands.length ? [...out, finding(file, 1, ID, `${CAPABILITIES} doesn't exist yet: default deny is not checked`, 'warn')] : out;
  for (const c of commands) {
    const candidates = [c.id, c.id.replace('.', ':'), ...(c.permission ? [c.permission] : [])];
    if (!caps.some((p) => names(p, candidates))) out.push(finding(c.file, c.line, ID, `command ${c.id} is in no capability set (${CAPABILITIES}): default deny makes it unreachable`));
  }
  return out;
}

export const manifests: Rule = {
  id: ID,
  description: 'manifests validate, ids unique, commands in a capability set, points versioned, service methods mapped',
  async run(ctx) {
    const out: Finding[] = [];
    const hosts = ctx.pkgs.filter((p) => p.kind === 'plugin-host');
    const validate = hosts.length ? await loadValidator(ctx) : undefined;
    if (typeof validate === 'string') out.push(finding(KERNEL_INDEX, 1, ID, validate, 'warn'));
    const caps = ctx.exists(CAPABILITIES) ? capabilityNames(ctx.source(CAPABILITIES)) : undefined;
    const seen = new Map<string, string>();
    for (const host of hosts) {
      const file = `${host.dir}/wisp-plugin.json`;
      if (!ctx.exists(file)) {
        // a warning while v2 is being built; the kernel never loads a host without one
        out.push(finding(`${host.dir}/package.json`, 1, ID, 'a plugin host needs a wisp-plugin.json', 'warn'));
        continue;
      }
      const text = ctx.read(file);
      let m: unknown;
      try {
        m = JSON.parse(text);
      } catch (e) {
        out.push(finding(file, 1, ID, `not JSON: ${e instanceof Error ? e.message : String(e)}`));
        continue;
      }
      let errs = minimum(m);
      if (typeof validate === 'function') {
        try {
          errs = [...new Set([...errs, ...toErrors(validate(m))])];
        } catch (e) {
          errs.push(e instanceof Error ? e.message : String(e));
        }
      }
      for (const e of errs) out.push(finding(file, 1, ID, e));
      if (!isRecord(m)) continue;
      const id = typeof m['id'] === 'string' ? m['id'] : '';
      const first = seen.get(id);
      if (id && first) out.push(finding(file, lineIn(text, '"id"'), ID, `plugin id ${id} is also used by ${first}`));
      else if (id) seen.set(id, file);
      out.push(...checkContributes(file, text, m, caps, hostCommands(ctx, host.dir)));
    }
    out.push(...serviceFindings(ctx));
    return out;
  },
};
