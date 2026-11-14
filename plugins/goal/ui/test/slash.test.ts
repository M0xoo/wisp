import { describe, expect, it } from 'vitest';
import { typedGoal } from '../src/slash-text.ts';
import { stepOf } from '../src/steps.ts';

describe('wisp.goal /goal in a reply box (v1 slash-text.js goalAsk, isGoalDrop)', () => {
  it('reads_goal_condition_drop_and_bare_and_nothing_else', () => {
    expect(typedGoal('/goal all tests pass')).toEqual({ t: 'set', text: 'all tests pass' });
    expect(typedGoal('  /GOAL  it works on a phone\n')).toEqual({ t: 'set', text: 'it works on a phone' });
    expect(typedGoal('/goal')).toEqual({ t: 'bare' });
    expect(typedGoal('/goal Drop')).toEqual({ t: 'drop' });
    expect(typedGoal('/goal off')).toEqual({ t: 'drop' });
    expect(typedGoal('/goal drop the table')).toEqual({ t: 'set', text: 'drop the table' });
    expect(typedGoal('/goals')).toBeNull();
    expect(typedGoal('fix it, /goal tests pass')).toBeNull();
  });
});

describe('wisp.goal check page (v1 goal-run.js: everything the judge said)', () => {
  it('a_judges_steps_show_its_words_in_full_and_its_tools_open_to_their_detail', () => {
    expect(stepOf({ kind: 'text', text: 'Looked at **math.js**.' })).toEqual({ icon: 'text', label: '', said: 'Looked at **math.js**.' });
    expect(stepOf({ kind: 'tool', tool: 'read', label: 'Read math.js', detail: '/p/math.js' })).toEqual({ icon: 'read', label: 'Read math.js', detail: '/p/math.js' });
    expect(stepOf({ kind: 'tool', tool: 'bash', label: 'npm test' })).toEqual({ icon: 'terminal', label: 'npm test' });
  });
});
