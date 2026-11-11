import { expect, test } from 'vitest';
import { emptyLine, fixLabel, groupOf, issuePrompt, matches, others, type Issue } from '../src/model.ts';
import { t } from '../src/i18n.ts';

const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;

test('the_issue_picker_lists_a_sources_issues_offers_the_others_or_connect_and_writes_the_prompt', () => {
  const i: Issue = {
    id: '1',
    ref: '#12',
    number: 12,
    title: 'Login loops',
    url: 'https://github.com/o/r/issues/12',
    labels: ['bug'],
    assignee: 'ana',
    body: '  Steps:\n1. sign in  ',
    updatedAt: null,
  };
  expect(issuePrompt(i)).toBe('Fix #12: Login loops\n\nhttps://github.com/o/r/issues/12\n\nSteps:\n1. sign in');
  expect(issuePrompt({ ...i, body: '' })).toBe('Fix #12: Login loops\n\nhttps://github.com/o/r/issues/12');
  expect(groupOf('github', { repo: 'o/r' }, say)).toBe('Open issues · o/r');
  expect(groupOf('linear', { scope: 'all' }, say)).toBe('Open on Linear (none assigned to you)');
  expect(emptyLine('github', {}, 'web', say)).toBe('web has no open issues.');
  // from GitHub: Linear connected, Jira not (Connect Jira…)
  expect(others('github', { linear: true, jira: false }, { id: 'p1', name: 'web' }, say).map((o) => `${o.kind}:${o.source}`)).toEqual(['source:linear', 'connect:jira']);
  // from Linear with no folder: no GitHub (it needs a project)
  expect(others('linear', { linear: true, jira: true }, { id: '', name: '' }, say).map((o) => `${o.kind}:${o.source}`)).toEqual(['source:jira']);
  expect(fixLabel('signin')).toBe('issues.fix.signin');
  expect(fixLabel('nope')).toBeUndefined();
  expect([matches(i, 'login'), matches(i, '12 bug'), matches(i, 'ana'), matches(i, 'deploy')]).toEqual([true, true, true, false]);
});
