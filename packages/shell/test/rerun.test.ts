// Rerun… (src/frame/rerun.ts, v1 actions.js rerunDialog): a new task from the old one's spec, as edited, where picked.
import { expect, test } from 'vitest';
import { rerunArgs, startEdits } from '../src/frame/rerun.ts';

const spec = { prompt: 'Fix the login bug', steps: ['then run the tests'], agent: 'claude', model: 'opus', effort: 'high', mode: 'edits', cwd: '/code/web', dirs: ['/code/api'] };

test('the dialog starts as the task ran; the prompt, mode and harness can change; the old task is kept_v1_rerun_dialog', () => {
  const e = startEdits(spec, 'laptop');
  expect(e).toEqual({ prompt: 'Fix the login bug', mode: 'edits', agent: 'claude', model: 'opus', effort: 'high', peer: 'laptop' });
  expect(rerunArgs(spec, { ...e, prompt: '  Fix the login bug, and the signup one  ', mode: 'plan' }, { of: 'laptop:s1', id: 'laptop:s2', at: 5 })).toEqual({
    peer: 'laptop',
    id: 'laptop:s2',
    prompt: 'Fix the login bug, and the signup one',
    agent: 'claude',
    mode: 'plan',
    at: 5,
    model: 'opus',
    effort: 'high',
    cwd: '/code/web',
    dirs: ['/code/api'],
    steps: ['then run the tests'],
    lineage: { rerunOf: 'laptop:s1' },
  });
  // a harness picked from the toolbar's menu starts on its own default model
  expect(startEdits(spec, 'laptop', 'codex')).toMatchObject({ agent: 'codex', model: '', effort: '' });
});

test('picked on another computer, it runs there_v1_rerun_elsewhere', () => {
  const e = { ...startEdits(spec, 'laptop'), peer: 'studio' };
  expect(rerunArgs(spec, e, { of: 'laptop:s1', id: 'studio:s9', at: 1 })).toMatchObject({ peer: 'studio', id: 'studio:s9', lineage: { rerunOf: 'laptop:s1' } });
});
