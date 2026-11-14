# wisp.lsp

Language intelligence for the side panel's editor (v1 `server/lsp.js`, `routes/lsp.js`).

## Intent

- A language server per task folder and language, started on the first question, found in the repo's
  `node_modules/.bin`, wisp's own `lsp` folder or PATH (`WISP_LSP_<LANG>` overrides).
- It answers where a name is defined, every place it is used, what it is, what's wrong in a file, what may
  come next, and renames a name across the task's files (only files inside the task's folder are written).
- The editor's unsaved copy is what the server reads.
- No server for a language: the editor keeps its text search, and offers to install one where wisp can.
