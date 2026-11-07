// The plugin's part of the server's OpenAPI document (the edge merges every plugin's).
export const openapi = {
  '/sessions/{id}/lsp': { post: { summary: 'Ask the task’s language server: { op: definition | references | hover | diagnostics | rename | completion, path, text, line, col, newName }' } },
  '/lsp/install': { post: { summary: 'Install npm’s language servers (TypeScript, Pyright) into <home>/lsp: { lang }' } },
} as const;
