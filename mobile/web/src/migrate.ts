// v1's computers screen (mobile/www/app.js) kept its computers in this same origin's localStorage
// (`wisp.machines`). v2 keeps them on the device (Computers.java), so the first start copies them
// across once. v1's list is left as it was, so an older build still finds it.

import type { Computer, NativeBridge } from './bridge.ts';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const V1 = 'wisp.machines';
const DONE = 'wisp.machines.v2';

type Row = Record<string, unknown>;
const rows = (v: unknown): Row[] => (Array.isArray(v) ? v.filter((x): x is Row => !!x && typeof x === 'object') : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// v1 started wisp with npx; v2's bootstrap installs the wisp binary when the command is ''.
const v1Command = (c: string): boolean => /^npx\s+(-y\s+)?wisp-agents(@\S*)?$/.test(c.trim());

function hostOf(target: string): string {
  const at = target.lastIndexOf('@');
  return (at > 0 ? target.slice(at + 1) : target).replace(/:\d+$/, '');
}

/** The v2 computers in one v1 entry: an SSH computer, or a grid account and its computers. */
export function fromV1(m: Row): Computer[] {
  const id = str(m['id']);
  if (!id) return [];
  if (m['kind'] !== 'grid') {
    const target = str(m['target']);
    const command = str(m['command']);
    const num = (k: string): object => (typeof m[k] === 'number' ? { [k]: m[k] } : {});
    return [{ id, kind: 'ssh', name: str(m['name']) || hostOf(target) || id, target, ...num('sshPort'), ...num('port'), ...(str(m['keyId']) && { keyId: str(m['keyId']) }), ...(command && !v1Command(command) && { command }) }];
  }
  const token = str(m['token']);
  if (m['signedOut'] === true || !token) return []; // signing in again makes a fresh entry
  const grid = str(m['grid']);
  const own: Computer = { id, kind: 'grid', name: str(m['name']) || str(m['handle']) || 'wisp Cloud', url: str(m['url']), token, ...(grid && { grid }) };
  const theirs = rows(m['computers'])
    .filter((c) => str(c['id']) && str(c['url']))
    .map((c): Computer => ({ id: `${id}.${str(c['id'])}`, kind: 'grid', name: str(c['name']) || str(c['id']), url: str(c['url']), token, computer: str(c['id']), ...(grid && { grid }) }));
  return [...(str(m['url']) ? [own] : []), ...theirs];
}

/** Copies v1's computers in, once. Answers how many it saved. */
export async function migrateV1(storage: StorageLike | undefined, bridge: NativeBridge): Promise<number> {
  if (!storage || storage.getItem(DONE)) return 0;
  let list: Row[] = [];
  try {
    list = rows(JSON.parse(storage.getItem(V1) ?? '[]'));
  } catch {
    list = []; // a damaged list: nothing to bring over
  }
  const have = new Set((await bridge.list()).map((c) => c.id));
  let n = 0;
  for (const c of list.flatMap(fromV1)) {
    if (have.has(c.id)) continue;
    await bridge.save(c);
    n += 1;
  }
  storage.setItem(DONE, '1');
  return n;
}
