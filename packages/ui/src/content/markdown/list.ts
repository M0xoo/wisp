// Lists: bullets and numbers, nested by indentation, task items, tight or loose. An item's lines
// are dedented and parsed as blocks again, so fences and lists inside items just work.
import type { Block, ListItem } from './ast.ts';
import { blank, FENCE, ITEM, startsBlock } from './patterns.ts';

type ParseBlocks = (lines: readonly string[]) => Block[];

interface Item {
  readonly item: ListItem;
  readonly end: number;
  /** A blank line sat inside the item, between its blocks. */
  readonly innerBlank: boolean;
  /** A blank line came after it (before a sibling, if one follows). */
  readonly blankAfter: boolean;
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Opens or closes a fence seen inside an item, so lines in it are never read as list markers. */
function fenceState(open: string | null, line: string): string | null {
  const m = FENCE.exec(line);
  if (!open) return m ? (m[2] ?? null) : null;
  const ch = open[0] ?? '`';
  const close = line.trim();
  return close.length >= open.length && close.split('').every((c) => c === ch) ? null : open;
}

function itemLines(lines: readonly string[], i: number, m: RegExpExecArray): { body: string[]; end: number } {
  const marker = m[2] ?? '-';
  const spaces = (m[5] ?? '').length;
  // Five or more spaces after the marker: the content is indented code, one space is the gap.
  const gap = spaces === 0 || spaces >= 5 ? 1 : spaces;
  const contentIndent = (m[1] ?? '').length + marker.length + gap;
  const first = spaces >= 5 ? ' '.repeat(spaces - 1) + (m[6] ?? '') : (m[6] ?? '');
  const body = [first];
  let fence = fenceState(null, first);
  let j = i + 1;
  for (; j < lines.length; j++) {
    const line = lines[j] ?? '';
    if (blank(line)) {
      body.push('');
      continue;
    }
    if (indentOf(line) >= contentIndent) {
      const own = line.slice(contentIndent);
      body.push(own);
      fence = fenceState(fence, own);
      continue;
    }
    // A lazy line continues the item's paragraph, unless it starts something else.
    const lazy = !fence && !blank(body[body.length - 1]) && !startsBlock(line) && !ITEM.test(line);
    if (!lazy) break;
    body.push(line.trim());
  }
  return { body, end: j };
}

function readItem(lines: readonly string[], i: number, m: RegExpExecArray, parse: ParseBlocks): Item {
  const { body, end } = itemLines(lines, i, m);
  let trailing = 0;
  while (body.length > 1 && blank(body[body.length - 1])) {
    body.pop();
    trailing++;
  }
  const task = /^\[([ xX])\][ \t]+/.exec(body[0] ?? '');
  if (task) body[0] = (body[0] ?? '').slice(task[0].length);
  const innerBlank = body.some((l, k) => blank(l) && k > 0 && k < body.length - 1);
  return {
    item: { task: task ? task[1] !== ' ' : null, c: parse(body) },
    end,
    innerBlank,
    blankAfter: trailing > 0,
  };
}

/** Whether `m` is a sibling of the list's first item: the same bullet, or the same delimiter. */
function sameKind(first: RegExpExecArray, m: RegExpExecArray): boolean {
  const ordered = first[3] !== undefined;
  if (ordered !== (m[3] !== undefined)) return false;
  return ordered ? first[4] === m[4] : first[2] === m[2];
}

export function list(lines: readonly string[], i: number, parse: ParseBlocks): { block: Block; end: number } | undefined {
  const first = ITEM.exec(lines[i] ?? '');
  if (!first) return undefined;
  const items: ListItem[] = [];
  let loose = false;
  let j = i;
  let gapBefore = false;
  while (j < lines.length) {
    const m = ITEM.exec(lines[j] ?? '');
    if (!m || !sameKind(first, m)) break;
    if (gapBefore) loose = true;
    const r = readItem(lines, j, m, parse);
    items.push(r.item);
    loose ||= r.innerBlank;
    gapBefore = r.blankAfter;
    j = r.end;
  }
  const ordered = first[3] !== undefined;
  return { block: { t: 'list', ordered, start: ordered ? Number(first[3]) : 1, tight: !loose, items }, end: j };
}
