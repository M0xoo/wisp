// Open in editor (v1 actions.js openInEditor, EDITORS): the editor Settings → General names opens a path through its
// own URL scheme; "none" (or one wisp doesn't know) copies the path instead. DOM-free.
const EDITORS: Readonly<Record<string, (f: string, l?: number) => string>> = {
  vscode: (f, l) => `vscode://file${f}${l ? `:${l}` : ''}`,
  cursor: (f, l) => `cursor://file${f}${l ? `:${l}` : ''}`,
  windsurf: (f, l) => `windsurf://file${f}${l ? `:${l}` : ''}`,
  zed: (f, l) => `zed://file${f}${l ? `:${l}` : ''}`,
  idea: (f, l) => `idea://open?file=${encodeURIComponent(f)}${l ? `&line=${l}` : ''}`,
};

/** The URL that opens `path` (absolute) in `editor` (vscode when unset), or undefined: copy the path instead. */
export function editorUrl(editor: string | undefined, path: string, line?: number): string | undefined {
  const e = editor || 'vscode';
  const make = EDITORS[e];
  return make && path.startsWith('/') ? make(path, line) : undefined;
}
