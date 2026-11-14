// A BlockContext for the gallery: every action logs to the console, lookups answer from fixtures.
import { createSignal } from 'solid-js';
import type { BlockContext, DocText, KeepHost, StuffRef, TaskRef } from '../../src/index.ts';

const log = (what: string) => (...args: unknown[]): void => console.info(`[gallery] ${what}`, ...args);
const TASKS: Record<string, TaskRef> = {
  'a1b2c3': { id: 'a1b2c3', title: 'Refresh sessions in auth', state: 'review', agent: 'claude' },
  'd4e5f6': { id: 'd4e5f6', title: 'Rotate the signing keys', state: 'running', agent: 'codex' },
};
const STUFF: Record<string, StuffRef> = {
  '0bac5acb43c9': { id: '0bac5acb43c9', title: 'Release checklist', kind: 'app', sub: 'App · updated 2h ago' },
};
const DOC = '# Plan\n\nShip the limiter behind a setting.\n\n## Steps\n\n1. Add the window\n2. Wire the route\n3. Tests\n';

// Save to My Stuff: kept in memory, so a click lights the button up and a second takes it out
const [kept, setKept] = createSignal<ReadonlySet<string>>(new Set());
const keep: KeepHost = {
  saved: (what) => () => kept().has(what),
  toggle: (what, it) => {
    log('keep')(what, it);
    const next = new Set(kept());
    if (!next.delete(what)) next.add(what);
    setKept(next);
  },
};

export const galleryCtx: BlockContext = {
  keep,
  reply: log('reply'),
  run: log('run'),
  openTask: log('openTask'),
  openStuff: log('openStuff'),
  openFile: log('openFile'),
  openUrl: log('openUrl'),
  allow: log('allow'),
  task: (id) => () => TASKS[id],
  stuff: (id) => () => STUFF[id],
  docText: (path): (() => DocText) => () => (path.endsWith('.md') ? { kind: 'ready', text: DOC } : { kind: 'failed', reason: 'Not a text file' }),
  media: (p) => (p.startsWith('http') || p.startsWith('data:') ? p : undefined),
  previewUrl: (u) => u,
  latest: true,
};
