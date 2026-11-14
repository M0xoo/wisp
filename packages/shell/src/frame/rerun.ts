// Rerun… (v1 actions.js rerunDialog, F-task-43/44; ADR-0027: a rerun is the task's spec run again): a new task from
// this one's spec (`runtime.spec`: its first prompt, harness, model, thinking, mode, folder, extra folders, the steps
// after), with what you changed in the dialog, on the computer you pick. The old task is kept as it is. DOM-free.

export interface RerunSpec {
  readonly prompt: string;
  readonly steps?: readonly string[];
  readonly agent?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
  readonly cwd?: string;
  readonly dirs?: readonly string[];
}

export interface RerunEdits {
  readonly prompt: string;
  readonly mode: string;
  readonly agent: string;
  readonly model: string;
  readonly effort: string;
  /** the computer it runs on (a peer); the task's own when unchanged */
  readonly peer: string;
}

/** What the dialog starts with: as it ran (a harness picked from the toolbar's menu wins). */
export const startEdits = (s: RerunSpec, peer: string, agent?: string): RerunEdits => ({
  prompt: s.prompt,
  mode: s.mode || 'auto',
  agent: agent ?? s.agent ?? '',
  model: agent && agent !== s.agent ? '' : (s.model ?? ''),
  effort: agent && agent !== s.agent ? '' : (s.effort ?? ''),
  peer,
});

/** `runtime.create`'s args (the shell's create command): a new task, its lineage pointing at the one rerun. */
export function rerunArgs(s: RerunSpec, e: RerunEdits, o: { readonly of: string; readonly id: string; readonly at: number }) {
  return {
    peer: e.peer,
    id: o.id,
    prompt: e.prompt.trim(),
    agent: e.agent || 'auto',
    mode: e.mode,
    at: o.at,
    ...(e.model && { model: e.model }),
    ...(e.effort && { effort: e.effort }),
    ...(s.cwd && { cwd: s.cwd }),
    ...(s.dirs?.length && { dirs: [...s.dirs] }),
    ...(s.steps?.length && { steps: [...s.steps] }),
    lineage: { rerunOf: o.of },
  };
}
