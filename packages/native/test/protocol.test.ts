import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encode, parseEvent } from '../src/protocol.ts';

test('events the helper sends parse, as the Rust side serializes them', () => {
  // These lines are what native/crates/wisp-native/src/protocol.rs's tests pin down.
  assert.deepEqual(parseEvent('{"type":"exit","id":"a","code":null,"signal":"SIGTERM"}'), { type: 'exit', id: 'a', code: null, signal: 'SIGTERM' });
  assert.deepEqual(parseEvent('{"type":"data","id":"a","stream":"stdout","data":"aGk="}'), { type: 'data', id: 'a', stream: 'stdout', data: 'aGk=' });
  assert.deepEqual(parseEvent('{"type":"killed","id":"a","signalled":3,"survivors":0}'), { type: 'killed', id: 'a', signalled: 3, survivors: 0 });
  const hello = parseEvent('{"type":"hello","protocol":1,"version":"0.1.0","pid":9,"platform":"macos","arch":"aarch64"}');
  assert.equal(hello?.type, 'hello');
  const list = parseEvent('{"type":"list","ref":"l1","items":[{"id":"p1","pid":4,"pty":true,"exited":false}]}');
  assert.equal(list?.type === 'list' && list.items[0]?.pid, 4);
});

test('anything that is not a well-formed event is null, never a throw', () => {
  for (const line of ['', 'not json', '[]', 'null', '{"type":"nope"}', '{"type":"started","id":"a"}', '{"type":"data","id":"a","stream":"stdin","data":""}', '{"type":"error","code":"made_up","message":"x","retry":false}', '{"type":"exit","id":"a","code":"0","signal":null}', '{"type":"list","items":[{"id":1}]}', '{"type":"toString"}']) {
    assert.equal(parseEvent(line), null, line);
  }
});

test('requests are one line each', () => {
  const line = encode({ type: 'spawn', id: 'p1', cmd: 'sh', args: ['-c', 'echo "a\nb"'], pty: { cols: 80, rows: 24 } });
  assert.equal(line.indexOf('\n'), line.length - 1);
  assert.deepEqual(JSON.parse(line), { type: 'spawn', id: 'p1', cmd: 'sh', args: ['-c', 'echo "a\nb"'], pty: { cols: 80, rows: 24 } });
});
