// A terminal task (v1 services/tui.js): its row says so (summary.tui, or flat), and the Terminal pane is the side view
// `shell-task.term`, open beside the task it's on.
import { describe, expect, it } from 'vitest';
import type { Nav } from '@wisp/client';
import { TERM_VIEW, isTui, sideOf } from '../src/open-task.ts';

describe('terminal tasks', () => {
  it('a_terminal_task_opens_its_cli_in_the_terminal_pane_beside_it', () => {
    expect(isTui({ summary: { tui: true } })).toBe(true);
    expect(isTui({ tui: true })).toBe(true);
    expect(isTui({ summary: { status: 'done' } })).toBe(false);
    expect(isTui(undefined)).toBe(false);
    const nav = { main: { kind: 'task', id: 'local:t1' }, side: { kind: 'view', id: TERM_VIEW }, overlays: [], layout: 'split' } as unknown as Nav;
    expect(sideOf(nav)).toEqual({ pane: 'term', id: 'local:t1' });
    const home = { ...nav, main: { kind: 'home' } } as unknown as Nav;
    expect(sideOf(home)).toBeUndefined();
  });
});
