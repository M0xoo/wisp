import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerMessage } from '@wisp/protocol';
import { SseParser, decodeFrame, encodeFrame, heartbeat, retryField } from '../src/sse.ts';
import { rng } from './harness.ts';

const MSGS: ServerMessage[][] = [
  [{ t: 'patch', seq: 7, ops: [{ topic: 'list', e: 'session', id: 's1', op: 'patch', ops: [{ op: 'replace', path: '/title', value: 'a\nb\r\nc\rd' }] }] }],
  [{ t: 'notice', kind: 'toast', data: { text: 'héllo 👋   done', nul: '\u0000' } }],
  [{ t: 'resync', topic: 'session:x' }, { t: 'ack', mid: 'm1', seq: 9 }],
  [{ t: 'rows', req: 'r', rows: [{ e: 'event', id: '1', v: 'x'.repeat(5000) }], done: true }],
];

test('a frame is one id, one event, one line of JSON', () => {
  const f = encodeFrame(42, MSGS[0] as ServerMessage[]);
  const lines = f.split('\n');
  assert.deepEqual(lines.slice(0, 2), ['id: 42', 'event: sync']);
  assert.ok(lines[2]?.startsWith('data: ['));
  assert.deepEqual(lines.slice(3), ['', '']);
  assert.equal(heartbeat(), ': hb\n\n');
  assert.equal(retryField(2000.7), 'retry: 2000\n\n');
});

function stream(lineEnd: string): { text: string; want: { id: number | null; messages: ServerMessage[] }[] } {
  let text = `﻿${retryField(1500)}${heartbeat()}`;
  const want: { id: number | null; messages: ServerMessage[] }[] = [];
  MSGS.forEach((m, i) => {
    text += encodeFrame(10 + i, m) + heartbeat();
    want.push({ id: 10 + i, messages: m });
  });
  return { text: text.replace(/\n/g, lineEnd), want };
}

function parseAll(chunks: (string | Uint8Array)[]): { frames: ReturnType<typeof decodeFrame>[]; parser: SseParser } {
  const parser = new SseParser();
  const frames = chunks.flatMap((c) => parser.push(c)).map(decodeFrame);
  return { frames, parser };
}

test('parses LF, CRLF and CR streams, whole or split at every byte', () => {
  for (const end of ['\n', '\r\n', '\r']) {
    const { text, want } = stream(end);
    const whole = parseAll([text]);
    assert.deepEqual(whole.frames, want, JSON.stringify(end));
    assert.equal(whole.parser.retry, 1500);
    assert.equal(whole.parser.lastEventId, String(10 + MSGS.length - 1));
    // one char at a time: every CR sits at the end of a chunk once
    assert.deepEqual(parseAll([...text]).frames, want);
  }
});

test('fuzz: random chunk splits of bytes (UTF-8 cut mid-sequence) decode the same', () => {
  const r = rng(99);
  for (const end of ['\n', '\r\n', '\r']) {
    const { text, want } = stream(end);
    const bytes = new TextEncoder().encode(text);
    for (let round = 0; round < 300; round++) {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; ) {
        const n = 1 + Math.floor(r() * (r() < 0.5 ? 4 : 400));
        chunks.push(bytes.subarray(i, i + n));
        i += n;
      }
      assert.deepEqual(parseAll(chunks).frames, want);
    }
  }
});

test('the spec corners: multi-line data, no space after the colon, unknown fields, id with NUL', () => {
  const p = new SseParser();
  const out = p.push('data:a\ndata: b\nfoo: bar\nid: 5\n\nid: x\0y\nevent: e\ndata: c\n\ndata\n\n: only a comment\n\n');
  assert.deepEqual(out, [
    { id: '5', event: 'message', data: 'a\nb' },
    { id: '5', event: 'e', data: 'c' },
    { id: '5', event: 'message', data: '' },
  ]);
  assert.equal(decodeFrame({ id: '1', event: 'sync', data: '{not json' }), null);
  assert.equal(decodeFrame({ id: '1', event: 'other', data: '[]' }), null);
  assert.deepEqual(decodeFrame({ id: '', event: 'sync', data: '[{"t":"resync","topic":"list"},3]' }), { id: null, messages: [{ t: 'resync', topic: 'list' }] });
});

test('an event without its blank line yet is held, not dispatched', () => {
  const p = new SseParser();
  assert.deepEqual(p.push('id: 1\nevent: sync\ndata: []\n'), []);
  assert.equal(p.push('\n').length, 1);
});

test('a frame made from cached op JSON is byte for byte the plain one', () => {
  const op = { topic: 'list' as const, e: 'session', id: 's1', op: 'upsert' as const, v: { title: 'a "q" \n', n: undefined } };
  const other = { topic: 'list' as const, e: 'session', id: 's2', op: 'del' as const };
  const cache = new WeakMap([[op, JSON.stringify(op)]]);
  const msgs: ServerMessage[] = [{ t: 'ack', mid: 'm', seq: 3 }, { t: 'patch', seq: 3, ops: [op, other] }, ...(MSGS[1] as ServerMessage[])];
  assert.equal(encodeFrame(3, msgs, cache), encodeFrame(3, msgs));
});
