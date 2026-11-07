// ARCHITECTURE.md rule 7 (plan §7.3.2 item 2): the wire types of packages/protocol/src/index.ts are
// diffed against every snapshot in packages/protocol/snapshots/*.json (the released versions).
// Removing or changing a field, message or topic without PROTO > the snapshot's proto fails.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { diffProtocol, PROTOCOL_INDEX, readProtocol, SNAPSHOT_DIR, type Snapshot } from '../protocol-shape.ts';
import { finding } from '../core/report.ts';
import { isRecord } from '../core/workspace.ts';
import type { Finding, Rule } from '../core/types.ts';

const ID = 'protocol';

function loadSnapshots(root: string): { file: string; snap: Snapshot }[] {
  const dir = join(root, SNAPSHOT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      const raw: unknown = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return isRecord(raw) && typeof raw['proto'] === 'number' && isRecord(raw['types']) ? [{ file: `${SNAPSHOT_DIR}/${f}`, snap: raw as unknown as Snapshot }] : [];
    });
}

export const protocol: Rule = {
  id: ID,
  description: 'protocol changes against released snapshots: removing or changing needs a PROTO bump',
  run(ctx) {
    if (!ctx.exists(PROTOCOL_INDEX)) return [];
    const snaps = loadSnapshots(ctx.root);
    if (!snaps.length) return [finding(SNAPSHOT_DIR, 1, ID, 'no protocol snapshot yet: run node tools/check/protocol-snapshot.ts --write when a version is released', 'warn')];
    const now = readProtocol(ctx.root);
    const out: Finding[] = [];
    for (const { file, snap } of snaps) {
      if (now.proto > snap.proto) continue; // a new version may break the old one: the version window handles it
      for (const ch of diffProtocol(snap, now)) {
        if (ch.kind === 'added') continue;
        out.push(finding(PROTOCOL_INDEX, now.lines[ch.type] ?? 1, ID, `${ch.path} ${ch.kind} since ${file} (proto ${snap.proto}): bump PROTO or keep it`));
      }
    }
    return out;
  },
};
