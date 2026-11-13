// The task row as Ship it reads it. A synced `session` row is the store's (runtime's columns, the
// fields plugins add under `summary`, a bare id); Ship it reads one flat row keyed by its entity key
// (`local:01a…`), as v1's summary was. Pure: every reader goes through it.
import type { ShipSession } from './types.ts';

type Raw = { readonly id: string; readonly summary?: unknown; readonly [k: string]: unknown };

export function shipRow(raw: Raw | undefined, key?: string): ShipSession | undefined {
  if (!raw) return undefined;
  const { summary, ...cols } = raw;
  const fields = summary && typeof summary === 'object' ? (summary as Record<string, unknown>) : {};
  return { ...fields, ...cols, id: key ?? raw.id } as unknown as ShipSession;
}
