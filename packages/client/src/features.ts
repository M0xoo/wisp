// Features come from the peer, not from the version number (plan §7.3.2 rule 3). The welcome
// lists what a peer offers; the UI asks `hasFeature` and greys a feature out with the reason it
// returns. There are no `if version >= x` checks in UI code.

import type { PeerInfo } from '@wisp/protocol';

export interface FeatureNeed {
  /** the plugin that provides it: 'wisp.crew' */
  plugin: string;
  command?: string;
  topic?: string;
  block?: string;
  /** lowest plugin version that has it */
  minVersion?: string;
  /** what the user calls it, for the reason: 'Crew' */
  label?: string;
}

export type FeatureAnswer = { ok: true } | { ok: false; reason: string };

/** Compares dotted numeric versions; pre-release tags sort before the release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): { nums: number[]; pre: boolean } => {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((x) => Number.parseInt(x, 10) || 0), pre: pre !== undefined };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
}

export function hasFeature(info: PeerInfo | undefined, need: FeatureNeed, peerName?: string): FeatureAnswer {
  const what = need.label ?? need.command ?? need.plugin;
  if (!info) return { ok: false, reason: `${peerName ?? 'This computer'} hasn't connected yet` };
  const on = `on ${info.name}`;
  const p = info.plugins.find((x) => x.id === need.plugin);
  if (!p) return { ok: false, reason: `${what} isn't installed ${on}` };
  if (need.minVersion && compareVersions(p.version, need.minVersion) < 0) {
    return { ok: false, reason: `${what} needs ${need.plugin} ${need.minVersion} ${on}` };
  }
  const missing = (need.command && !p.commands.includes(need.command)) || (need.topic && !p.topics.includes(need.topic)) || (need.block && !p.blocks.includes(need.block));
  if (missing) return { ok: false, reason: `${what} needs a newer ${need.plugin} ${on}` };
  return { ok: true };
}

/** The card text when a peer is outside the protocol window (plan §7.3.2 rule 1). */
export function updateReason(update: 'peer' | 'client', peerName: string): string {
  return update === 'peer' ? `Update wisp on ${peerName}` : `Update the app to use ${peerName}`;
}
