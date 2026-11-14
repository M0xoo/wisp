// Merge PR #n… from a task's menu (v1 ship.js mergePr, asked from anywhere): the task opens and its PR strip asks with
// its own confirm. The menu leaves the task's key here; the strip takes it once it shows that task.
import { signal } from '@wisp/client';

export const mergeRequest = signal<string | undefined>(undefined);
