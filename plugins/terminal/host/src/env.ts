// The environment a terminal starts with (v1 server/pty.js).

/**
 * What a Claude Code session that started wisp (`npm run dev:web` from its terminal) leaves in the
 * environment. An interactive claude that inherits them thinks it's that session's child and keeps no
 * transcript, so the conversation can't be resumed. Only these: CLAUDE_CODE_USE_BEDROCK and such are
 * the user's own settings.
 */
export const PARENT_SESSION_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_PID'] as const;

/**
 * Settings that make Claude Code spend extra model calls on wisp's behalf (progress summaries of its
 * subagents). wisp never asks for them, so an exported value doesn't reach the CLIs it starts.
 */
export const COSTLY_ENV = ['CLAUDE_CODE_AGENT_PROGRESS_SUMMARIES'] as const;

export type Env = Record<string, string | undefined>;

/** A take over drops the costly settings too; a shell beside the task is the user's own and keeps them. */
export function termEnv(base: Env, takeover: boolean): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;
  Object.assign(env, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'wisp' });
  delete env['NO_COLOR'];
  for (const k of PARENT_SESSION_ENV) delete env[k];
  if (takeover) for (const k of COSTLY_ENV) delete env[k];
  return env;
}

/** The user's login shell, started as one so their PATH and prompt come with it. */
export const shellArgv = (env: Env): string[] => [env['SHELL'] || '/bin/sh', '-l'];

/** Whether this computer can run a terminal for the page at all (no pty on Windows). */
export const ptySupported = (platform: string): boolean => platform !== 'win32';
