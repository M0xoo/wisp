// The coding agents as the screens name and mark them: what the harness plugins register (contract
// PluginUiDef.harnesses), never a list of the shell's own (ADR-0003). An agent no plugin describes is
// shown by its id; a new task runs on the default one (the first registered default, else the first).

import type { HarnessUiDef } from '../contract.ts';

export interface HarnessView {
  readonly name: string;
  readonly logo?: string;
}

export function harnessOf(all: readonly HarnessUiDef[], id: string): HarnessView {
  const h = all.find((x) => x.id === id);
  return h ? { name: h.name, ...(h.logo && { logo: h.logo }) } : { name: id };
}

export const defaultHarness = (all: readonly HarnessUiDef[]): string | undefined => (all.find((h) => h.default) ?? all[0])?.id;
