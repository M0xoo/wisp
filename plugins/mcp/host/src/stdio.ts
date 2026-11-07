// The stdio bridge a harness spawns when it takes only stdio MCP servers (`wisp mcp-ask`, and `wisp mcp`
// for the user's editors). Each line goes to wisp as one POST /api/mcp (the edge wires `post` to it, with
// the run's token); its answer comes back as one line. Nothing is decided here, so the bridge holds no
// state a restart could lose, and when either side goes the wait ends (v1 mcp-gone):
//   - the harness closes stdin: every pending post is aborted and `closed` resolves (the bin exits);
//   - wisp refuses or can't be reached: the call ends with v1's words for it.

import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { asMessage } from './rpc.ts';

export interface StdioOptions {
  input: Readable;
  output: Writable;
  /** sends one JSON-RPC line to wisp; resolves to its answer ('' for none), rejects when wisp can't answer */
  post(line: string, signal: AbortSignal): Promise<string>;
}

const answerLine = (id: unknown, result: unknown): string => `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`;

function safeParse(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** What a call says when wisp can't answer it: v1's words, per tool ('' for a notification). */
export function goneAnswer(line: string, err: unknown): string {
  const msg = asMessage(safeParse(line));
  if (!msg || msg.id === undefined) return '';
  const why = err instanceof Error ? err.message : String(err);
  const name = msg.method === 'tools/call' ? String(msg.params?.name ?? '') : '';
  if (name === 'ask_user') return answerLine(msg.id, { content: [{ type: 'text', text: 'The user did not answer (the question was cancelled). Use your best judgment and note the assumption.' }] });
  if (name === 'approve') return answerLine(msg.id, { content: [{ type: 'text', text: JSON.stringify({ behavior: 'deny', message: `wisp could not reach the user: ${why}` }) }] });
  return answerLine(msg.id, { isError: true, content: [{ type: 'text', text: `wisp: ${why}` }] });
}

/** Serves until the input closes; resolves then, with every pending call aborted. */
export function serveStdio(o: StdioOptions): { closed: Promise<void> } {
  const ac = new AbortController();
  const lines = createInterface({ input: o.input });
  const write = (s: string): void => {
    if (s && !ac.signal.aborted) o.output.write(s.endsWith('\n') ? s : `${s}\n`);
  };
  lines.on('line', (line) => {
    if (!line.trim() || safeParse(line) === null) return; // not JSON: v1 dropped it too
    o.post(line, ac.signal).then(write, (err: unknown) => write(goneAnswer(line, err)));
  });
  const closed = new Promise<void>((resolve) => {
    lines.once('close', () => {
      ac.abort(new Error('the harness went'));
      resolve();
    });
  });
  return { closed };
}
