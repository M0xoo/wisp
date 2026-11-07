// The wire shapes of @wisp/protocol, as plain JSON, and the diff between two versions (plan §7.3.2):
// adding a field, message, command or topic is fine; removing or changing one needs PROTO + 1.
// Shared by the protocol rule and protocol-snapshot.ts (which writes packages/protocol/snapshots).

import { join } from 'node:path';
import ts from 'typescript';

export const PROTOCOL_INDEX = 'packages/protocol/src/index.ts';
export const SNAPSHOT_DIR = 'packages/protocol/snapshots';

export type Shape =
  | { k: 'text'; t: string }
  | { k: 'array'; of: Shape }
  | { k: 'object'; props: Record<string, { opt: boolean; s: Shape }> }
  | { k: 'union'; members: Record<string, Shape> };

export interface Snapshot {
  proto: number;
  protoMin: number;
  types: Record<string, Shape>;
}

export interface Change {
  path: string;
  kind: 'removed' | 'changed' | 'added';
  type: string; // the exported type it is under
}

const DISCRIMINANTS = ['t', 'op', 'kind', 'type', 'ok'];
const MAX_DEPTH = 6;

function sorted<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

function literalText(c: ts.TypeChecker, t: ts.Type): string | undefined {
  return t.flags & (ts.TypeFlags.StringLiteral | ts.TypeFlags.NumberLiteral | ts.TypeFlags.BooleanLiteral) ? c.typeToString(t) : undefined;
}

/** A union member's identity: its discriminant (`t=hello`) when it has one, else its text. */
function memberKey(c: ts.TypeChecker, t: ts.Type, s: Shape): string {
  if (t.flags & ts.TypeFlags.Object) {
    for (const d of DISCRIMINANTS) {
      const p = t.getProperty(d);
      const lit = p ? literalText(c, c.getTypeOfSymbol(p)) : undefined;
      if (lit) return `${d}=${lit.replace(/"/g, '')}`;
    }
  }
  return s.k === 'text' ? s.t : JSON.stringify(s);
}

/** The declared type of a property: for `x?: T`, T itself, not T | undefined. */
function propType(c: ts.TypeChecker, p: ts.Symbol): ts.Type {
  const d = p.valueDeclaration;
  if (d && (ts.isPropertySignature(d) || ts.isPropertyDeclaration(d)) && d.type) return c.getTypeFromTypeNode(d.type);
  return c.getTypeOfSymbol(p);
}

function describe(c: ts.TypeChecker, t: ts.Type, depth: number, top: boolean): Shape {
  const text = (): Shape => ({ k: 'text', t: c.typeToString(t, undefined, ts.TypeFormatFlags.NoTruncation) });
  if (depth > MAX_DEPTH) return text();
  // a named type used inside another is described where it is exported, not inline
  if (!top && (t.aliasSymbol || (t.symbol && t.flags & ts.TypeFlags.Object && (t as ts.ObjectType).objectFlags & ts.ObjectFlags.Interface))) return text();
  if (t.flags & ts.TypeFlags.Boolean || t.flags & ts.TypeFlags.Intersection) return text();
  if (t.isUnion()) {
    const members: Record<string, Shape> = {};
    for (const m of t.types) {
      const s = describe(c, m, depth + 1, false);
      members[memberKey(c, m, s)] = s;
    }
    return { k: 'union', members: sorted(members) };
  }
  if (c.isArrayType(t)) {
    const el = c.getTypeArguments(t as ts.TypeReference)[0];
    return el ? { k: 'array', of: describe(c, el, depth + 1, false) } : text();
  }
  if (t.flags & ts.TypeFlags.Object && t.getCallSignatures().length === 0 && c.getPropertiesOfType(t).length > 0) {
    const props: Record<string, { opt: boolean; s: Shape }> = {};
    for (const p of c.getPropertiesOfType(t)) {
      props[p.name] = { opt: (p.flags & ts.SymbolFlags.Optional) !== 0, s: describe(c, propType(c, p), depth + 1, false) };
    }
    return { k: 'object', props: sorted(props) };
  }
  return text();
}

