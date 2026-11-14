// v1's trigger form on v2's trigger spec (src/trigger-form.ts, v1 automations.js triggerForm).
import { expect, test } from 'vitest';
import { DEFAULT_PROMPTS, emptyForm, pick, readBack, specOfForm, warning } from '../src/trigger-form.ts';

test('each kind saves the spec its v2 source reads; a kind v2 has no source for says so_v1_trigger_form', () => {
  const f = { ...emptyForm('/code/web'), name: 'Morning tidy', when: 'every weekday at 9am', prompt: 'Tidy the repo' };
  expect(specOfForm(f)).toEqual({ name: 'morning-tidy', spec: { on: 'schedule', prompt: 'Tidy the repo', project: '/code/web', mode: 'auto', cron: '0 9 * * 1-5' } });
  expect(specOfForm({ ...f, when: 'whenever' })).toEqual({ missing: 'when' });
  expect(specOfForm({ ...f, name: '  ' })).toEqual({ missing: 'name' });
  const ci = pick({ ...f, prompt: '' }, 'ci');
  expect(specOfForm({ ...ci, branch: 'main' })).toEqual({ name: 'morning-tidy', spec: { on: 'ci.failed', prompt: DEFAULT_PROMPTS['ci'], project: '/code/web', mode: 'auto', branch: 'main', every: 5 } });
  const issues = pick(f, 'issues');
  expect(issues.mode).toBe('plan'); // v1: a GitHub kind starts in Plan
  expect(specOfForm(issues)).toEqual({ missing: 'label' });
  expect(specOfForm({ ...f, key: 'finished', recipe: 'release' })).toEqual({ name: 'morning-tidy', spec: { on: 'task.finished', task: 'release', project: '/code/web', mode: 'auto' } });
  expect(specOfForm({ ...f, key: 'done' })).toMatchObject({ spec: { on: 'task.done', prompt: 'Tidy the repo' } });
  // a crew member's job: their mode and harness, not the form's
  expect(specOfForm({ ...f, crew: 'm1', agent: 'codex' })).toEqual({ name: 'morning-tidy', spec: { on: 'schedule', prompt: 'Tidy the repo', crew: 'm1', project: '/code/web', cron: '0 9 * * 1-5' } });
  // the runner picker: a harness and its model (v1 runnerField); a model with no harness is the launcher's default
  expect(specOfForm({ ...f, agent: 'codex', model: 'gpt-5.5' })).toMatchObject({ spec: { agent: 'codex', model: 'gpt-5.5' } });
  expect('model' in (specOfForm({ ...f, model: 'gpt-5.5' }) as { spec: object }).spec).toBe(false);
});

test('a Slack mention is a chat message from the people named, its keyword in the text; the spec reads it as match_v1_slack', () => {
  const f = { ...emptyForm('/code/web'), name: 'Deploys', prompt: '' };
  const slack = pick(f, 'slack');
  // `match`, as the spec names it (deny_unknown_fields refused `filters`), and the keyword as words, not a glob
  expect(specOfForm({ ...slack, users: 'U1, U2', keyword: 'deploy' })).toEqual({
    name: 'deploys',
    spec: { on: 'chat.message', prompt: DEFAULT_PROMPTS['slack'], project: '/code/web', mode: 'plan', match: { channel: 'slack', keyword: 'deploy' }, users: ['U1', 'U2'] },
  });
  expect(specOfForm(slack)).toEqual({ missing: 'people' }); // v1 refused a trigger naming nobody
});

test('a webhook needs its secret; Sentry, PagerDuty and Linear sign in their own header; Linear is an issue created with the label_v1_hooks', () => {
  const f = { ...emptyForm('/code/api'), name: 'Alerts' };
  expect(specOfForm(pick(f, 'webhook'))).toEqual({ missing: 'secret' });
  expect(specOfForm({ ...pick(f, 'webhook'), secret: 's3cret-value' })).toMatchObject({ spec: { on: 'webhook', secret: 's3cret-value', prompt: DEFAULT_PROMPTS['webhook'] } });
  expect('header' in (specOfForm({ ...pick(f, 'webhook'), secret: 's3cret-value' }) as { spec: object }).spec).toBe(false);
  expect(specOfForm({ ...pick(f, 'webhook:sentry'), secret: 'x' })).toMatchObject({ spec: { on: 'webhook', header: 'Sentry-Hook-Signature', mode: 'plan' } });
  expect(specOfForm({ ...pick(f, 'webhook:pagerduty'), secret: 'x' })).toMatchObject({ spec: { header: 'X-PagerDuty-Signature' } });
  expect(specOfForm({ ...pick(f, 'linear'), secret: 'lin_wh', label: 'wisp' })).toEqual({
    name: 'alerts',
    spec: { on: 'webhook', prompt: DEFAULT_PROMPTS['linear'], project: '/code/api', mode: 'plan', secret: 'lin_wh', header: 'Linear-Signature', match: { type: 'Issue', action: 'create', 'data.labels.name': 'wisp' } },
  });
  // left empty, the prompt is v1's for its kind (the server refuses a trigger that asks nothing)
  expect(specOfForm({ ...pick(f, 'linear'), secret: 'lin_wh' })).toMatchObject({ spec: { prompt: DEFAULT_PROMPTS['linear'] } });
  expect(DEFAULT_PROMPTS['linear']).toContain('{event.payload.data.title}');
  expect(specOfForm({ ...pick(f, 'ci'), prompt: '' })).toMatchObject({ spec: { prompt: DEFAULT_PROMPTS['ci'] } });
  expect(specOfForm({ ...pick(f, 'linear'), secret: 'lin_wh', prompt: 'mine' })).toMatchObject({ spec: { prompt: 'mine' } });
  const anyIssue = specOfForm({ ...pick(f, 'linear'), secret: 'lin_wh' });
  expect('spec' in anyIssue && anyIssue.spec['match']).toEqual({ type: 'Issue', action: 'create' });
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
