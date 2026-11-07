// @wisp-plugin/terminal-api: the contract of wisp.terminal, the plugin that runs terminals for the
// page. Two kinds, one registry each: a take over (the task's agent on a terminal, v1 app.terms) and a
// shell beside the task (the side panel's, v1 app.shells). Both stream over SSE exactly as v1 did
// (/sessions/:id/term, /sessions/:id/shell). Other plugins reach them through TERMINAL (runtime's take
// over and terminal sessions, the status route's keep-awake count).

import type { ServiceRef } from '@wisp/kernel';
import type { Session } from '@wisp-plugin/runtime-api';

export type TermKind = 'takeover' | 'shell';

/**
 * The shell flow (plan §4.6.3), run on the server: a STOP while starting cancels the start, and an
 * ended terminal never reopens its dead screen (a START from ended or failed starts fresh).
 */
export type TermState = 'idle' | 'starting' | 'slow' | 'running' | 'stopping' | 'ended' | 'failed';

export interface TermInfo {
  id: string;
  kind: TermKind;
  state: TermState;
  cols: number;
  rows: number;
  /** false where the PTY keeps the size it started with (script(1)) */
  resizable: boolean;
  /** the exit code once it ended; null while it runs */
  code: number | null;
  startedAt: number;
  usedAt: number;
  /** pages streaming it now */
  clients: number;
  /** what started it: a terminal session's CLI ('tui') gets follow-ups typed into it */
  tui: boolean;
}

export interface OpenArgs {
  argv: readonly string[];
  cwd: string;
  cols?: number;
  rows?: number;
  /** a terminal session (v1 services/tui.js): follow-ups are typed in, not refused */
  tui?: boolean;
}

/** Numbered input (v1 Terms.input): a page sends keys without waiting, they go in in order. */
export interface InputOrder {
  seq?: number;
  from?: string;
}

export interface TerminalService {
  /** start one, or return the one still running (one per task and kind) */
  open(kind: TermKind, id: string, args: OpenArgs): Promise<TermInfo>;
  get(kind: TermKind, id: string): Promise<TermInfo | null>;
  input(kind: TermKind, id: string, data: string, order?: InputOrder): Promise<boolean>;
  resize(kind: TermKind, id: string, cols: number, rows: number): Promise<boolean>;
  close(kind: TermKind, id: string): Promise<boolean>;
  /** running terminals someone used lately: a cloud computer stays up for them (v1 ACTIVE_MS) */
  active(): Promise<number>;
}

export const TERMINAL: ServiceRef<TerminalService> = {
  id: 'terminal.service',
  major: 1,
  permissions: {
    open: 'terminal:open',
    get: 'session:read',
    input: 'terminal:input',
    resize: 'terminal:input',
    close: 'terminal:close',
    active: 'session:read',
  },
  readOnly: ['get', 'active'],
};

/** Where a task's terminal opens: its worktree, else the project folder (v1 shellDir). */
export interface TaskFolder {
  dir: string;
  /** the folder the task's paths are relative to (worktree root, else cwd) */
  root: string;
  /** its worktree is gone (merged with its branch): the page says so */
  gone: boolean;
}

/**
 * `terminal.folder@1`: who knows where a task works (wisp.worktrees contributes it). Without a
 * contributor, a task works in its session's cwd. The first contributor that answers wins.
 */
export interface FolderSource {
  id: string;
  folder(session: Session): Promise<TaskFolder | null>;
}

export const COMMANDS = {
  open: 'terminal.open', // { kind, id, argv, cwd, cols?, rows?, tui? } → TermInfo
  input: 'terminal.input', // { kind, id, data, seq?, from?, cols?, rows? } → { ok }
  close: 'terminal.close', // { kind, id } → { ok }
  shellStart: 'terminal.shell.start', // { id, cols?, rows?, restart? } → { ok, started, dir?, gone? }
} as const;

export const EVENTS = {
  /** a terminal's state moved: { kind, id, state, code } (the summary's `term` follows takeovers) */
  changed: 'terminal.changed',
} as const;

export const POINTS = {
  folder: 'terminal.folder',
} as const;

/** v1's 409 for a follow-up while the task's agent is open in a terminal. */
export const BUSY_MESSAGE = 'This task is open in a terminal. Carry on there, or end the terminal first.';
