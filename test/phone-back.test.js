// The phone app's Back (web/js/ui/back.js) over a stub history. Back from a subagent's run (or a
// crew job) goes up to the task it was opened from: closing the page opens another, which takes a
// Back entry of its own while the Back is still being handled. That entry must stay, or the same
// press closes it too and lands on the list.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const listeners = [];
const entries = [null]; // history states, the page's own first
let at = 0;
const pop = () => {
  for (const f of listeners) f({ state: entries[at] });
};
globalThis.history = {
  get state() {
    return entries[at];
  },
  pushState(state) {
    entries.length = ++at;
    entries.push(state);
  },
  back() {
    if (at > 0) (at--, queueMicrotask(pop));
  },
};
globalThis.addEventListener = (type, f) => {
  if (type === 'popstate') listeners.push(f);
};
globalThis.location = new URL('http://localhost/?m=Studio');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.document = { documentElement: { classList: { contains: () => false } } };
Object.defineProperty(globalThis, 'navigator', { value: { platform: '', userAgent: 'Android wispMobile' }, configurable: true });

const { onBack, backDepth } = await import('../web/js/ui/back.js');
const press = () => {
  at--;
  pop();
};

test('Back from a subagent opens its lead as a page that a second Back closes', () => {
  const log = [];
  let page = null; // the one page over the list (split.js paintPage)
  let shown = null;
  const open = (what) => {
    log.push(`open ${what}`);
    shown = what;
    if (!page)
      page = onBack(() => {
        page = null;
        back();
      });
  };
  // goBack: a subagent goes up to its lead, a task to the list.
  const back = () => {
    if (shown === 'sub') return open('lead');
    shown = null;
    log.push('list');
  };
  open('lead');
  open('sub'); // the same page, now showing the subagent
  assert.equal(backDepth(), 1);
  press();
  assert.deepEqual(log.slice(2), ['open lead'], 'Back went past the lead');
  assert.ok(page, 'the lead lost its Back entry');
  assert.equal(history.state?.wispBack, 1, 'no history entry for the lead');
  press();
  assert.deepEqual(log.slice(2), ['open lead', 'list']);
  assert.equal(backDepth(), 0);
});

test('one Back closes only the newest thing open', () => {
  const closed = [];
  onBack(() => closed.push('task'));
  onBack(() => closed.push('menu'));
  press();
  assert.deepEqual(closed, ['menu']);
  press();
  assert.deepEqual(closed, ['menu', 'task']);
});
