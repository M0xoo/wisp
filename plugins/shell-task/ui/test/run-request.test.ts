// Run app / Stop app (src/side/run-request.ts, v1 panel.js runLabel / runApp): the row's mark says it runs.
import { expect, test } from 'vitest';
import { appRunning, runRequest } from '../src/side/run-request.ts';

test('the row says Stop app while wisp.terminal marks its app running; a Run app request waits for its Preview_v1_run_label', () => {
  expect(appRunning({ ext: { 'wisp.terminal': { run: { running: true, port: 41664 } } } })).toBe(true);
  expect(appRunning({ ext: { 'wisp.terminal': { run: { running: false } } } })).toBe(false);
  expect(appRunning({ ext: {} })).toBe(false);
  expect(appRunning(undefined)).toBe(false);
  runRequest('s1');
  expect(runRequest()).toBe('s1');
  runRequest(undefined);
});
