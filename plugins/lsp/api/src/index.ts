// @wisp-plugin/lsp-api: the contract of wisp.lsp, language intelligence for the side panel's editor
// (v1 server/lsp.js): a language server per task folder and language, spoken to over stdio.

export type LspOp = 'definition' | 'references' | 'hover' | 'diagnostics' | 'rename' | 'completion';
export const OPS: readonly LspOp[] = ['definition', 'references', 'hover', 'diagnostics', 'rename', 'completion'];

export type Lang = 'ts' | 'py' | 'go' | 'rs';

export interface Hit {
  /** relative to the task's folder, with / */
  path: string;
  line: number;
  col: number;
  /** the line's text, trimmed */
  text: string;
}

export interface Diagnostic {
  line: number;
  col: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
}

/** What POST /sessions/:id/lsp answers; `lsp: null` when no server is installed (the page keeps its text search). */
export type LspAnswer =
  | { lsp: null; lang: Lang | null; install: string | null }
  | { lsp: string; diagnostics: Diagnostic[] }
  | { lsp: string; hover: string }
  | { lsp: string; items: { label: string; detail: string; insert: string }[] }
  | { lsp: string; files: string[]; count: number }
  | { lsp: string; hits: Hit[] };

export interface AskArgs {
  id: string;
  op: LspOp;
  path: string;
  text?: string;
  line?: number;
  col?: number;
  newName?: string;
}

export const COMMANDS = {
  ask: 'lsp.ask', // AskArgs → LspAnswer
  install: 'lsp.install', // { lang } → { ok }
} as const;
