// The plugin's part of the server's OpenAPI document (the edge merges every plugin's).
export const openapi = {
  '/sessions/{id}/term': {
    get: { summary: 'A take over terminal’s output, as server-sent events (hello, data, exit, gone)' },
    post: { summary: 'Type into a take over terminal ({ data, seq?, from? }), or resize it ({ cols, rows })' },
    delete: { summary: 'Close a take over terminal' },
  },
  '/sessions/{id}/shell': {
    get: { summary: 'The task’s shell, as server-sent events (as /term)' },
    post: { summary: 'Start the task’s shell ({ cols, rows, restart? }), type into it ({ data }) or resize it' },
    delete: { summary: 'End the task’s shell' },
  },
  '/sessions/{id}/open-shell': {
    post: { summary: 'Open the task’s folder in the terminal app from Settings, on this desktop' },
  },
} as const;
