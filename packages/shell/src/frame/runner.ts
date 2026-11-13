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
  /** false: installed but signed out (runtime.agents `signedIn`); the picker offers its sign-in */
  readonly signedIn?: boolean | null;
  readonly models: readonly AgentModel[];
  readonly efforts: readonly string[];
}
export interface Runner {
  readonly agent: string;
  /** '' : the harness's default */
  readonly model: string;
  /** '' : the harness's default */
  readonly effort: string;
  /** one of the harness's accounts (wisp.accounts' `accounts.list` id); unset or '': Auto, your saved one */
  readonly account?: string;
  /** that account's name, for the bar's words (not sent) */
  readonly accountLabel?: string;
}

/** One of a harness's accounts as `accounts.list` gives it (wisp.accounts' AccountView). */
export interface AccountOffer {
  readonly id: string;
  readonly label: string;
  readonly email?: string;
  readonly plan?: string;
  readonly default?: boolean;
  readonly state?: 'ready' | 'limit' | 'signedOut';
  readonly until?: number | null;
}

/** The account choice under the models (v1 runner-picker.js paintAccounts): Auto, then each account in your order,
 * only when the harness has two or more. A signed-out one can't be picked; one at its limit can (wisp never
 * switches for you), and says so. */
export function accountChoices(
  accounts: readonly AccountOffer[],
  words: { readonly auto: string; readonly autoHint: string; readonly limit: string; readonly out: string },
): { value: string; label: string; hint?: string; disabled?: boolean }[] {
  if (accounts.length < 2) return [];
  return [
    { value: '', label: words.auto, hint: words.autoHint },
    ...accounts.map((a) => {
      const line = [a.email, a.plan].filter(Boolean).join(' · ');
      if (a.state === 'signedOut') return { value: a.id, label: a.label, hint: words.out, disabled: true };
      if (a.state === 'limit') return { value: a.id, label: a.label, hint: words.limit };
      return { value: a.id, label: a.label, ...(line && { hint: line }) };
    }),
  ];
}

/** The account a task starts on: the pick while it's still one of the harness's and signed in, else Auto (''). */
export function accountFor(accounts: readonly AccountOffer[], want: string | undefined): string {
  if (!want || accounts.length < 2) return '';
  const a = accounts.find((x) => x.id === want);
  return a && a.state !== 'signedOut' ? a.id : '';
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
  // a signed-out one can be picked to sign in, so it sits with the set-up ones
  const usable = (a: AgentOffer): number => Number(a.available || a.signedIn === false);
  return agents.filter(hit).sort((a, b) => usable(b) - usable(a));
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
  return [name(r.agent), model, r.effort, r.account ? (r.accountLabel ?? r.account) : ''].filter(Boolean).join(' · ');
}

/** A reply's own harness · model (the reply box's pick) as runtime.followUp's `run`; none: the task's own. */
export function runPick(r: Runner | undefined): { agent: string; model?: string; effort?: string } | undefined {
  return r ? { agent: r.agent, ...(r.model && { model: r.model }), ...(r.effort && { effort: r.effort }) } : undefined;
}

/** A plan's usage window as `budget.view` gives it (0–1 used). */
export interface PlanWindow {
  readonly label: string;
  readonly used: number;
  readonly resetsAt?: number | null;
}

/** How much of a harness's plan is gone (v1 runner-picker.js fullest): its fullest window over its accounts. */
export function fullest(accounts: readonly { readonly windows: readonly PlanWindow[] }[]): PlanWindow | undefined {
  let out: PlanWindow | undefined;
  for (const a of accounts) for (const w of a.windows) if (Number.isFinite(w.used) && (!out || w.used > out.used)) out = w;
  return out;
}

/** v1's quiet line under a harness: "5h 42% used" (whole percents, rounded down). */
export const usedPct = (w: PlanWindow): number => Math.floor(w.used * 100);
