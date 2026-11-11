// The open task's keys (v1 kbd.js): the shell's shortcuts name an action, the task page does it, as its button
// or More menu would. A cancelable DOM event, so neither side holds the other: the page cancels what it handled.

export const TASK_KEY = 'wisp-task-key';

export type TaskKey =
  | 'reply'
  | 'later'
  | 'rename'
  | 'openIn'
  | 'shell'
  | 'pr'
  | 'changes'
  | 'transcript'
  | 'rerun'
  | 'fork'
  | 'ship'
  | 'done'
  | 'archive'
  | 'delete'
  | 'collapse'
  | 'top'
  | 'panel'
  | `answer:${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;
