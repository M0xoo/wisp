// The Markdown tree the parser builds and Markdown.tsx renders. Plain data: no HTML ever, so
// whatever the source holds (`<script>`, `<img onerror>`) ends up as text.

export type Inline =
  | { readonly t: 'text'; readonly v: string }
  | { readonly t: 'code'; readonly v: string }
  | { readonly t: 'strong' | 'em' | 'del'; readonly c: readonly Inline[] }
  | { readonly t: 'link'; readonly href: string; readonly title: string | null; readonly c: readonly Inline[] }
  | { readonly t: 'br' };

export type CellAlign = 'left' | 'center' | 'right' | null;

export interface ListItem {
  /** `null` for a plain item; `true`/`false` for a task item, ticked or not. */
  readonly task: boolean | null;
  readonly c: readonly Block[];
}

export type Block =
  | { readonly t: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly c: readonly Inline[] }
  | { readonly t: 'paragraph'; readonly c: readonly Inline[] }
  | { readonly t: 'code'; readonly lang: string; readonly v: string }
  | { readonly t: 'list'; readonly ordered: boolean; readonly start: number; readonly tight: boolean; readonly items: readonly ListItem[] }
  | { readonly t: 'quote'; readonly c: readonly Block[] }
  | {
      readonly t: 'table';
      readonly align: readonly CellAlign[];
      readonly head: readonly (readonly Inline[])[];
      readonly rows: readonly (readonly (readonly Inline[])[])[];
    }
  | { readonly t: 'hr' };

const SAFE_SCHEMES = new Set(['http', 'https', 'mailto']);

/**
 * The href to render, or `undefined` when the link must stay text. Relative paths and `#anchors`
 * pass; of absolute URLs only http, https and mailto do (no javascript:, data:, vbscript:).
 */
export function safeHref(url: string): string | undefined {
  const href = url.trim();
  // Browsers drop control characters and spaces while reading a scheme (`java\nscript:`), so
  // the check reads the URL the same way before looking for one.
  const probe = href.replace(/[\u0000- \u007f]/g, '').toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  if (!scheme) return href;
  return SAFE_SCHEMES.has(scheme[1] ?? '') ? href : undefined;
}
