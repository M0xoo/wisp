import { describe, expect, test } from 'vitest';
import { FOLD_AT, KEEP, byTurn, commandOf, counts, duration, endOf, finalAnswer, keptOpen, layout, messageText, promptIsLong, stepsOf, ticker, viewOf, type Step } from '../src/transcript/model.ts';
import type { Activity, EventRow } from '../src/types.ts';

let n = 0;
const ev = (turn: string, a: Activity): EventRow => ({ ...a, seq: ++n, session_id: 's1', turn_id: turn, at: n * 1000 }) as EventRow;
const tool = (turn: string, label: string, extra: Partial<Extract<Activity, { kind: 'tool' }>> = {}): EventRow => ev(turn, { kind: 'tool', tool: 'read', label, ...extra });
const text = (turn: string, t: string): EventRow => ev(turn, { kind: 'text', text: t });

describe('byTurn', () => {
  test('groups events by turn, oldest first', () => {
    const es = [text('a', 'x'), tool('b', 'r'), text('a', 'y')];
    const g = byTurn(es);
    expect(g.get('a')?.map((e) => e.seq)).toEqual([es[0]?.seq, es[2]?.seq]);
    expect(g.get('b')?.length).toBe(1);
  });
  test('a turn whose events did not change keeps its array, so only the turn that grew repaints', () => {
    const a1 = text('a', 'one');
    const b1 = text('b', 'two');
    const first = byTurn([a1, b1]);
    const b2 = { ...b1, text: 'two more' } as EventRow;
    const next = byTurn([a1, b2], first);
    expect(next.get('a')).toBe(first.get('a'));
    expect(next.get('b')).not.toBe(first.get('b'));
  });
  test('property: grouping then concatenating in turn order gives back every event once', () => {
    for (let round = 0; round < 50; round++) {
      const es: EventRow[] = [];
      for (let i = 0; i < 40; i++) es.push(text(`t${(i * 7 + round) % 5}`, `m${i}`));
      const g = byTurn(es);
      const total = [...g.values()].reduce((s, l) => s + l.length, 0);
      expect(total).toBe(es.length);
      for (const list of g.values()) for (let i = 1; i < list.length; i++) expect((list[i]?.seq ?? 0) > (list[i - 1]?.seq ?? 0)).toBe(true);
    }
  });
});

describe('final answer and steps', () => {
  test('the trailing messages the turn text holds leave the timeline', () => {
    const es = [text('t', 'Looking at the route'), tool('t', 'Reading login.ts'), text('t', 'Done: added the limiter.\n```wisp\n{}\n```')];
    const turn = { text: 'Done: added the limiter.\n```wisp\n{}\n```', status: 'done' as const };
    expect([...finalAnswer(turn, es)]).toEqual([es[2]?.seq]);
    expect(stepsOf(turn, es).map((s) => s.k)).toEqual(['msg', 'tool']);
  });
  test("wisp's note after the answer doesn't break the run; a running turn keeps every message", () => {
    const es = [text('t', 'The answer'), ev('t', { kind: 'notice', text: 'Tests passed' })];
    expect(finalAnswer({ text: 'The answer', status: 'done' }, es).size).toBe(1);
    expect(finalAnswer({ text: 'The answer', status: 'running' }, es).size).toBe(0);
  });
  test('tool output joins its call by callId; a message that is only the presentation is not a step', () => {
    const es = [tool('t', 'Running tests', { tool: 'run', callId: 'c1', detail: 'npm test' }), ev('t', { kind: 'tool_output', callId: 'c1', text: 'ok 1\n' }), ev('t', { kind: 'tool_output', callId: 'c1', text: 'ok 2\n' }), text('t', '```wisp\n{}')];
    const steps = stepsOf({ status: 'running' }, es);
    expect(steps.length).toBe(1);
    expect(steps[0]?.k === 'tool' && steps[0].output).toBe('ok 1\nok 2\n');
  });
  test('messageText cuts the wisp block a message ends with', () => {
    expect(messageText('Here it is.\n```wisp\n{"blocks":[]}')).toBe('Here it is.');
    expect(messageText('plain')).toBe('plain');
  });
  test('commandOf shows the command unless the label already is it', () => {
    const [a, b] = stepsOf({ status: 'running' }, [tool('t', 'Running the tests', { tool: 'run', detail: 'npm   test' }), tool('t', 'npm test', { tool: 'run', detail: 'npm test' })]);
    expect(a && commandOf(a)).toBe('npm test');
    expect(b && commandOf(b)).toBe('');
  });
});

