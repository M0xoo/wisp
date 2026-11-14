// The `doc` block's reading of a markdown file (v1 web/js/ui/reader.js + blocks.js R.doc), DOM-free.

/** The opening shown in the answer; the rest is a click away. */
export const DOC_PREVIEW_LINES = 48;

/** YAML front matter is for tools, not readers. */
export const docBody = (text: string): string => text.replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n+/, '');

/** The doc's own title: what the agent called it, its first heading, else the file's name. */
export function docTitle(title: string, text: string, path: string): string {
  return title || /^#\s+(.+)/m.exec(docBody(text))?.[1]?.trim() || path.split(/[\\/]/).pop() || '';
}

export interface DocStats {
  readonly lines: number;
  readonly words: number;
  readonly minutes: number;
}

export function docStats(text: string): DocStats {
  const body = docBody(text);
  const words = (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  return { lines: body.replace(/\n+$/, '').split('\n').length, words, minutes: Math.max(1, Math.round(words / 220)) };
}

/**
 * The opening to render: the first DOC_PREVIEW_LINES lines, without a top heading that repeats the
 * title; a cut through a code fence closes it. `whole`: nothing was cut.
 */
export function docPreview(text: string, title: string): { readonly source: string; readonly whole: boolean } {
  const head = docBody(text).replace(/^#\s+(.+)\n+/, (m, h: string) => (h.trim() === title ? '' : m));
  const lines = head.split('\n');
  let source = lines.slice(0, DOC_PREVIEW_LINES).join('\n');
  if ((source.match(/^\s*```/gm) ?? []).length % 2) source += '\n```';
  return { source, whole: lines.length <= DOC_PREVIEW_LINES };
}
