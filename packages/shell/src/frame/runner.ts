// The harness · model picker's data (v1 runner-picker.js), DOM-free: what each harness offers (runtime.agents), the
// models matching what's typed (by label or id, the harness's name too), and the thinking levels the pick allows.

export interface AgentModel {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly efforts?: readonly string[];
}
export interface AgentOffer {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly models: readonly AgentModel[];
  readonly efforts: readonly string[];
}
export interface Runner {
  readonly agent: string;
  /** '' : the harness's default */
  readonly model: string;
  /** '' : the harness's default */
  readonly effort: string;
}

/** The models to show for `agent`, the Default first, narrowed by `query` (the harness's own name matches all). */
export function modelsFor(agents: readonly AgentOffer[], agent: string, query: string): AgentModel[] {
  const a = agents.find((x) => x.id === agent);
  if (!a) return [];
  const all = [{ id: '', label: 'Default' }, ...a.models.filter((m) => m.id !== '')];
  const q = query.trim().toLowerCase();
  if (!q || a.name.toLowerCase().includes(q)) return all;
  return all.filter((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
}

/** Harnesses whose name or a model matches `query` (all of them when it's empty); set up ones first. */
export function harnessesFor(agents: readonly AgentOffer[], query: string): AgentOffer[] {
  const q = query.trim().toLowerCase();
  const hit = (a: AgentOffer): boolean => !q || a.name.toLowerCase().includes(q) || a.models.some((m) => m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q));
  return agents.filter(hit).sort((a, b) => Number(b.available) - Number(a.available));
}

/** The thinking levels of a pick: the model's own, else the harness's. */
export function effortsFor(agents: readonly AgentOffer[], r: Runner): readonly string[] {
  const a = agents.find((x) => x.id === r.agent);
  if (!a) return [];
  const m = a.models.find((x) => x.id === r.model);
  return m?.efforts?.length ? m.efforts : a.efforts;
}

/** The bar's words: "Claude Code · Opus", "Codex" (its default model), with the thinking level when set. */
export function runnerWords(agents: readonly AgentOffer[], r: Runner, name: (id: string) => string): string {
  const a = agents.find((x) => x.id === r.agent);
  const model = a?.models.find((m) => m.id === r.model)?.label ?? (r.model || '');
  return [name(r.agent), model, r.effort].filter(Boolean).join(' · ');
}

/** A reply's own harness · model (the reply box's pick) as runtime.followUp's `run`; none: the task's own. */
export function runPick(r: Runner | undefined): { agent: string; model?: string; effort?: string } | undefined {
  return r ? { agent: r.agent, ...(r.model && { model: r.model }), ...(r.effort && { effort: r.effort }) } : undefined;
}
