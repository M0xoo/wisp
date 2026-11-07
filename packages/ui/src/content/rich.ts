// Markdown, Diff and Code.
export { Markdown, type MarkdownProps } from './markdown/Markdown.tsx';
export { parseMarkdown } from './markdown/block.ts';
export { parseInline } from './markdown/inline.ts';
// Renamed on the way out: the kit already has an `Inline` (the row layout).
export { safeHref, type Block as MarkdownBlock, type CellAlign as MarkdownCellAlign, type Inline as MarkdownInline, type ListItem as MarkdownListItem } from './markdown/ast.ts';
export { Diff, type DiffProps } from './diff/Diff.tsx';
export { parseDiff, type DiffFile, type DiffHunk, type DiffLine, type DiffLineKind, type DiffStatus } from './diff/parse.ts';
export { Code, type CodeProps } from './Code.tsx';
export { highlight, type Token as CodeToken, type TokenKind as CodeTokenKind } from './highlight.ts';
