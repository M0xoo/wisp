// Block Markdown: headings, fences, indented code, rules, quotes, lists, tables, paragraphs.
// Line based and forgiving: an unclosed fence runs to the end, so a streaming answer renders
// while it's still arriving.
import type { Block, CellAlign, Inline } from './ast.ts';
import { parseInline } from './inline.ts';
import { list } from './list.ts';
import { splitRow, DELIM } from './table.ts';
import { blank, FENCE, HEADING, HR, QUOTE, startsBlock } from './patterns.ts';

export interface Parsed {
  readonly block: Block;
  readonly end: number;
}

function fence(lines: readonly string[], i: number): Parsed | undefined {
  const m = FENCE.exec(lines[i] ?? '');
  if (!m) return undefined;
  const indent = (m[1] ?? '').length;
  const marker = m[2] ?? '```';
  const closer = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
  const body: string[] = [];
  let j = i + 1;
  for (; j < lines.length; j++) {
    const line = lines[j] ?? '';
    if (closer.test(line)) return { block: { t: 'code', lang: m[3] ?? '', v: body.join('\n') }, end: j + 1 };
    // Content keeps its own indentation, less the fence's.
    body.push(line.replace(new RegExp(`^ {0,${indent}}`), ''));
  }
  return { block: { t: 'code', lang: m[3] ?? '', v: body.join('\n') }, end: j };
}

function heading(lines: readonly string[], i: number): Parsed | undefined {
  const m = HEADING.exec(lines[i] ?? '');
  if (!m) return undefined;
  const level = (m[1] ?? '#').length as 1 | 2 | 3 | 4 | 5 | 6;
  return { block: { t: 'heading', level, c: parseInline(m[2] ?? '') }, end: i + 1 };
}

function rule(lines: readonly string[], i: number): Parsed | undefined {
  return HR.test(lines[i] ?? '') ? { block: { t: 'hr' }, end: i + 1 } : undefined;
}

function quote(lines: readonly string[], i: number): Parsed | undefined {
  if (!QUOTE.test(lines[i] ?? '')) return undefined;
  const body: string[] = [];
  let j = i;
  for (; j < lines.length; j++) {
    const line = lines[j] ?? '';
    if (QUOTE.test(line)) body.push(line.replace(QUOTE, ''));
    // A lazy line carries on the quote's paragraph.
    else if (!blank(line) && !blank(body[body.length - 1]) && !startsBlock(line)) body.push(line);
    else break;
  }
  return { block: { t: 'quote', c: parseBlocks(body) }, end: j };
}

function table(lines: readonly string[], i: number): Parsed | undefined {
  const head = lines[i] ?? '';
  const delim = lines[i + 1];
  if (!head.includes('|') || delim === undefined || !delim.includes('|') || !DELIM.test(delim)) return undefined;
  const align: CellAlign[] = splitRow(delim).map((c) => {
    const cell = c.trim();
    if (cell.startsWith(':') && cell.endsWith(':')) return 'center';
    if (cell.endsWith(':')) return 'right';
    return cell.startsWith(':') ? 'left' : null;
  });
  const headCells = splitRow(head);
  if (headCells.length !== align.length) return undefined;
  const cells = (row: readonly string[]): Inline[][] => align.map((_, k) => parseInline((row[k] ?? '').trim()));
  const rows: Inline[][][] = [];
  let j = i + 2;
  for (; j < lines.length && !blank(lines[j]) && (lines[j] ?? '').includes('|'); j++) rows.push(cells(splitRow(lines[j] ?? '')));
  return { block: { t: 'table', align, head: cells(headCells), rows }, end: j };
}

function indented(lines: readonly string[], i: number): Parsed | undefined {
  if (!/^ {4}/.test(lines[i] ?? '')) return undefined;
  const body: string[] = [];
  let j = i;
  for (; j < lines.length && (blank(lines[j]) || /^ {4}/.test(lines[j] ?? '')); j++) body.push((lines[j] ?? '').slice(4));
  while (body.length > 0 && blank(body[body.length - 1])) body.pop();
  // Trailing blank lines belong to the gap after the block, not to the code.
  while (j > i && blank(lines[j - 1])) j--;
  return { block: { t: 'code', lang: '', v: body.join('\n') }, end: j };
}

function paragraph(lines: readonly string[], i: number): Parsed {
  const body: string[] = [];
  let j = i;
  for (; j < lines.length; j++) {
    const line = lines[j] ?? '';
    if (blank(line) || (j > i && (startsBlock(line) || table(lines, j)))) break;
    body.push(line.replace(/^\s+/, ''));
  }
  return { block: { t: 'paragraph', c: parseInline(body.join('\n').replace(/\s+$/, '')) }, end: j };
}

/** Parses lines into blocks; lists and quotes call back in for their content. */
export function parseBlocks(lines: readonly string[]): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (blank(lines[i])) {
      i++;
      continue;
    }
    const r = fence(lines, i) ?? heading(lines, i) ?? rule(lines, i) ?? quote(lines, i) ?? list(lines, i, parseBlocks) ?? table(lines, i) ?? indented(lines, i) ?? paragraph(lines, i);
    out.push(r.block);
    i = r.end;
  }
  return out;
}

/** Markdown source → blocks. Tabs count as four spaces; Windows line ends are fine. */
export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}
