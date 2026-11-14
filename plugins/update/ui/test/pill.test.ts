// The top bar's Update pill, v1 web/js/features/update.js: when it shows, what it says, what a failed install
// offers, and when the page reloads onto the new wisp.
import { describe, expect, it } from 'vitest';
import { cameBack, failureAction, notBack, pillOf, restartStep } from '../src/pill.ts';
import type { UpdateState } from '../src/types.ts';

const row = (over: Partial<UpdateState> = {}): UpdateState => ({
  current: '2.0.0',
  latest: '2.1.0',
  available: true,
  method: 'global',
  channel: 'stable',
  status: 'idle',
  error: null,
  enabled: true,
  command: 'npm install -g wisp-agents@latest',
  ...over,
});

describe('the Update pill', () => {
  it('shows_only_while_a_newer_wisp_is_out_or_an_install_runs', () => {
    expect(pillOf(undefined)).toBeUndefined();
    expect(pillOf(row({ available: false }))).toBeUndefined();
    expect(pillOf(row())).toEqual({ text: '2.1.0', label: 'Update to 2.1.0', title: 'wisp 2.0.0 → 2.1.0: install and restart', busy: false });
    // v1: busy keeps it up (and not pressable) even once the row says nothing newer is out
    expect(pillOf(row({ status: 'installing', available: false }))).toMatchObject({ label: 'Updating…', busy: true });
    expect(pillOf(row({ status: 'restarting' }))).toMatchObject({ label: 'Restarting…', busy: true });
  });

  it('a_failed_install_offers_the_command_or_the_apps_downloads', () => {
    expect(failureAction(row())).toEqual({ kind: 'copy', target: 'npm install -g wisp-agents@latest' });
    expect(failureAction(row({ method: 'app', command: 'https://github.com/WispAgents/wisp/releases/latest' }))).toEqual({
      kind: 'open',
      target: 'https://github.com/WispAgents/wisp/releases/latest',
    });
    const { command: _, ...none } = row({ method: 'git' });
    expect(failureAction(none)).toBeUndefined();
  });

  it('reloads_once_the_row_reports_another_version_than_the_one_restarting', () => {
    expect(cameBack(undefined, row({ current: '2.1.0' })), 'nothing was restarting').toBe(false);
    expect(cameBack('2.0.0', row({ status: 'restarting' })), 'still the old wisp').toBe(false);
    expect(cameBack('2.0.0', undefined), 'the row not back yet').toBe(false);
    expect(cameBack('2.0.0', row({ current: '2.1.0', available: false }))).toBe(true);
  });

  it('a_retried_restart_waits_again_and_a_restart_that_didnt_take_never_reloads_later', () => {
    const idle = row();
    const restarting = row({ status: 'restarting' });
    // first load: nothing restarting, nothing to do
    expect(restartStep(undefined, undefined, idle)).toEqual({ from: undefined, reload: false, wait: false });
    // entering restarting: watch 2.0.0, and wait
    expect(restartStep(undefined, idle, restarting)).toEqual({ from: '2.0.0', reload: false, wait: true });
    // still restarting, or the row away while wisp is down: keep watching, no new wait
    expect(restartStep('2.0.0', restarting, restarting)).toEqual({ from: '2.0.0', reload: false, wait: false });
    expect(restartStep('2.0.0', restarting, undefined)).toEqual({ from: '2.0.0', reload: false, wait: false });
    // the new wisp answers
    expect(restartStep('2.0.0', undefined, row({ current: '2.1.0', available: false }))).toEqual({ from: undefined, reload: true, wait: false });
    // the same wisp came back idle: let go, so a later version change (a manual update) doesn't reload
    expect(restartStep('2.0.0', restarting, idle)).toEqual({ from: undefined, reload: false, wait: false });
    expect(restartStep(undefined, idle, row({ current: '2.1.0' })).reload).toBe(false);
    // a retry enters restarting again: a fresh wait
    expect(restartStep(undefined, idle, restarting)).toEqual({ from: '2.0.0', reload: false, wait: true });
  });

  it('says_how_to_start_wisp_again_when_it_never_came_back', () => {
    expect(notBack(row())).toBe('wisp didn’t come back. Start it again from your terminal.');
    expect(notBack(row({ method: 'app' }))).toBe('wisp didn’t come back. Open it again.');
  });
});
