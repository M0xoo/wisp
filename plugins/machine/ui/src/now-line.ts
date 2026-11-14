// Settings → Usage → Machine load's Now line, a plain module so its test needn't compile the group.
import type { PluginClient } from '@wisp/client';
import type { MachineLoad } from './types.ts';

/** "62% memory free · CPU at 50% of its cores · 2 runs of 4 going", and why automations wait, if they do (v1 paintLoad). */
export function nowLine(l: MachineLoad | undefined, t: PluginClient['t']): string {
  if (!l) return t('machine.load.reading');
  const max = l.limits.maxRuns ?? null;
  const bits = [
    l.mem_free_pct === null ? '' : t('machine.load.free', { n: Math.round(l.mem_free_pct) }),
    l.cpu === undefined || l.cpu === null ? '' : t('machine.load.cpuNow', { n: Math.round(l.cpu) }),
    max === null ? t('machine.load.runs', { count: l.runs }) : t('machine.load.runsOf', { count: l.runs, max }),
  ].filter(Boolean);
  return l.held ? `${bits.join(' · ')}. ${l.held.why}` : bits.join(' · ');
}