describe('layout', () => {
  const steps = (k: number): Step[] => stepsOf({ status: 'running' }, Array.from({ length: k }, (_, i) => tool('t', `step ${i}`)));
  test(`a run of ${FOLD_AT} or fewer steps shows whole; longer keeps ${KEEP} at each end`, () => {
    expect(layout(steps(FOLD_AT)).length).toBe(FOLD_AT);
    const rows = layout(steps(20));
    expect(rows.length).toBe(KEEP * 2 + 1);
    const fold = rows[KEEP];
    expect(fold?.k).toBe('fold');
    expect(fold?.k === 'fold' && fold.steps.length).toBe(20 - KEEP * 2);
  });
  test('messages split runs; an unfolded fold shows every step', () => {
    const s = [...steps(15), ...stepsOf({ status: 'running' }, [text('t', 'msg')]), ...steps(3)];
    const rows = layout(s);
    expect(rows.filter((r) => r.k === 'fold').length).toBe(1);
    const key = rows.find((r) => r.k === 'fold')?.key ?? '';
    expect(layout(s, new Set([key])).length).toBe(s.length);
  });
  test('counts and the ticker', () => {
    const s = [...steps(7), ...stepsOf({ status: 'running' }, [text('t', 'hi')])];
    expect(counts(s)).toEqual({ messages: 1, steps: 7 });
    expect(ticker(s).map((x) => x.k === 'tool' && x.ev.label)).toEqual(['step 6', 'step 5', 'step 4', 'step 3', 'step 2']);
  });
});

describe('how a turn is drawn', () => {
  const t = (id: string, status: 'done' | 'running' | 'held', by?: string) => ({ id, status, ...(by && { by }) });
  test('the latest is open, older ones fold, a turn opened by hand stays open', () => {
    expect(viewOf(t('a', 'done'), true, new Set(), undefined)).toBe('open');
    expect(viewOf(t('a', 'done'), false, new Set(), undefined)).toBe('folded');
    expect(viewOf(t('a', 'done'), false, new Set(['a']), undefined)).toBe('open');
    expect(viewOf(t('a', 'running'), false, new Set(), undefined)).toBe('running');
    expect(viewOf(t('a', 'held'), true, new Set(), undefined)).toBe('held');
  });
  test('under a trailing Compact now, the answer before it stays open', () => {
    const turns = [{ id: 'a' }, { id: 'b' }, { id: 'c', by: 'compact' }];
    expect(keptOpen(turns)).toBe('b');
    expect(viewOf(t('b', 'done'), false, new Set(), keptOpen(turns))).toBe('open');
    expect(viewOf(t('c', 'done', 'compact'), true, new Set(), 'b')).toBe('compact');
    expect(keptOpen([{ id: 'a' }])).toBeUndefined();
  });
  test('long prompts, durations and the timeline end', () => {
    expect(promptIsLong('x'.repeat(361))).toBe(true);
    expect(promptIsLong('a\nb\nc\nd\ne\nf')).toBe(true);
    expect(promptIsLong('short')).toBe(false);
    expect([duration(400), duration(12_000), duration(184_000), duration(4_320_000)]).toEqual(['400ms', '12s', '3m 04s', '1h 12m']);
    expect(endOf({ status: 'stopped', presentation: { blocks: [{ type: 'hero', title: 'Interrupted' }], v: 1 } }).label).toBe('interrupted');
    expect(endOf({ status: 'error', presentation: null }).icon).toBe('warn');
  });
});
