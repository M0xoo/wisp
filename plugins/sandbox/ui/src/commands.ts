// wisp.sandbox's commands as the app runs them (ADR-0047). Reads say what they wait for; writes the pane makes are
// shown at once where they can be (an env var's name, a sandbox going).
import { defineCommand, type PeerId } from '@wisp/client';

export interface SandboxView {
  readonly machine: string;
  readonly peer: string;
  readonly sandbox: string;
  readonly name: string;
  readonly owner: unknown;
  readonly state: string;
}

export interface Info {
  readonly enabled: boolean;
  readonly why?: string;
  readonly logins: readonly string[];
  readonly env: readonly string[];
  readonly sandboxes: readonly SandboxView[];
}

export interface ClaudeSignIn {
  readonly state: 'idle' | 'waiting' | 'link' | 'done' | 'failed';
  readonly link?: string;
  readonly error?: string;
}

export interface LaunchArgs {
  readonly prompt: string;
  readonly cwd?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly mode?: string;
  readonly goal?: unknown;
}

const none = { optimistic: 'none' as const };
export const info = defineCommand<{ peer: PeerId }, Info>({ id: 'sandbox.info', owner: (a) => a.peer, wire: () => ({}), ...none, pending: 'the Sandboxes pane' });
export const launch = defineCommand<{ peer: PeerId; args: LaunchArgs }, { machine: string; peer: string; task: string; sandbox: string }>({
  id: 'sandbox.launch',
  owner: (a) => a.peer,
  wire: (a) => a.args,
  ...none,
  pending: 'the launching view (its placeholder card shows at once)',
});
export const claudeBegin = defineCommand<{ peer: PeerId }, ClaudeSignIn>({ id: 'sandbox.claude.begin', owner: (a) => a.peer, wire: () => ({}), ...none, pending: 'Sign in' });
export const claudeCode = defineCommand<{ peer: PeerId; code: string }, ClaudeSignIn>({ id: 'sandbox.claude.code', owner: (a) => a.peer, wire: (a) => ({ code: a.code }), ...none, pending: 'Done' });
export const logout = defineCommand<{ peer: PeerId; agent: string }, Info>({ id: 'sandbox.logout', owner: (a) => a.peer, wire: (a) => ({ agent: a.agent }), ...none, pending: 'Sign out' });
export const env = defineCommand<{ peer: PeerId; key: string; value: string }, Info>({
  id: 'sandbox.env',
  owner: (a) => a.peer,
  wire: (a) => ({ key: a.key, value: a.value }),
  ...none,
  pending: 'the env var row',
});
export const drop = defineCommand<{ peer: PeerId; machine: string }, { dropped: number }>({
  id: 'sandbox.drop',
  owner: (a) => a.peer,
  wire: (a) => ({ machine: a.machine }),
  ...none,
  pending: 'the sandbox row',
});
/** Codex's device login, run on the sandbox's own wisp (its peer). */
export const codexLogin = defineCommand<{ peer: PeerId }, { url?: string; code?: string; state?: string }>({
  id: 'accounts.login.start',
  owner: (a) => a.peer,
  wire: () => ({ agent: 'codex' }),
  ...none,
  pending: 'Sign in to Codex there',
});
