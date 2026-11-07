// The terminal flow (plan §4.6.3) as a pure transition table, run on the server for every terminal.
// v1 kept two booleans (code === null, a "starting" flag in the page) and raced them (#432, #435);
// here a state names exactly one situation and an event that doesn't apply leaves it as it is.
//
// One addition to the plan's table: EXIT while starting. A program that ends before printing anything
// (a missing shell, `false`) ends the start; with code 127 it never ran, which is FAIL.

import type { TermState } from '@wisp-plugin/terminal-api';

export type FlowEvent = 'START' | 'READY' | 'SLOW' | 'FAIL' | 'STOP' | 'EXIT' | 'DONE';

export const FLOW: Readonly<Record<TermState, Readonly<Partial<Record<FlowEvent, TermState>>>>> = {
  idle: { START: 'starting' },
  starting: { READY: 'running', SLOW: 'slow', FAIL: 'failed', STOP: 'stopping', EXIT: 'ended' },
  slow: { READY: 'running', FAIL: 'failed', STOP: 'stopping', EXIT: 'ended' },
  running: { EXIT: 'ended', STOP: 'stopping' },
  stopping: { DONE: 'ended', EXIT: 'ended' },
  ended: { START: 'starting' }, // a fresh screen: the dead one is never reopened (#432)
  failed: { START: 'starting' },
};

export const STATES = Object.keys(FLOW) as TermState[];
export const EVENTS: readonly FlowEvent[] = ['START', 'READY', 'SLOW', 'FAIL', 'STOP', 'EXIT', 'DONE'];

/** The next state; an event the state doesn't take changes nothing. */
export const step = (s: TermState, e: FlowEvent): TermState => FLOW[s][e] ?? s;

/** A program is on it: input goes in, the task counts as "in a terminal". */
export const isLive = (s: TermState): boolean => s === 'starting' || s === 'slow' || s === 'running';

/** It ended (or never started): a page sees its last screen and its exit code. */
export const isOver = (s: TermState): boolean => s === 'ended' || s === 'failed';

/** "a slow start says so" (#440): no output this long after START. */
export const SLOW_MS = 8000;
