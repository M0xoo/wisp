// Activation events (plan §6.4, VS Code's model): a plugin's code loads on its first event.
// A plugin with no `activation` list starts at startup: an interceptor that never loaded would be a
// guard nobody runs, so lazy is something a manifest asks for, not the default.
import type { DeepReadonly, Manifest } from './contract.ts';
import { isObj } from './manifest-check.ts';
import { glob } from './permissions.ts';

export type ActivationKind = 'onStartup' | 'onCommand' | 'onTopic' | 'onView' | 'onBlock' | 'onSchedule';

export function eager(m: DeepReadonly<Manifest>): boolean {
  return !m.activation || m.activation.includes('onStartup');
}

/** 'onCommand:runtime.start{harness:claude}' → {kind, name, filter}. */
export function parseActivation(a: string): { kind: ActivationKind; name: string; filter: Record<string, string> } {
  const at = a.indexOf(':');
  const kind = (at < 0 ? a : a.slice(0, at)) as ActivationKind;
  let name = at < 0 ? '' : a.slice(at + 1);
  const filter: Record<string, string> = {};
  const brace = kind === 'onCommand' ? name.indexOf('{') : -1;
  if (brace >= 0 && name.endsWith('}')) {
    for (const pair of name.slice(brace + 1, -1).split(',')) {
      const c = pair.indexOf(':');
      if (c > 0) filter[pair.slice(0, c).trim()] = pair.slice(c + 1).trim();
    }
    name = name.slice(0, brace);
  }
  return { kind, name, filter };
}

/** Does this manifest wait on (kind, name)? Commands it lists in contributes.commands count implicitly. */
export function wakes(m: DeepReadonly<Manifest>, kind: ActivationKind, name: string, args?: unknown): boolean {
  if (kind === 'onCommand' && (m.contributes?.commands ?? []).some((c) => c.id === name)) return true;
  return (m.activation ?? []).some((a) => {
    const p = parseActivation(a);
    if (p.kind !== kind || !glob(p.name, name)) return false;
    const keys = Object.keys(p.filter);
    if (!keys.length) return true;
    if (!isObj(args)) return false;
    return keys.every((k) => glob(p.filter[k] ?? '', String(args[k] ?? '')));
  });
}
