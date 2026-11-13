// A step's output of a .env file in the transcript (TurnTranscript stepOutput, env-reveal.ts): masked like v1's
// maskStep, revealed per task for the tab's life.
import { afterEach, expect, test } from 'vitest';
import { render } from 'solid-js/web';
import type { EnvReveal } from '@wisp/ui';
import { envShown, maskIsOn, setEnvShown } from '../src/frame/env-reveal.ts';
import { TurnTranscript, stepOutput } from '../src/frame/TurnTranscript.tsx';

const off: (() => void)[] = [];
afterEach(() => {
  while (off.length) off.pop()?.();
  document.body.innerHTML = '';
});

test('F-page-41: a step that read a .env file shows its output masked until revealed; other commands and masking off as they are (v1 maskStep cases)', () => {
  const a = { kind: 'run', label: 'Show the env', detail: 'cat .env', out: 'API_KEY=sk-123\nPORT=3000' };
  expect(stepOutput(a, true, false)).toEqual({ text: 'API_KEY=••••\nPORT=••••', env: true });
  expect(stepOutput(a, true, true)).toEqual({ text: 'API_KEY=sk-123\nPORT=3000', env: true });
  expect(stepOutput(a, false, false)).toEqual({ text: 'API_KEY=sk-123\nPORT=3000', env: false });
  expect(stepOutput({ kind: 'run', detail: 'ls', out: 'A=1' }, true, false)).toEqual({ text: 'A=1', env: false });
  expect(stepOutput({ kind: 'run', detail: 'cat .env.example', out: 'A=1' }, true, false)?.env).toBe(false);
  expect(stepOutput({ kind: 'read', label: 'Read apps/web/.env.local', out: 'S=hunter2' }, true, false)?.text).toBe('S=••••');
  expect(stepOutput({ kind: 'run', detail: 'cat .env', out: '# only a comment' }, true, false)?.env).toBe(false); // nothing to hide: no line
});

test('F-page-41: revealed .env views stay shown per task for the tab’s life, until Hide; the setting is on unless off', () => {
  setEnvShown('p:t1', 'turn1:step:0', true);
  expect(envShown('p:t1', 'turn1:step:0')).toBe(true);
  expect(envShown('p:t2', 'turn1:step:0')).toBe(false);
  setEnvShown('p:t1', 'turn1:step:0', false);
  expect(envShown('p:t1', 'turn1:step:0')).toBe(false);
  expect([undefined, null, true, 'on'].every(maskIsOn)).toBe(true);
  expect([false, 'off'].some(maskIsOn)).toBe(false);
});

test('F-page-41: the transcript step’s output has v1’s line over it, Reveal ⇄ Hide in place', () => {
  // the shell's own store (env-reveal.ts), as TaskView wires it
  const env: EnvReveal = { on: () => true, shown: (id) => envShown('p:t9', id), set: (id, on) => setEnvShown('p:t9', id, on) };
  const host = document.createElement('div');
  document.body.append(host);
  const t = (k: string, v?: Readonly<Record<string, string | number>>): string => (k === 'shell.env.hidden' ? `${String(v?.['name'])}’s values are hidden` : k);
  off.push(render(() => <TurnTranscript steps={[{ kind: 'run', label: 'Show the env', detail: 'cat apps/.env.local', out: 'SECRET=hunter2' }]} changes={[]} here={(s) => s} status="done" env={env} t={t as never} />, host));
  (host.querySelector('[data-kit="timeline-row"]') as HTMLButtonElement).click();
  expect(host.querySelector('pre')?.textContent).toBe('SECRET=••••');
  expect(host.querySelector('[data-part="turn.transcript.envMask"]')?.textContent).toBe('.env.local’s values are hiddenshell.env.reveal');
  expect(host.textContent).not.toContain('hunter2');
  const btn = (): HTMLButtonElement => host.querySelector('[data-part="turn.transcript.envMask.reveal"]') as HTMLButtonElement;
  const bar = host.querySelector('[data-part="turn.transcript.envMask"]');
  btn().click();
  expect(host.querySelector('pre')?.textContent).toBe('SECRET=hunter2');
  expect(btn().textContent).toBe('shell.env.hide');
  expect(host.querySelector('[data-part="turn.transcript.envMask"]')).toBe(bar); // in place
  btn().click();
  expect(host.querySelector('pre')?.textContent).toBe('SECRET=••••');
});
