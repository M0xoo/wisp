// What a turn reports (v1 server/services/telemetry.js trackTurns): fixed values about how it ran and
// ended, never the prompt or the result. The names are PostHog's dashboards: keep them.
import type { Json } from '@wisp/kernel';
import type { Session, Turn } from '@wisp-plugin/runtime-api';
import type { Props } from '@wisp-plugin/telemetry-api';

export const runProps = (s: Pick<Session, 'agent' | 'model' | 'mode' | 'effort'>, t: Pick<Turn, 'idx'> | undefined): Props => ({
  agent: s.agent,
  model: s.model || 'default',
  mode: s.mode,
  effort: s.effort || 'default',
  followUp: (t?.idx ?? 0) > 0,
});

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/**
 * Auto's choice, as fixed values only (never the prompt). wisp.router keeps v1's `session.route` in its
 * ext slot as `ext['wisp.router'].route`; read here without its api, field by field.
 */
export function routeProps(s: Pick<Session, 'ext'>): Props {
  const r = obj(obj(s.ext['wisp.router'])?.['route']);
  if (!r) return {};
  return {
    routed: true,
    routeGoal: str(r['goal']),
    routeType: str(r['type']),
    routeSize: str(r['size']) ?? num(r['size']),
    routeExplored: !!r['explored'],
    routeTrying: !!r['trying'],
    routePropensity: num(r['propensity']),
    routeTier: str(r['tier']) ?? num(r['tier']),
    routeTaste: str(r['taste']) ?? num(r['taste']),
    routePinned: !!r['pinned'],
    routeSuggested: !!r['suggest'],
    routeEffort: str(r['effort']) || 'default',
  };
}

export const blocksOf = (t: Pick<Turn, 'presentation'> | undefined): { type: string; [k: string]: unknown }[] => t?.presentation?.blocks ?? [];
export const heroStatus = (blocks: ReturnType<typeof blocksOf>): Json | undefined => {
  const s = blocks.find((b) => b.type === 'hero')?.['status'];
  return typeof s === 'string' ? s : undefined;
};
export const blockTypes = (blocks: ReturnType<typeof blocksOf>): string[] => [...new Set(blocks.map((b) => b.type))];

export function startedProps(s: Session, t: Turn | undefined): Props {
  return { ...runProps(s, t), attachments: t?.attachments.length ?? 0 };
}

export interface Ended {
  status: string;
  interrupted?: boolean;
}

export function endedProps(s: Session, t: Turn | undefined, e: Ended): Props {
  const blocks = blocksOf(t);
  const st = t?.stats ?? {};
  const fallback = obj(t?.presentation)?.['fallback'];
  return {
    ...runProps(s, t),
    ...routeProps(s),
    status: e.interrupted ? 'interrupted' : (t?.status ?? e.status), // done | error | stopped | interrupted
    heroStatus: heroStatus(blocks),
    durationMs: t && t.endedAt !== null ? t.endedAt - t.startedAt : undefined,
    blockCount: blocks.length,
    blockTypes: blockTypes(blocks),
    presentationFallback: !!fallback, // agent ignored or broke the wisp protocol
    changedFiles: t?.changedFiles ?? 0,
    inputTokens: st.inputTokens,
    outputTokens: st.outputTokens,
    costUsd: st.costUsd,
  };
}
