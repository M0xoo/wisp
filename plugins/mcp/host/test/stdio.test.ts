// The stdio bridge, the port of v1 test/mcp-gone.test.js: wisp's MCP server sits between a harness and
// wisp, and when either goes the wait must end. The harness closing its pipe ends the bridge and every
// call it carries; a wisp that refuses or is gone ends each call with v1's words for that tool.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { goneAnswer, serveStdio } from '../src/stdio.ts';
import { tick } from './fake.ts';

function bridge(post: (line: string, signal: AbortSignal) => Promise<string>) {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies = new Map<unknown, Record<string, unknown>>();
  let buf = '';
  output.on('data', (d: Buffer) => {
    buf += String(d);
    for (let i; (i = buf.indexOf('\n')) >= 0; buf = buf.slice(i + 1)) {
      const r = JSON.parse(buf.slice(0, i)) as Record<string, unknown>;
      replies.set(r['id'], r);
    }
  });
  const { closed } = serveStdio({ input, output, post });
  const call = (id: number, name: string, args: unknown = {}) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`);
  const reply = async (id: number) => {
    for (let i = 0; i < 200 && !replies.has(id); i++) await tick(5);
    return replies.get(id);
  };
  return { input, call, reply, closed };
}
const textOf = (r: Record<string, unknown> | undefined): string => ((r?.['result'] as { content: { text: string }[] }).content[0]?.text ?? '');

test('the harness goes while a question waits: the bridge ends, and so does the wait inside wisp', async () => {
  const aborted: boolean[] = [];
  const b = bridge((_line, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => (aborted.push(true), reject(new Error('aborted'))))));
  b.call(1, 'ask_user', { question: 'q?' });
  await tick(10);
  b.input.end(); // what a killed harness leaves: the pipe's far end closed
  await b.closed;
  assert.deepEqual(aborted, [true], 'the pending call was aborted, so wisp stops waiting on it');
});

test('a wisp that refuses the token is not this run\'s wisp: each wait ends, in v1 words', async () => {
  const b = bridge(async () => {
    throw new Error('wisp 403: {"error":"bad token"}');
  });
  b.call(1, 'ask_user', { question: 'q?' });
  b.call(2, 'approve', { tool_name: 'Bash', input: {}, tool_use_id: 'u' });
  b.call(3, 'delegate', { tasks: [{ prompt: 'x' }] });
  const [asked, approved, delegated] = await Promise.all([b.reply(1), b.reply(2), b.reply(3)]);
  assert.match(textOf(asked), /did not answer/);
  assert.equal(JSON.parse(textOf(approved)).behavior, 'deny', 'the gate fails closed');
  assert.equal((delegated?.['result'] as { isError?: boolean }).isError, true);
  assert.match(textOf(delegated), /403/);
  b.input.end();
  await b.closed;
});

test('a wisp that answers: its line comes back as it is', async () => {
  const b = bridge(async (line) => {
    const m = JSON.parse(line) as { id: number };
    return JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'The user answered: yes' }] } });
  });
  b.call(1, 'ask_user', { question: 'q?' });
  assert.equal(textOf(await b.reply(1)), 'The user answered: yes');
  b.input.end();
  await b.closed;
});

test('a notification and a line that is not JSON get no answer', () => {
  assert.equal(goneAnswer('{"jsonrpc":"2.0","method":"notifications/initialized"}', new Error('x')), '');
  assert.equal(goneAnswer('nope', new Error('x')), '');
});
