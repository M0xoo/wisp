// The routes wisp.later serves, for the edge's OpenAPI document (v1 server/openapi.js entries).
export const openapi = {
  '/sessions/{id}/later': {
    post: { summary: 'Schedule a follow-up (or, with remind: true, a reminder) on this task: { at | in (minutes), text, remind?, attachments? }' },
    patch: { summary: 'Change a scheduled follow-up { item, at | in, text }, send it now { item, now: true }, or snooze a reminder that came due { item: "reminder", at | in }' },
    delete: { summary: 'Cancel a scheduled follow-up (?item=<id>)' },
  },
  '/later': {
    get: { summary: 'Scheduled tasks and reminders that have no task yet (plans), drafts and /after ones included' },
    post: { summary: 'Schedule a task { kind: "task", at | in | draft | after, prompt, cwd, agent, … } or a reminder { kind: "reminder", at | in, text, from? }' },
  },
  '/later/{id}': {
    patch: { summary: 'Change a plan { at | in, text | prompt } or start it now { now: true }' },
    delete: { summary: 'Cancel a plan' },
  },
  '/internal/later': {
    post: { summary: 'resume_later: an agent schedules a follow-up into its own task { session, minutes | at, message } or cancels one { session, cancel }' },
  },
} as const;
