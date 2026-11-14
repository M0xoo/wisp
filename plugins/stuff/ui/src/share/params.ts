// Share…'s view params and who may be shared (v1 share.js shareable): small, so the plugin's index can name them
// without loading the dialog.
import type { EntityKey, ExtensionId } from '@wisp/client';

export const SHARE_VIEW = 'stuff.share' as ExtensionId;

export interface ShareParams {
  readonly session: EntityKey;
}

export const parseShareParams = (p: unknown): ShareParams => {
  const s = (p as { session?: unknown } | null)?.session;
  if (typeof s !== 'string' || !s.includes(':')) throw new Error('share: params.session is an entity key');
  return { session: s as EntityKey };
};

/** A task row as its menu lends it: its key in `id`. */
export interface ShareRow {
  readonly id: string;
  readonly agent?: string;
  readonly parentId?: string;
  readonly kind?: string;
  readonly pending?: boolean;
  readonly delegated?: unknown;
  readonly machine?: unknown;
}

/** v1 shareable: a task of yours, on this computer, not a subagent's or a delegated job */
export const shareable = (s: ShareRow | undefined): boolean => !!s && s.agent !== 'wisp' && !s.parentId && !s.kind && !s.pending && !s.delegated && !s.machine;
