// F-page-44 (v1 turns.js renderBody follow / place / land): a turn landing while you read keeps the view put; at the end
// you're taken to its start; not while the task opens, and not for what you did yourself.
import { afterEach, expect, test, vi } from 'vitest';
import { turnFollower } from '../src/app/hold-view.ts';

const frames: FrameRequestCallback[] = [];
const flush = (): void => {
  for (const f of frames.splice(0)) f(0);
};
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  frames.length = 0;
});

function page(o: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const body = document.createElement('div');
  const turns = document.createElement('div');
  body.append(turns);
  document.body.append(body);
  const m = { ...o };
  Object.defineProperty(body, 'scrollHeight', { get: () => m.scrollHeight });
  Object.defineProperty(body, 'clientHeight', { get: () => m.clientHeight });
  Object.defineProperty(body, 'scrollTop', { get: () => m.scrollTop, set: (v: number) => (m.scrollTop = v) });
  body.getBoundingClientRect = () => ({ top: 0, bottom: m.clientHeight }) as DOMRect;
  const add = (id: string, top: number): HTMLElement => {
    const t = document.createElement('article');
    t.dataset['turn'] = id;
    t.getBoundingClientRect = () => ({ top, bottom: top + 100 }) as DOMRect;
    turns.append(t);
    return t;
  };
  return { body, turns, m, add };
}

test('a_turn_landing_at_the_end_shows_from_its_start_and_one_landing_while_you_read_moves_nothing', () => {
  const p = page({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 });
  p.add('t1', -400);
  const f = turnFollower(p.body, p.turns, true);
  // opening: not armed until a frame after the first turns are in
  expect(f.grew(300)).toBe(false);
  flush();
  // at the end before it grew (1300 - 300 = 1000 high, 500 down, 500 shown), a new turn lands
  p.m.scrollHeight = 1300;
  const t2 = p.add('t2', 120);
  f.changed([{ type: 'childList', addedNodes: [t2] as unknown as NodeList, target: p.turns } as unknown as MutationRecord]);
  expect(f.grew(300)).toBe(true);
  expect(p.m.scrollTop).toBe(620); // t2's top at the view's top
  // further up: Chrome's anchoring holds it, nothing to do
  p.m.scrollTop = 100;
  const t3 = p.add('t3', 900);
  f.changed([{ type: 'childList', addedNodes: [t3] as unknown as NodeList, target: p.turns } as unknown as MutationRecord]);
  p.m.scrollHeight = 1600;
  expect(f.grew(300)).toBe(false);
  expect(p.m.scrollTop).toBe(100);
  f.stop();
});

test('what_the_reader_opened_themselves_never_moves_the_view_and_webkit_holds_the_turn_being_read', () => {
  const p = page({ scrollHeight: 1000, clientHeight: 500, scrollTop: 500 });
  const t1 = p.add('t1', 0);
  const f = turnFollower(p.body, p.turns, false);
  flush();
  // a click (a fold opening) at the end: its growth is the reader's
  t1.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  p.m.scrollHeight = 1400;
  expect(f.grew(400)).toBe(false);
  flush();
  flush(); // two frames on, the flag is gone
  // a key in the reply box (outside the turns) is not the reader changing a turn
  p.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a' }));
  p.m.scrollTop = 900; // at the end of 1400
  p.m.scrollHeight = 1500;
  expect(f.grew(100)).toBe(true);
  expect(p.m.scrollTop).toBe(1500);
  // WebKit, reading further up: what pushed the turn under the reading line down is undone
  p.m.scrollTop = 100;
  f.onScroll(); // t1 is under the reading line at 0
  t1.getBoundingClientRect = () => ({ top: 60, bottom: 160 }) as DOMRect;
  p.m.scrollHeight = 1460;
  expect(f.grew(60)).toBe(true);
  expect(p.m.scrollTop).toBe(160);
  f.stop();
});
