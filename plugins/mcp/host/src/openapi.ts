// The plugin's part of the server's OpenAPI document (the edge merges every plugin's).
export const openapi = {
  '/mcp': {
    post: { summary: 'One MCP JSON-RPC message (initialize, tools/list, tools/call, ping), as the caller its token speaks for: a task’s agent, or the user’s editor through `wisp mcp`' },
  },
} as const;
