// What Stop asks first on the task (frame/stop-question.ts, v1 #781).
import { expect, test } from 'vitest';
import { stopQuestion } from '../src/frame/stop-question.ts';
import { SHELL_STRINGS } from '../src/i18n/en.ts';

const cat = SHELL_STRINGS as Readonly<Record<string, string>>;
const t = (k: string, v?: Readonly<Record<string, string | number>>): string => (cat[k] ?? k).replace(/\{(\w+)\}/g, (_, w: string) => String(v?.[w] ?? ''));

test('stop_asks_first_and_says_what_else_stops_for_a_lead_and_a_subagent', () => {
  expect(stopQuestion({ sub: false, name: 'Claude Code', live: 0, queued: 0 }, t)).toEqual({ title: 'Stop Claude Code?', body: 'The run ends where it is.', ok: 'Stop' });
  // a lead with subagents at work and follow-ups queued: they stop with it, the follow-ups stay, held
  expect(stopQuestion({ sub: false, name: 'Codex', live: 2, queued: 1 }, t).body).toBe('Its 2 subagents stop too. Your queued follow-up stays, held until you send one.');
  // a subagent: its lead gets no report from it
  const sub = stopQuestion({ sub: true, name: 'Claude Code', live: 0, queued: 0 }, t);
  expect(sub.title).toBe('Stop this subagent?');
  expect(sub.ok).toBe('Stop subagent');
  expect(sub.body).toContain('Its lead gets no report');
});
