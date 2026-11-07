// wisp.connectors' public routes, for the edge's OpenAPI document (the /internal ones and the OAuth
// callback are left out on purpose: `doc: false`).

export const openapi = {
  '/api/connectors': {
    get: { summary: 'The user’s connectors (MCP servers every task gets), servers found in the harnesses’ own configs, and which harnesses take them' },
    post: { summary: 'Add a connector; its env values and headers are kept as secrets and never come back' },
  },
  '/api/connectors/{id}': {
    patch: { summary: 'Change a connector; an empty secret value keeps the saved one' },
    delete: { summary: 'Remove a connector and its secrets' },
  },
  '/api/connectors/{id}/test': { post: { summary: 'Start a connector once and list its tools' } },
  '/api/connectors/import': { post: { summary: 'Import servers from the harnesses’ own configs by name, or dismiss them' } },
  '/api/connectors/{id}/signin': {
    post: { summary: 'Start signing in to a remote connector with OAuth: answers the URL to open' },
    delete: { summary: 'Sign out of a remote connector' },
  },
} as const;
