// Just enough shell to describe a command line: heredoc bodies dropped, the line split into
// pipelines, stages and words, and each stage stripped down to the command that does the work.

/** A command line: pipelines (split by && || ; & newline), each a list of stages, each a list of words. */
export type Pipeline = string[][];

/** A stage with its redirects read off: `out` is the file `>`/`>>` writes, `input` the file `<` reads. */
export interface Stage {
  argv: string[];
  out: string | null;
  input: string | null | undefined;
}

// Drop heredoc bodies so their lines aren't read as commands: `cat <<EOF > f\n…\nEOF` → `cat <<EOF > f`.
export function stripHeredocs(s: string): string {
  return s.replace(/(<<-?\s*(['"]?)([\w-]+)\2)([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/g, '$1$4');
}

interface Tokens {
  out: Pipeline[];
  pipe: Pipeline;
  words: string[];
  /** The word being read; null between words, so an empty quoted word ('') still counts as one. */
  word: string | null;
}

const endWord = (t: Tokens): void => {
  if (t.word !== null) t.words.push(t.word);
  t.word = null;
};
const endStage = (t: Tokens): void => {
  endWord(t);
  if (t.words.length) t.pipe.push(t.words);
  t.words = [];
};
const endPipe = (t: Tokens): void => {
  endStage(t);
  if (t.pipe.length) t.out.push(t.pipe);
  t.pipe = [];
};

// Split into pipelines → stages → words. Quotes are honoured; $(…) and `…` stay inside the word
// they appear in.
export function segments(s: string): Pipeline[] {
  const t: Tokens = { out: [], pipe: [], words: [], word: null };
  for (let i = 0; i < s.length; i++) {
    const c = s.charAt(i);
    const next = s[i + 1];
    const q = quoted(s, i);
    if (q) {
      if (q.add !== null) t.word = (t.word ?? '') + q.add;
      i = q.end;
    } else if (c === '|' && next !== '|') {
      endStage(t);
    } else if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      endPipe(t);
      i++;
    } else if (c === ';' || c === '\n' || (c === '&' && next !== '>' && s[i - 1] !== '>')) {
      endPipe(t);
    } else if (c === '&' && next === '>') {
      endWord(t);
      t.words.push(s[i + 2] === '>' ? '&>>' : '&>');
      i += s[i + 2] === '>' ? 2 : 1;
    } else if (c === '>' || c === '<') {
      i = redirect(t, s, i);
    } else if (/\s/.test(c)) {
      endWord(t);
    } else if ((c === '(' || c === ')' || c === '{' || c === '}') && t.word === null) {
      endWord(t); // subshells and groups: describe what's inside
    } else {
      t.word = (t.word ?? '') + c;
    }
  }
  endPipe(t);
  return t.out;
}

/**
 * Quotes, escapes, $(…) and `…` at `i`: the text they add to the current word (null: nothing, not
 * even an empty word) and the index of their last character. Null when `i` starts none of them.
 */
function quoted(s: string, i: number): { add: string | null; end: number } | null {
  const c = s[i];
  if (c === "'") {
    const j = s.indexOf("'", i + 1);
    const end = j < 0 ? s.length : j;
    return { add: s.slice(i + 1, end), end };
  }
  if (c === '"') {
    let j = i + 1;
    let buf = '';
    while (j < s.length && s[j] !== '"') {
      if (s[j] === '\\' && j + 1 < s.length) j++;
      buf += s.charAt(j++);
    }
    return { add: buf, end: j };
  }
  if (c === '\\' && i + 1 < s.length) {
    const e = s.charAt(i + 1);
    return { add: e === '\n' ? null : e, end: i + 1 }; // a line continuation joins, it adds nothing
  }
  if (c === '$' && s[i + 1] === '(') {
    let depth = 0;
    let j = i + 1;
    for (; j < s.length; j++) {
      if (s[j] === '(') depth++;
      else if (s[j] === ')' && --depth === 0) break;
    }
    return { add: s.slice(i, j + 1), end: j };
  }
  if (c === '`') {
    const j = s.indexOf('`', i + 1);
    const end = j < 0 ? s.length : j;
    return { add: s.slice(i, end + 1), end };
  }
  return null;
}

// Redirects become their own word ('>', '>>', '<', '2>&1' …) so stages can read targets. Returns
// the index of the operator's last character.
function redirect(t: Tokens, s: string, i: number): number {
  endWord(t);
  let op = s.charAt(i);
  const fd = t.words.at(-1) ?? '';
  // `2>`: a lone digit word right before the operator is its file descriptor.
  if (/^\d$/.test(fd) && !/\s/.test(s[i - 1] ?? '')) {
    t.words.pop();
    op = fd + op;
  }
  while (s[i + 1] === '>' || s[i + 1] === '&' || s[i + 1] === '<') op += s.charAt(++i);
  if (/&$/.test(op) && /\d/.test(s[i + 1] ?? '')) op += s.charAt(++i);
  t.words.push(op);
  return i;
}

const WRAPPERS = new Set(['sudo', 'time', 'nohup', 'command', 'exec', 'nice', 'caffeinate', 'stdbuf', 'unbuffer']);
const CONTROL = new Set(['then', 'else', 'elif', 'do', 'done', 'fi', 'esac', '!']);
const ASSIGNMENT = /^[A-Za-z_]\w*=/;

// Peel off redirects, env assignments and wrappers. `out` ignores /dev/null and fd duplications.
export function parseStage(words: readonly string[]): Stage {
  const argv: string[] = [];
  let out: string | null = null;
  let input: string | null | undefined = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? '';
    if (/^\d*(>>?|&>>?)$/.test(w)) {
      const target = words[++i];
      if (target && target !== '/dev/null') out = target;
    } else if (/^\d*<$/.test(w)) {
      input = words[++i];
    } else if (/^\d*[<>]+&?\d*$/.test(w) || /^<<-?/.test(w)) {
      if (/^<<-?$/.test(w)) i++; // heredoc delimiter
    } else {
      argv.push(w);
    }
  }
  peel(argv);
  return { argv, out, input };
}

// Drop what runs the command rather than being it: `FOO=1 sudo -E timeout 60 xargs -n 1 cmd` → `cmd`.
function peel(argv: string[]): void {
  for (;;) {
    const w = argv[0];
    if (w === undefined) break;
    if (ASSIGNMENT.test(w) || CONTROL.has(w)) argv.shift();
    else if (w === 'env') {
      argv.shift();
      while (argv[0] && (argv[0].startsWith('-') || ASSIGNMENT.test(argv[0]))) argv.shift();
    } else if (WRAPPERS.has(w)) {
      argv.shift();
      while (argv[0]?.startsWith('-')) argv.shift();
    } else if (w === 'timeout' || w === 'gtimeout') {
      argv.shift();
      while (argv[0]?.startsWith('-')) argv.shift();
      argv.shift(); // the duration
    } else if (w === 'xargs') {
      argv.shift();
      while (argv[0]?.startsWith('-')) argv.splice(0, /^-[IdLnPsE]$/.test(argv[0]) ? 2 : 1);
    } else break;
  }
}
