// Save to My Stuff, the pure half (v1 web/js/blocks.js plainTitle, hashText, and what each block keeps): which thing a
// button names within its turn, and what it hands the host to save. The button is ./keep-button.tsx.
import type { AnswerBlock, KeepWhat } from './types.ts';
import { opt, str } from './read.ts';
import { langOf } from './content-util.ts';

/** A card's title from a caption: no markdown marks, one line, 80 characters at most (v1 plainTitle). */
export function plainTitle(t: string | undefined): string | undefined {
  const s = String(t ?? '')
    .replace(/[*_`#>[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return s || undefined;
}

/** A short stable name for a snippet (v1 hashText, djb2), so saving the same code twice finds the one kept. */
export function hashText(t: string): string {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

const baseName = (p: string): string | undefined => p.split(/[\\/]/).filter(Boolean).pop() || undefined;

/** A picture's or video's: the file the agent named (its original when wisp kept a copy, v1 `b.source || b.path`). */
export function mediaKeep(block: AnswerBlock, kind: 'image' | 'video'): { readonly what: string; readonly it: KeepWhat } | undefined {
  const path = opt(block['path']) ?? opt(block['src']);
  if (!path) return undefined;
  const named = opt(block['source']) ?? path;
  const title = plainTitle(opt(block['caption']));
  return { what: `media:${named}`, it: { kind, path, ...(title && { title }) } };
}

/** A code block's: its text (as the answer shows it, so a masked .env stays masked), language and file name. */
export function codeKeep(block: AnswerBlock, lang: string): { readonly what: string; readonly it: KeepWhat } {
  const code = str(block['code']);
  const file = str(block['file']);
  const name = baseName(file);
  const l = lang || langOf(file);
  const title = plainTitle(opt(block['caption'])) ?? name ?? `${l || 'Code'} snippet`;
  return { what: `code:${file}:${hashText(code)}`, it: { kind: 'code', text: code, lang: l || 'text', ...(name && { name }), title } };
}

/** A doc block's: the markdown it shows, under its file's name. */
export function docKeep(path: string, title: string, text: string): { readonly what: string; readonly it: KeepWhat } {
  const name = baseName(path);
  return { what: `doc:${path || title}`, it: { kind: 'doc', text, ...(name && { name }), title } };
}
