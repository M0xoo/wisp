import { describe, expect, test } from 'vitest';
import { MAX_SENT, caretLines, historyStep, remember } from '../src/text/history.ts';
import { HOME_SLASH, SLASH, afterAsk, btwQuestion, goalAsk, isBtw, isGoalDrop, isLogin, isPaneAsk, sameLines, sideAsk, slashMatches } from '../src/text/slash.ts';
import { cleanTitle, decode, encode, insertMention, liveMentions, mentionQuery, pastedTasks, plain, spans, type Mention } from '../src/text/mentions.ts';
import { prng } from './prng.ts';

describe('prompt history (v1 prompt-history.js)', () => {
  test('remember keeps each prompt once, newest last, capped', () => {
    expect(remember(['a', 'b'], ' a ')).toEqual(['b', 'a']);
    expect(remember(['a'], '   ')).toEqual(['a']);
    const many = Array.from({ length: 60 }, (_, i) => `p${i}`).reduce<readonly string[]>(remember, []);
    expect(many).toHaveLength(MAX_SENT);
    expect(many.at(-1)).toBe('p59');
  });
  test('↑ in an empty box brings the newest, ↑ again the one before, ↓ past the newest empties', () => {
    const list = ['one', 'two', 'three'];
    const a = historyStep({ key: 'ArrowUp', value: '', list, at: null });
    expect(a).toEqual({ at: 2, value: 'three' });
    const b = historyStep({ key: 'ArrowUp', value: 'three', list, at: 2 });
    expect(b).toEqual({ at: 1, value: 'two' });
    expect(historyStep({ key: 'ArrowUp', value: 'one', list, at: 0 })).toBeNull();
    expect(historyStep({ key: 'ArrowDown', value: 'two', list, at: 1 })).toEqual({ at: 2, value: 'three' });
    expect(historyStep({ key: 'ArrowDown', value: 'three', list, at: 2 })).toEqual({ at: null, value: '' });
  });
  test('a draft is never replaced; an edited entry stops browsing; only from the first/last line', () => {
    const list = ['one', 'two'];
    expect(historyStep({ key: 'ArrowUp', value: 'my draft', list, at: null })).toBeNull();
    expect(historyStep({ key: 'ArrowUp', value: 'two!', list, at: 1 })).toBeNull();
    expect(historyStep({ key: 'ArrowDown', value: '', list, at: null })).toBeNull();
    expect(historyStep({ key: 'ArrowUp', value: 'two', list, at: 1, firstLine: false })).toBeNull();
    expect(caretLines('a\nb', 0)).toEqual({ firstLine: true, lastLine: false });
    expect(caretLines('a\nb', 3)).toEqual({ firstLine: false, lastLine: true });
  });
  test('property: ↑ n times then ↓ n times from an empty box ends empty, never skipping an entry', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = prng(seed);
      const list = Array.from({ length: 1 + r.int(8) }, (_, i) => `p${i}`);
      const ups = 1 + r.int(list.length);
      let state: { at: number | null; value: string } = { at: null, value: '' };
      const seen: string[] = [];
      for (let i = 0; i < ups; i++) {
        state = historyStep({ key: 'ArrowUp', value: state.value, list, at: state.at }) ?? state;
        seen.push(state.value);
      }
      expect(seen, `seed ${seed}`).toEqual(list.slice(-ups).reverse());
      for (let i = 0; i < ups; i++) state = historyStep({ key: 'ArrowDown', value: state.value, list, at: state.at }) ?? state;
      expect(state, `seed ${seed}`).toEqual({ at: null, value: '' });
    }
  });
});

