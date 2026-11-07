// Small pieces validateManifest is made of: a problem list with paths, type checks, the grammars.
import type { Json } from './contract.ts';
import { permissionProblem } from './permissions.ts';

export interface ManifestError {
  path: string;
  message: string;
}

export class Problems {
  readonly list: ManifestError[] = [];
  add(path: string, message: string): void {
    this.list.push({ path, message });
  }
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

export function isJson(v: unknown, depth = 0): v is Json {
  if (depth > 64) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isJson(x, depth + 1));
  if (isObj(v)) return Object.getPrototypeOf(v) === Object.prototype && Object.values(v).every((x) => isJson(x, depth + 1));
  return false;
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0] ?? 0;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j] ?? 0;
      d[j] = Math.min((d[j] ?? 0) + 1, (d[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length] ?? 0;
}

/** The closest known key, when one is close enough to be a typo. */
export function closest(key: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let score = Math.max(2, Math.floor(key.length / 3)) + 1;
  for (const k of known) {
    const s = distance(key.toLowerCase(), k.toLowerCase());
    if (s < score) [best, score] = [k, s];
  }
  return best;
}

// v1 spell keys and where each one went, so an old manifest says what to write instead.
const SPELL_KEYS: Readonly<Record<string, string>> = {
  buttons: 'contributes.ui (extensions with attachTo)',
  chips: 'contributes.ui (extensions with attachTo)',
  panels: 'contributes.ui (views)',
  harnesses: 'requires',
  data: 'permissions ("topic:read{…}")',
  script: 'server or a ui component',
  hooks: 'contributes.runtime.hooks',
  settings: 'contributes.settings or contributes.setSettings',
  parts: 'contributes.parts and contributes.partStyles',
  wispSpell: 'wispPlugin: 1 (convert the spell with convertSpell)',
};

export function unknownKeys(o: Record<string, unknown>, known: readonly string[], at: string, p: Problems): void {
  for (const k of Object.keys(o)) {
    if (known.includes(k)) continue;
    const path = at ? `${at}.${k}` : k;
    const spell = at === '' ? SPELL_KEYS[k] : undefined;
    const near = closest(k, known);
    p.add(path, `unknown key "${k}"${spell ? `: a wispSpell key; in a plugin it is ${spell}` : near ? `; did you mean "${near}"?` : `; known keys: ${known.join(', ')}`}`);
  }
}

export function stringList(v: unknown, path: string, p: Problems, check?: (s: string, path: string) => void): readonly string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) {
    p.add(path, 'must be a list of strings');
    return undefined;
  }
  v.forEach((s, i) => {
    if (!isStr(s)) p.add(`${path}[${i}]`, 'must be a non-empty string');
    else check?.(s, `${path}[${i}]`);
  });
  return v.filter(isStr);
}

export function checkPermission(s: string, path: string, p: Problems): void {
  const why = permissionProblem(s);
  if (why) p.add(path, why);
}

// onCommand may carry an args filter: 'onCommand:runtime.start{harness:claude}'
const ACTIVATION = /^(onStartup|onCommand:[a-z][\w.-]*(\{[^{}]+\})?|onTopic:\S+|onView:[a-z][\w.:-]*|onBlock:[a-z][\w.-]*|onSchedule:\S+)$/;

export function checkActivation(s: string, path: string, p: Problems): void {
  if (ACTIVATION.test(s)) return;
  const kind = s.split(':')[0] ?? '';
  const kinds = ['onStartup', 'onCommand', 'onTopic', 'onView', 'onBlock', 'onSchedule'];
  if (!kinds.includes(kind)) p.add(path, `"${kind}" is not an activation event; use one of ${kinds.join(', ')}`);
  else p.add(path, `"${s}" is not ${kind === 'onStartup' ? 'onStartup' : `${kind}:<name>`}`);
}

/** 'shell.composer:left' or {id, input}, as {id, input}. */
export function attachTo(v: unknown, path: string, p: Problems): { id: string; input: string } | undefined {
  if (typeof v === 'string') {
    const at = v.lastIndexOf(':');
    if (at > 0 && at < v.length - 1) return { id: v.slice(0, at), input: v.slice(at + 1) };
  } else if (isObj(v) && isStr(v['id']) && isStr(v['input'])) {
    unknownKeys(v, ['id', 'input'], path, p);
    return { id: v['id'], input: v['input'] };
  }
  p.add(path, 'must be {id, input} or "parent.id:input"');
  return undefined;
}
