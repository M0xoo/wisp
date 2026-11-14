// Typed access to a command's parts for tests: `wire` is optional and `optimistic` may be 'none' on
// CommandDef, so a test asserts the part is there (and fails loudly if not) instead of casting.
import type { CommandDef, DeepReadonly, EntityOps, EntityReader } from '@wisp/client';
import type { PatchOp } from '@wisp/protocol';

/** the command's wire mapping; throws when it declares none */
export function wireOf<A, R>(cmd: CommandDef<A, R>): (args: A) => unknown {
  const { wire } = cmd;
  if (wire === undefined) throw new Error(`${cmd.id} has no wire mapping`);
  return wire;
}

/** the command's optimistic patch; throws when it is optimistic: 'none' */
export function optimisticOf<A, R>(cmd: CommandDef<A, R>): (base: EntityReader, args: A) => EntityOps {
  const { optimistic } = cmd;
  if (optimistic === 'none') throw new Error(`${cmd.id} has no optimistic patch`);
  return optimistic;
}

/** a reader whose peek returns `row` for every key (the other methods are unused by these commands) */
export function peekReader(row: unknown): EntityReader {
  const unused = (): never => {
    throw new Error('not used by this test');
  };
  return { peek: <T>() => row as DeepReadonly<T> | undefined, row: unused, keys: unused, list: unused, pending: unused };
}

/** the JSON-patch ops of the i-th entity op, [] when it is not a patch */
export function patchOps(ops: EntityOps, i = 0): readonly PatchOp[] {
  const op = ops[i];
  return op?.op === 'patch' ? op.ops : [];
}

/** the value of the j-th patch op of the i-th entity op */
export function patchValue(ops: EntityOps, i = 0, j = 0): unknown {
  const p = patchOps(ops, i)[j];
  return p !== undefined && 'value' in p ? p.value : undefined;
}

/** walks plain-object keys; undefined as soon as a step is not an object */
export function field(v: unknown, ...path: string[]): unknown {
  let at = v;
  for (const k of path) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = (at as Record<string, unknown>)[k];
  }
  return at;
}
