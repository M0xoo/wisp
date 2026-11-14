// The mock peer's rows and command handlers for this plugin's dev page and tests.
import type { Intent } from '@wisp/client';
import type { HarnessOptions } from './harness.ts';

export const SEED: HarnessOptions = {
  plugin: 'wisp.goal',
  rows: { list: [] },
  handlers: {},
};

/** ?screen=<name>: the intents that open it */
export const SCREENS: Readonly<Record<string, readonly Intent[]>> = {};
