// @wisp-plugin/issues-api: the contract of wisp.issues. Issues to start a task from (New task →
// Issue, ⌘K): a project's open GitHub issues through gh, or the Linear / Jira issues assigned to you
// when a connector holds their keys. A failure comes back as words the picker shows, with what fixes
// it, never as a thrown error.

export interface Issue {
  id: string;
  ref: string;
  number: number | string;
  title: string;
  url: string;
  labels: string[];
  assignee: string;
  body: string;
  updatedAt: string | null;
}

export type IssueSource = 'github' | 'linear' | 'jira';

export interface IssueList {
  source: IssueSource;
  issues: Issue[];
  linear: boolean;
  jira: boolean;
  repo?: string;
  error?: string;
  fix?: 'install' | 'signin' | 'remote' | 'linear' | 'jira' | 'project';
}

export const COMMANDS = {
  /** { source?, project?, q? } → IssueList */
  list: 'issues.list',
} as const;
