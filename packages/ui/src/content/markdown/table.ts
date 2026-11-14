// GFM table rows: split on pipes, except escaped ones (`\|`) and ones inside code spans.

export const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function split(line: string, respectCode: boolean): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  let code = 0; // length of the open code span's backtick run, 0 outside one
  for (let i = 0; i < s.length; i++) {
    const c = s[i] ?? '';
    if (c === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (c === '`' && respectCode) {
      let n = 1;
      while (s[i + n] === '`') n++;
      if (!code) code = n;
      else if (n === code) code = 0;
      cell += '`'.repeat(n);
      i += n - 1;
    } else if (c === '|' && !code) {
      cells.push(cell);
      cell = '';
    } else cell += c;
  }
  cells.push(cell);
  // A code span that never closes held no pipes after all: split again ignoring code.
  return code && respectCode ? split(line, false) : cells;
}

export function splitRow(line: string): string[] {
  return split(line, true);
}