function numberConst(c: ts.TypeChecker, exports: readonly ts.Symbol[], name: string): number {
  const s = exports.find((e) => e.name === name);
  const t = s ? c.getTypeOfSymbol(s) : undefined;
  return t?.isNumberLiteral() ? t.value : 0;
}

/** Reads the exported wire types (interfaces and type aliases) of the protocol entry. */
export function readProtocol(root: string, file = PROTOCOL_INDEX): Snapshot & { lines: Record<string, number> } {
  const abs = join(root, file);
  const program = ts.createProgram([abs], {
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    allowImportingTsExtensions: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    types: [],
    skipLibCheck: true,
  });
  const c = program.getTypeChecker();
  const sf = program.getSourceFile(abs);
  const mod = sf ? c.getSymbolAtLocation(sf) : undefined;
  const exports = mod ? c.getExportsOfModule(mod) : [];
  const types: Record<string, Shape> = {};
  const lines: Record<string, number> = {};
  for (const e of exports) {
    const sym = e.flags & ts.SymbolFlags.Alias ? c.getAliasedSymbol(e) : e;
    if (!(sym.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias))) continue;
    const decl = sym.declarations?.[0];
    if (!decl || decl.getSourceFile() !== sf) continue; // re-exported helpers are not wire shapes
    types[e.name] = describe(c, c.getDeclaredTypeOfSymbol(sym), 0, true);
    lines[e.name] = decl.getSourceFile().getLineAndCharacterOfPosition(decl.getStart()).line + 1;
  }
  return { proto: numberConst(c, exports, 'PROTO'), protoMin: numberConst(c, exports, 'PROTO_MIN'), types: sorted(types), lines };
}

function diffShape(a: Shape, b: Shape, path: string, type: string, out: Change[]): void {
  if (a.k !== b.k) {
    out.push({ path, kind: 'changed', type });
    return;
  }
  if (a.k === 'text' && b.k === 'text') {
    if (a.t !== b.t) out.push({ path, kind: 'changed', type });
  } else if (a.k === 'array' && b.k === 'array') diffShape(a.of, b.of, `${path}[]`, type, out);
  else if (a.k === 'object' && b.k === 'object') {
    for (const [name, pa] of Object.entries(a.props)) {
      const pb = b.props[name];
      if (!pb) out.push({ path: `${path}.${name}`, kind: 'removed', type });
      else {
        if (pa.opt !== pb.opt) out.push({ path: `${path}.${name}`, kind: 'changed', type });
        else diffShape(pa.s, pb.s, `${path}.${name}`, type, out);
      }
    }
    for (const name of Object.keys(b.props)) if (!a.props[name]) out.push({ path: `${path}.${name}`, kind: 'added', type });
  } else if (a.k === 'union' && b.k === 'union') {
    for (const [key, ma] of Object.entries(a.members)) {
      const mb = b.members[key];
      if (!mb) out.push({ path: `${path}|${key}`, kind: 'removed', type });
      else diffShape(ma, mb, `${path}|${key}`, type, out);
    }
    for (const key of Object.keys(b.members)) if (!a.members[key]) out.push({ path: `${path}|${key}`, kind: 'added', type });
  }
}

/** Changes from `old` to `now`; 'removed' and 'changed' break a peer that speaks `old`. */
export function diffProtocol(old: Pick<Snapshot, 'types'>, now: Pick<Snapshot, 'types'>): Change[] {
  const out: Change[] = [];
  for (const [name, s] of Object.entries(old.types)) {
    const n = now.types[name];
    if (!n) out.push({ path: name, kind: 'removed', type: name });
    else diffShape(s, n, name, name, out);
  }
  for (const name of Object.keys(now.types)) if (!old.types[name]) out.push({ path: name, kind: 'added', type: name });
  return out;
}
