// v1's trigger form on v2's trigger spec (src/trigger-form.ts, v1 automations.js triggerForm).
import { expect, test } from 'vitest';
import { emptyForm, pick, readBack, specOfForm, warning } from '../src/trigger-form.ts';

test('each kind saves the spec its v2 source reads; a kind v2 has no source for says so_v1_trigger_form', () => {
  const f = { ...emptyForm('/code/web'), name: 'Morning tidy', when: 'every weekday at 9am', prompt: 'Tidy the repo' };
  expect(specOfForm(f)).toEqual({ name: 'morning-tidy', spec: { on: 'schedule', prompt: 'Tidy the repo', project: '/code/web', mode: 'auto', cron: '0 9 * * 1-5' } });
  expect(specOfForm({ ...f, when: 'whenever' })).toEqual({ missing: 'when' });
  expect(specOfForm({ ...f, name: '  ' })).toEqual({ missing: 'name' });
  const ci = pick({ ...f, prompt: '' }, 'ci');
  expect(specOfForm({ ...ci, branch: 'main' })).toEqual({ name: 'morning-tidy', spec: { on: 'ci.failed', project: '/code/web', mode: 'auto', branch: 'main', every: 5 } });
  const issues = pick(f, 'issues');
  expect(issues.mode).toBe('plan'); // v1: a GitHub kind starts in Plan
  expect(specOfForm(issues)).toEqual({ missing: 'label' });
  expect(specOfForm({ ...f, key: 'finished', recipe: 'release' })).toEqual({ name: 'morning-tidy', spec: { on: 'task.finished', task: 'release', project: '/code/web', mode: 'auto' } });
  expect('unsupported' in specOfForm({ ...f, key: 'done' })).toBe(true);
  expect('unsupported' in specOfForm({ ...f, key: 'linear' })).toBe(true);
  // a crew member's job: their mode and harness, not the form's
  expect(specOfForm({ ...f, crew: 'm1', agent: 'codex' })).toEqual({ name: 'morning-tidy', spec: { on: 'schedule', prompt: 'Tidy the repo', crew: 'm1', project: '/code/web', cron: '0 9 * * 1-5' } });
  // the runner picker: a harness and its model (v1 runnerField); a model with no harness is the launcher's default
  expect(specOfForm({ ...f, agent: 'codex', model: 'gpt-5.5' })).toMatchObject({ spec: { agent: 'codex', model: 'gpt-5.5' } });
  expect('model' in (specOfForm({ ...f, model: 'gpt-5.5' }) as { spec: object }).spec).toBe(false);
  const slack = pick({ ...f, prompt: '' }, 'slack');
  expect(specOfForm({ ...slack, channel: 'C1', users: 'U1, U2', keyword: 'deploy' })).toEqual({
    name: 'morning-tidy',
    spec: { on: 'chat.message', project: '/code/web', mode: 'plan', filters: { channel: 'C1', text: '*deploy*' }, users: ['U1', 'U2'] },
  });
});

test('a preset fills the header and prompt that are still empty; the warning while not in Plan; When read back_v1_trigger_presets', () => {
  const s = pick(emptyForm(), 'webhook:sentry');
  expect(s.header).toBe('Sentry-Hook-Signature');
  expect(s.prompt).toContain('{{body.data.issue.title}}');
  expect(pick({ ...emptyForm(), prompt: 'mine' }, 'webhook:pagerduty').prompt).toBe('mine');
  expect(warning(s)).toBeUndefined(); // Plan
  expect(warning({ ...s, mode: 'auto' })).toContain('anyone who has it');
  expect(warning({ ...emptyForm(), mode: 'auto' })).toBeUndefined(); // a schedule: nothing comes in
  expect(readBack('', () => null)).toBeUndefined();
  expect(readBack('every hour', () => 'Every hour')).toEqual({ text: 'Understood', bad: false });
  expect(readBack('every weekday at 9am', () => 'Every weekday at 9:00')).toEqual({ text: '= Every weekday at 9:00', bad: false });
  expect(readBack('whenever', () => null)?.bad).toBe(true);
});
