// Checking parsed blocks (plan §6.9: the agent protocol is a contract). v1 kept every block with a
// string type and let each renderer ignore what it couldn't use; that stays, so old answers render
// as they did. On top: block types a plugin contributes (`runtime.block`) get its check, which may
// normalise or drop a block, and the built-in types are known so a typo shows up in `problems`.

import type { BlockType } from '@wisp-plugin/runtime-api';
import type { Block, Presentation } from '../model.ts';

/** The block types the protocol prompt documents (blocks/prompt.ts), plus what wisp writes itself. */
export const BUILTIN_BLOCKS: ReadonlySet<string> = new Set([
  'hero', 'markdown', 'steps', 'stats', 'files', 'diff', 'tests', 'commits', 'graph', 'tree', 'code',
  'compare', 'flow', 'chart', 'terminal', 'checklist', 'callout', 'image', 'video', 'preview', 'map',
  'doc', 'task', 'stuff', 'question', 'blocked', 'actions', 'next', 'app',
]);

const STATUS: ReadonlySet<string> = new Set(['done', 'partial', 'blocked', 'info']);

export interface CheckResult {
  presentation: Presentation;
  /** what was dropped or looks wrong, for logs and goldens; the user never sees these */
  problems: string[];
}

export function checkPresentation(p: Presentation, contributed: readonly BlockType[]): CheckResult {
  const byType = new Map(contributed.map((b) => [b.type, b]));
  const problems: string[] = [];
  const blocks: Block[] = [];
  let changed = false;
  p.blocks.forEach((b, i) => {
    const own = byType.get(b.type);
    if (own) {
      let out: ReturnType<BlockType['check']>;
      try {
        out = own.check(b);
      } catch (err) {
        out = { ok: false, reason: `its check threw: ${(err as Error).message}` };
      }
      changed = true;
      if (out.ok) blocks.push({ ...out.block, type: b.type });
      else problems.push(`block ${i} (${b.type}) dropped: ${out.reason}`);
      return;
    }
    if (!BUILTIN_BLOCKS.has(b.type)) problems.push(`block ${i}: unknown type "${b.type}"`);
    else if (b.type === 'hero' && b['status'] !== undefined && !STATUS.has(String(b['status']))) problems.push(`block ${i} (hero): status "${String(b['status'])}" is none of done, partial, blocked, info`);
    blocks.push(b);
  });
  if (!changed) return { presentation: p, problems };
  return { presentation: { ...p, blocks }, problems };
}
