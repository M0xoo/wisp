// Where a turn's tokens went, beside its receipt (v1 receipt.js subagentParts / subagentTip, 0.57.0): when Claude Code
// ran its own subagents, the type that wrote most ("3 Explore agents · Haiku 4.5 · 27k of 41k output"), and in the
// tip every type and the tokens per model (the run's modelUsage: runtime's `stats.models`; each Agent call's
// messages: `stats.subagents`, most output first). DOM-free.
import { modelWords } from '@wisp/shell/pure';
import { tokenWords, type T } from './model.ts';

type Counts = { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheWrite?: number };
export interface SubagentStat {
  readonly type: string;
  readonly calls: number;
  readonly read?: number;
  /** 0: not known apart from the main thread's */
  readonly output?: number;
  readonly model?: string;
}
export interface AgentStats {
  readonly outputTokens?: number;
  readonly models?: Readonly<Record<string, Counts>>;
  readonly subagents?: readonly SubagentStat[];
}

const n = (x: number | undefined): number => (Number.isFinite(x) && (x ?? 0) > 0 ? (x ?? 0) : 0);

/** All the output the turn wrote, its subagents' in (modelUsage has them; outputTokens is the main thread's alone). */
export function turnOutput(st: AgentStats): number {
  const models = Object.values(st.models ?? {}).reduce((a, m) => a + n(m.output), 0);
  const subs = (st.subagents ?? []).reduce((a, x) => a + n(x.output), 0);
  return Math.max(models, n(st.outputTokens) + subs);
}

const agentsWord = (x: SubagentStat, t: T): string => t(x.calls === 1 ? 'shell-task.agents.one' : 'shell-task.agents.other', { n: x.calls, type: x.type });

/** The line and its tip, or null when no subagent ran. */
export function agentsOf(st: AgentStats | null | undefined, t: T): { parts: string[]; tip: string } | null {
  const x = st?.subagents?.[0];
  if (!st || !x) return null;
  const total = turnOutput(st);
  const out = n(x.output);
  const parts = [agentsWord(x, t), x.model ? modelWords(x.model) : '', out && total ? t('shell-task.agents.output', { n: tokenWords(out), of: tokenWords(total) }) : ''].filter(Boolean);
  const subs = (st.subagents ?? []).map((s) =>
    t(n(s.output) && total ? 'shell-task.agents.tipOne' : 'shell-task.agents.tipRead', {
      agents: s.model ? t('shell-task.agents.on', { agents: agentsWord(s, t), model: modelWords(s.model) }) : agentsWord(s, t),
      n: tokenWords(n(s.output)),
      of: tokenWords(total),
      read: tokenWords(n(s.read)),
    }),
  );
  // most output first, as v1's list came (the map is by name)
  const models = Object.entries(st.models ?? {})
    .sort((a, b) => n(b[1].output) - n(a[1].output))
    .map(([id, m]) => t('shell-task.agents.model', { model: modelWords(id), out: tokenWords(n(m.output)), in: tokenWords(n(m.input) + n(m.cacheRead) + n(m.cacheWrite)) }));
  const tip = [t('shell-task.agents.tipSubs', { list: subs.join('; ') }), models.length ? t('shell-task.agents.tipModels', { list: models.join(', ') }) : ''].filter(Boolean).join('. ');
  return { parts, tip };
}
