/** The view `/sandbox` opens at once: a placeholder for the task while its sandbox comes up. */
export const LAUNCHING = 'sandbox.launching';

export interface LaunchingParams {
  /** one launch, once: a view shown again doesn't start another */
  readonly id: string;
  readonly prompt: string;
  readonly launch: Readonly<Record<string, unknown>>;
}

/** The view's params from navigation; anything else isn't this view's (thrown: the shell lands on Home). */
export function parseLaunching(p: unknown): LaunchingParams {
  const o = (p ?? {}) as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || typeof o['prompt'] !== 'string') throw new Error('sandbox.launching: { id, prompt, launch }');
  const launch = typeof o['launch'] === 'object' && o['launch'] !== null ? (o['launch'] as Record<string, unknown>) : {};
  return { id: o['id'], prompt: o['prompt'], launch };
}
