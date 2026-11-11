import { describe, expect, it } from 'vitest';
import { docOf, haltOf, heldOf, pct, receiptOf, tokenWords, whatChanged, windowName, type TurnDoc } from '../src/cards/model.ts';

const t = (k: string, v?: Readonly<Record<string, string | number>>): string => `${k}${v ? JSON.stringify(v) : ''}`;
const turn = (idx: number, extra: Partial<TurnDoc> = {}): TurnDoc => ({ id: `t${idx}`, idx, status: 'done', agent: 'claude', ...extra });

describe('turn cards', () => {
  it('each_card_says_why_a_turn_stopped_was_held_what_changed_and_what_it_cost', () => {
    // the store's row: the Turn in `body`
    expect(docOf({ id: 'r', status: 'held', idx: 2, body: { held: { by: 'wisp.budget', kind: 'limit', data: { label: 'Near the limit', why: '91% of the 5-hour window' } } } })?.status).toBe('held');
    expect(heldOf(turn(1, { status: 'held', held: { by: 'wisp.budget', kind: 'limit', data: { label: 'Near the limit', why: '91%' } } }))).toEqual({ label: 'Near the limit', why: '91%' });
    expect(heldOf(turn(1))).toBeNull();
    expect(haltOf(turn(1, { ext: { 'wisp.runtime': { authFailed: true } } }))).toEqual({ kind: 'signedOut' });
    expect(haltOf(turn(1, { status: 'error', text: "You've hit your usage limit · resets 3pm" }))?.kind).toBe('limit');
    expect(haltOf(turn(1, { status: 'done', ext: { 'wisp.runtime': { refusal: { text: ' I can’t help with that. ' } } } }))).toEqual({ kind: 'refused', text: 'I can’t help with that.' });
    // any other failure says itself in its answer (hero, blocks, Try again): no card, even when the hero is "blocked"
    expect(haltOf(turn(1, { status: 'error', text: 'boom' }))).toBeNull();
    expect(haltOf(turn(1, { status: 'error', presentation: { blocks: [{ type: 'hero', title: 'Claude Code failed', summary: 'claude exited with code 0', status: 'blocked' }] } }))).toBeNull();
    expect(haltOf(turn(1))).toBeNull();
    const a = turn(0, { ext: { 'wisp.runtime': { cli: { version: '2.1.0', catalog: 'x', models: { opus: 1 } } } } });
    const b = turn(1, { ext: { 'wisp.runtime': { cli: { version: '2.1.1', catalog: 'y', models: { opus: 1, fable: 1 } } } } });
    const other = turn(2, { agent: 'codex', ext: { 'wisp.runtime': { cli: { version: '9' } } } });
    expect(whatChanged([a, b, other], b, 'Claude Code')).toBe('Since the last turn: Claude Code 2.1.0 → 2.1.1, Claude Code model catalog changed (fable added).');
    expect(whatChanged([a, b, other], a, 'Claude Code')).toBeNull();
    expect(whatChanged([a, b, other], other, 'Codex')).toBeNull();
    // the receipt (v1 receipt.js): cache share from Claude's per-model counts, the longest window first, Past your plan
    const plan = [{ window: 'five_hour', used: 0.2 }, { window: 'seven_day', used: 0.02 }, { window: 'seven_day', used: 0.01 }, { window: 'w2880m', used: 0 }];
    const r = receiptOf(turn(1, { stats: { inputTokens: 100, outputTokens: 800, models: { opus: { input: 100, cacheRead: 7100, cacheWrite: 2800, output: 800 } } }, ext: { 'wisp.budget': { plan }, 'wisp.runtime': { overage: { kind: 'extra' } } } }), t);
    expect(r?.parts).toEqual(['shell-task.receipt.cache{"pct":"71%"}', 'shell-task.receipt.share{"pct":"3%","window":"weekly"}', 'shell-task.receipt.overage.extra']);
    expect(r?.tip).toContain('shell-task.receipt.tokens{"n":"10,800"}');
    expect(r?.tip).toContain('shell-task.receipt.shareTip{"pct":"20%","window":"5-hour"}');
    // reads and writes folded together (no per-model counts): no cache share; nothing to add: no receipt
    expect(receiptOf(turn(1, { stats: { inputTokens: 10, outputTokens: 5, cacheTokens: 90 } }), t)).toBeNull();
    expect(receiptOf(turn(1), t)).toBeNull();
    expect([pct(0.001), pct(0.996), pct(0.5), tokenWords(38_400), tokenWords(1_250_000), tokenWords(820), windowName('w300m'), windowName('w2880m'), windowName('x')]).toEqual(['<1%', '99%', '50%', '38k', '1.3M', '820', '5-hour', '2-day', 'plan']);
  });
});
