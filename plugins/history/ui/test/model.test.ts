import { expect, test } from 'vitest';
import { byMonth, repoLine, resumePrompt, type RepoTask } from '../src/model.ts';
import { t } from '../src/i18n.ts';

const task = (id: string, at: number, more: Partial<RepoTask> = {}): RepoTask => ({ id, title: id, agent: 'claude', by: 'ada', createdAt: at, pr: '', commits: 0, files: 1, level: 'report', path: `.wisp/tasks/${id}.task.yml`, ...more });

test('the_repo_tab_groups_the_repos_history_by_month_and_says_who_made_what', () => {
  const month = (at: number): string => (at < 100 ? 'October' : 'November');
  expect(byMonth([task('a', 10), task('b', 150), task('c', 120)], month).map((g) => [g.label, g.tasks.map((x) => x.id)])).toEqual([
    ['November', ['b', 'c']],
    ['October', ['a']],
  ]);
  const say = t as (k: string, v?: Readonly<Record<string, string | number>>) => string;
  expect(repoLine(task('a', 1, { pr: '#812' }), say)).toBe('ada · claude · #812');
  expect(repoLine(task('a', 1, { commits: 3, by: '' }), say)).toBe('claude · 3 commits');
  expect(resumePrompt('Fix login', 'fix it', 'done')).toContain('Carry on with an earlier task: "Fix login".');
});
