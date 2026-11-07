// Harness, model, thinking level and account (v1 runners.js, runner-picker.js). Pure: what the
// picker lists, what a pick changes, and what is remembered per harness (the saved defaults).

import type { Account, Agent, Model, Row, Runner } from '../types.ts';

/** Auto: wisp picks the harness and model for each task. Its "models" are goals. */
export const AUTO = 'auto';
export const AUTO_GOALS: readonly Model[] = [
  { id: 'balanced', label: 'shell-composer.auto.balanced', hint: 'shell-composer.auto.balanced-hint' },
  { id: 'cheap', label: 'shell-composer.auto.cheap', hint: 'shell-composer.auto.cheap-hint' },
  { id: 'best', label: 'shell-composer.auto.best', hint: 'shell-composer.auto.best-hint' },
];
export const autoAgent = (name: string): Agent => ({ id: AUTO, name, available: true, delegates: true, models: [...AUTO_GOALS], efforts: [] });

/** What's remembered per harness (v1 config defaults: models, efforts, accounts). */
export interface RunnerDefaults {
  readonly agent?: string;
  readonly models?: Readonly<Record<string, string>>;
  readonly efforts?: Readonly<Record<string, string>>;
  readonly accounts?: Readonly<Record<string, string>>;
}

type Agents = readonly Row<Agent>[];

export const agentOf = (agents: Agents, id: string): Row<Agent> | undefined => agents.find((a) => a.id === id);

/** A model's thinking levels, else its harness's ('' first means "as the harness is set"). */
export function effortsFor(agent: Row<Agent> | undefined, model: string): readonly string[] {
  const m = agent?.models?.find((x) => x.id === model);
  return m?.efforts ?? agent?.efforts ?? [];
}

/** The picker's slider stops: Default, then each level. */
export const effortStops = (agent: Row<Agent> | undefined, model: string): readonly string[] => {
  const levels = effortsFor(agent, model);
  return levels.length ? ['', ...levels] : [];
};

/** Accounts only matter once a harness has two or more. */
export const accountsOf = (agent: Row<Agent> | undefined): readonly Row<Account>[] => ((agent?.accounts?.length ?? 0) >= 2 ? (agent?.accounts ?? []) : []);

/** The harness's saved model, level and account, each checked against what it offers now. */
export function savedRunner(agents: Agents, id: string, d: RunnerDefaults): Runner {
  const agent = agentOf(agents, id);
  if (id === AUTO) return { agent: AUTO, model: d.models?.[AUTO] ?? 'balanced', effort: '' };
  const wantModel = d.models?.[id] ?? '';
  const model = agent?.models?.some((m) => m.id === wantModel) ? wantModel : '';
  const wantEffort = d.efforts?.[id] ?? '';
  const effort = effortsFor(agent, model).includes(wantEffort) ? wantEffort : '';
  const wantAccount = d.accounts?.[id] ?? '';
  const account = wantAccount && wantAccount !== AUTO && agent?.accounts?.some((a) => a.id === wantAccount) ? wantAccount : '';
  return { agent: id, model, effort, ...(account && { account }) };
}

/** The harness New task starts on: the saved one, Auto, else the first available, else the first. */
export function initialAgent(agents: Agents, d: RunnerDefaults): string {
  const want = d.agent ?? AUTO;
  if (want === AUTO) return AUTO;
  if (agentOf(agents, want) && agentOf(agents, want)?.available !== false) return want;
  return agents.find((a) => a.available !== false)?.id ?? agents[0]?.id ?? AUTO;
}

/** A model picked: the thinking level carries over if the new model takes it, else the saved one. */
export function withModel(agents: Agents, r: Runner, model: string, d: RunnerDefaults): Runner {
  const levels = effortsFor(agentOf(agents, r.agent), model);
  const saved = d.efforts?.[r.agent] ?? '';
  const effort = levels.includes(r.effort) ? r.effort : levels.includes(saved) ? saved : '';
  return { ...r, model, effort };
}

/** What a pick writes back to the defaults: the model and (if it has levels) the level, per harness. */
export function remembered(agents: Agents, r: Runner, d: RunnerDefaults): RunnerDefaults {
  const agent = agentOf(agents, r.agent);
  const out: RunnerDefaults = { ...d, agent: r.agent, models: { ...d.models, [r.agent]: r.model } };
  const withEfforts = effortsFor(agent, r.model).length ? { ...out, efforts: { ...d.efforts, [r.agent]: r.effort } } : out;
  return accountsOf(agent).length ? { ...withEfforts, accounts: { ...d.accounts, [r.agent]: r.account || AUTO } } : withEfforts;
}

/** The runner as the bar says it: the model ("Default" when none), with the harness when it differs. */
export function runnerParts(agents: Agents, r: Runner): { harness: string; model: string | undefined; effort: string; account: string | undefined } {
  const agent = agentOf(agents, r.agent);
  const model = (r.agent === AUTO ? AUTO_GOALS : (agent?.models ?? [])).find((m) => m.id === r.model && m.id !== '');
  const account = agent?.accounts?.find((a) => a.id === r.account);
  return { harness: agent?.name ?? r.agent, model: model?.label, effort: r.effort, account: account ? accountLabel(account) : undefined };
}

/** An account's name: its label, its email's local part, "Main" for the default. */
export const accountLabel = (a: Row<Account>): string => a.label || a.email?.split('@')[0] || (a.default ? 'Main' : a.id);

/** "X-High" for xhigh, else capitalised; '' is the harness default. */
export const effortKey = (e: string): string => `shell-composer.effort.${e || 'default'}`;

/** The harness rows' sub-line: why it can't be used, or how many models it has. */
export function agentNote(agent: Row<Agent>): { key: string; vars?: Record<string, number> } {
  if (agent.id === AUTO) return { key: 'shell-composer.runner.picks' };
  if (agent.available === false) return { key: 'shell-composer.runner.missing' };
  if (agent.signedIn === false) return { key: 'shell-composer.runner.signed-out' };
  const n = (agent.models ?? []).filter((m) => m.id !== '').length;
  return n ? { key: 'shell-composer.runner.models', vars: { count: n } } : { key: 'shell-composer.runner.default-model' };
}

/** Whether two runners are the same pick. */
export const sameRunner = (a: Runner, b: Runner): boolean => a.agent === b.agent && a.model === b.model && a.effort === b.effort && (a.account ?? '') === (b.account ?? '');
