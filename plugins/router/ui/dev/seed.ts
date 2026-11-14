// The mock peer's rows and command handlers for this plugin's dev page and tests.
import type { Intent } from '@wisp/client';
import type { HarnessOptions } from './harness.ts';

export const SEED: HarnessOptions = {
  plugin: 'wisp.router',
  rows: { list: [{ e: 'session', id: 's1', v: { id: 's1', title: 'Fix the login', agent: 'claude' } }] },
  handlers: {},
};

/** ?screen=<name>: the intents that open it */
export const SCREENS: Readonly<Record<string, readonly Intent[]>> = { home: [] };
