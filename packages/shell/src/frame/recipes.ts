// New task's Recipes row (v1 launcher.js renderLaunchRecipes, F-comp-37): the recipes (wisp.automations' declared
// tasks, `automations.tasks`) for the picked project and the ones tied to none, each a chip with its prompt as the
// tip and a "…" when it asks for fields. A click opens its run dialog (`automations.run`, never a launch outright);
// without wisp.automations the row says what it always did and the dialog isn't there.
import { createResource } from 'solid-js';
import { defineCommand, type Json } from '@wisp/client';
import type { LauncherRecipe } from '@wisp/ui';
import type { ShellContext } from '../contract.ts';

export interface RecipeRow {
  readonly name: string;
  readonly prompt: string;
  readonly steps?: readonly string[];
  readonly project?: string;
}

const list = defineCommand<{ peer: string }, RecipeRow[]>({ id: 'automations.tasks', owner: (a) => a.peer, wire: () => ({}), optimistic: 'none', pending: 'the recipes' });

const asksFields = (r: RecipeRow): boolean => [r.prompt, ...(r.steps ?? [])].some((x) => /\{[A-Za-z_][\w-]*\}/.test(x));

/** The row's recipes for the project at `path` (undefined: No folder) and how many are elsewhere. */
export function recipesAt(all: readonly RecipeRow[], path: string | undefined): { list: RecipeRow[]; elsewhere: number } {
  const here = all.filter((r) => !r.project || r.project === path);
  return { list: here, elsewhere: all.length - here.length };
}

/** The row's chips, and the empty line's words (v1: "None for this project · 2 elsewhere"). */
export function useRecipes(shell: ShellContext, peer: () => string, path: () => string | undefined): { items: () => LauncherRecipe[]; empty: () => string } {
  const [all] = createResource(peer, (p) => shell.client.commands.run(list, { peer: p }).catch(() => [] as RecipeRow[]));
  const at = (): { list: RecipeRow[]; elsewhere: number } => recipesAt(all() ?? [], path());
  const open = (name: string): void =>
    shell.navigate({ t: 'openOverlay', overlay: { kind: 'dialog', id: 'automations.run' as never, params: { name, project: path() ?? '' } as Json } });
  return {
    items: () =>
      at().list.map((r) => ({
        id: r.name,
        label: r.name,
        title: r.prompt.replace(/\s+/g, ' ').slice(0, 200),
        fields: asksFields(r),
        act: { onClick: () => open(r.name) },
      })),
    empty: () => (at().elsewhere > 0 ? shell.t('shell.home.recipesElsewhere', { n: at().elsewhere }) : shell.t('shell.home.recipesEmpty')),
  };
}
