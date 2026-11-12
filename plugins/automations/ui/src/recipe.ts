// A recipe as Save as recipe… starts it (v1 saveAsRecipe: the task's title and first prompt, its mode and runner),
// and the `{field}`s its prompt asks for when it's run (v1 recipeParams). DOM-free.

export interface RecipeDraft {
  readonly name: string;
  readonly prompt: string;
  /** a project's folder; '' = whichever project it's run in */
  readonly project?: string;
  /** '' = the launcher's default */
  readonly mode?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly effort?: string;
  /** the task it's saved from (an entity key): its first prompt is read when the editor opens */
  readonly session?: string;
}

export function parseDraft(p: unknown): RecipeDraft {
  const o = (p ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
  return { name: s('name'), prompt: s('prompt'), project: s('project'), mode: s('mode'), agent: s('agent'), model: s('model'), effort: s('effort'), ...(s('session') && { session: s('session') }) };
}

/** `{version}` and `{name}`, once each, in order; not `{ }` or `{1x}` */
export function recipeParams(prompt: string): string[] {
  const out: string[] = [];
  for (const m of prompt.matchAll(/\{([A-Za-z_][\w-]*)\}/g)) if (m[1] && !out.includes(m[1])) out.push(m[1]);
  return out;
}

/** The draft from a task: its title, its first prompt, its mode and runner (v1 saveAsRecipe). */
export function draftOf(task: { readonly title?: string; readonly mode?: string; readonly agent?: string; readonly model?: string; readonly effort?: string }, firstPrompt: string): RecipeDraft {
  return { name: (task.title ?? '').slice(0, 60), prompt: firstPrompt, project: '', mode: task.mode ?? '', agent: task.agent ?? '', model: task.model ?? '', effort: task.effort ?? '' };
}