describe('slash commands (v1 slash-text.js)', () => {
  test('the menu matches a half-typed command only while the box holds nothing else', () => {
    expect(slashMatches('/b').map((c) => c.name)).toEqual(['btw', 'bug']);
    expect(slashMatches('/').length).toBe(SLASH.length);
    expect(slashMatches('/btw hi')).toEqual([]);
    expect(slashMatches('hi /b')).toEqual([]);
    expect(slashMatches('/s', HOME_SLASH).map((c) => c.name)).toEqual(['spell', 'sandbox']);
  });
  test('New task has no /btw, /side or /login; it adds /terminal and /sandbox, and /goal starts a task', () => {
    const names = HOME_SLASH.map((c) => c.name);
    expect(names).not.toContain('btw');
    expect(names).not.toContain('side');
    expect(names).not.toContain('login');
    expect(names).toContain('terminal');
    expect(HOME_SLASH.find((c) => c.name === 'goal')?.hint).toBe('shell-composer.slash.goal.home-hint');
  });
  test('arguments: bare is empty, other text is null', () => {
    expect(btwQuestion('/btw did you run the tests?')).toBe('did you run the tests?');
    expect(btwQuestion('/btw')).toBe('');
    expect(btwQuestion('/btwx')).toBeNull();
    expect(btwQuestion('hello')).toBeNull();
    expect(sideAsk('  /SIDE why sqlite? ')).toBe('why sqlite?');
    expect(goalAsk('/goal all tests pass')).toBe('all tests pass');
    expect(isGoalDrop('drop')).toBe(true);
    expect(isBtw('  /btw x')).toBe(true);
    expect(isLogin('/login')).toBe(true);
    expect(isLogin('/login now')).toBe(false);
    expect(isPaneAsk('please make me a pane that shows PRs')).toBe(true);
  });
  test('/after takes a mention, an id, wisp:<id> or a link, then the prompt', () => {
    expect(afterAsk('/after @[Fix login](wisp:abc123def456) write notes')).toEqual({ id: 'abc123def456', prompt: 'write notes' });
    expect(afterAsk('/after abc123def456 go')).toEqual({ id: 'abc123def456', prompt: 'go' });
    expect(afterAsk('/after wisp:abc123def456')).toEqual({ id: 'abc123def456', prompt: '' });
    expect(afterAsk('/after http://x/#/s/abc123/ then this')).toEqual({ id: 'abc123', prompt: 'then this' });
    expect(afterAsk('/after just words')).toEqual({ id: '', prompt: 'just words' });
    expect(afterAsk('after')).toBeNull();
  });
  test('sameLines compares trimmed lines', () => {
    expect(sameLines('  a\n b ', 'a\nb')).toBe(true);
    expect(sameLines('a', undefined)).toBe(false);
  });
});

describe('mentions (v1 mention-text.js)', () => {
  const fix: Mention = { id: 'abc123def456', title: 'Fix login', kind: 'task' };
  const ana: Mention = { id: 'crew000001', title: 'Ana', kind: 'crew' };
  const doc: Mention = { id: 'stuff00001', title: 'Spec', kind: 'stuff' };
  test('decode shows titles and collects each mention once', () => {
    const d = decode('see @[Fix login](wisp:abc123def456) and @[Ana](crew:crew000001), @[Fix login](wisp:abc123def456)');
    expect(d.text).toBe('see @Fix login and @Ana, @Fix login');
    expect(d.mentions).toEqual([fix, ana]);
  });
  test('encode is the inverse; a mention edited away is plain text', () => {
    expect(encode('ask @Ana about @Spec', [ana, doc])).toBe('ask @[Ana](crew:crew000001) about @[Spec](stuff:stuff00001)');
    expect(encode('ask @An about it', [ana])).toBe('ask @An about it');
  });
  test('longer titles win over a title that starts them', () => {
    const short: Mention = { id: 'aaaaaa', title: 'Fix', kind: 'task' };
    expect(spans('@Fix login now', [short, fix]).map((s) => s.id)).toEqual([fix.id]);
  });
  test('cleanTitle, plain, liveMentions', () => {
    expect(cleanTitle('a]b\nc')).toBe('a b c');
    expect(cleanTitle('  ')).toBe('Untitled task');
    expect(plain('x @[Fix login](wisp:abc123def456)')).toBe('x @Fix login');
    expect(liveMentions('hi @Ana', [ana, fix])).toEqual([ana]);
  });
  test('the @query at the caret, and inserting a pick', () => {
    expect(mentionQuery('hi @fi', 6)).toEqual({ start: 3, query: 'fi' });
    expect(mentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(mentionQuery('mail a@b', 8)).toBeNull();
    expect(mentionQuery('hi @fix it', 10)).toBeNull();
    expect(insertMention('hi @fi rest', 3, 6, fix)).toEqual({ text: 'hi @Fix login  rest', caret: 14 });
  });
  test('pasted ids of known tasks become mentions; anything else is text', () => {
    const known = (id: string): boolean => id === 'abc123def456' || id === 'zz9';
    expect(pastedTasks('abc123def456 wisp:abc123def456', known)).toEqual(['abc123def456']);
    expect(pastedTasks('abc123def456 hello', known)).toBeNull();
    expect(pastedTasks('', known)).toBeNull();
  });
  test('property: decode(encode(text)) round-trips titles and mentions', () => {
    const pool: Mention[] = [fix, ana, doc, { id: 'qqqqqq', title: 'Fix login page', kind: 'task' }];
    for (let seed = 1; seed <= 300; seed++) {
      const r = prng(seed);
      const used = pool.filter(() => r.int(2) === 1);
      const words = Array.from({ length: 1 + r.int(6) }, () => (used.length && r.int(2) ? `@${r.pick(used).title}` : r.pick(['go', 'and', 'x', '@', 'a]b'])));
      const shown = words.join(' ');
      const stored = encode(shown, used);
      const back = decode(stored);
      expect(back.text, `seed ${seed}`).toBe(shown);
      expect(encode(back.text, back.mentions), `seed ${seed}`).toBe(stored);
    }
  });
});
