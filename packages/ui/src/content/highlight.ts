// A tiny highlighter for code blocks: comments, strings, numbers, keywords and capitalised type
// names, nothing else. It makes spans (never HTML), and gives up on unknown languages and on
// very large blocks, which render plain.

export type TokenKind = 'k' | 's' | 'c' | 'n' | 't';

export interface Token {
  readonly kind: TokenKind | null;
  readonly text: string;
}

const C_LIKE = ['js', 'jsx', 'ts', 'tsx', 'javascript', 'typescript', 'mjs', 'cjs', 'json', 'jsonc', 'java', 'c', 'h', 'cpp', 'cc', 'cs', 'go', 'rust', 'rs', 'swift', 'kotlin', 'kt', 'css', 'scss', 'dart', 'scala', 'php'];
const HASH = ['sh', 'bash', 'zsh', 'shell', 'console', 'py', 'python', 'rb', 'ruby', 'yaml', 'yml', 'toml', 'ini', 'dockerfile', 'make', 'makefile', 'r', 'perl', 'pl', 'nix'];

const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const continue def default defer del delete do elif else enum export extends ' +
    'false final finally fn for from func function go if impl implements import in instanceof interface is lambda let loop match mod ' +
    'module mut namespace new nil none not null of or and package pass private protected pub public raise readonly return satisfies ' +
    'self static struct super switch this throw true try type typeof undefined unless until use var void when where while with yield ' +
    'echo export local then fi esac done elif True False None'
  ).split(' '),
);

// Alternatives in order: block/line comment, hash comment, string, number, identifier.
const C_RULES = /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\w.]*)|([A-Za-z_$][\w$]*)/g;
const HASH_RULES = /(#[^\n]*)|("(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?)|(\b\d[\w.]*)|([A-Za-z_$][\w$-]*)/g;

const MAX = 50_000;

function family(lang: string): RegExp | null {
  const l = lang.toLowerCase();
  if (C_LIKE.includes(l)) return C_RULES;
  if (HASH.includes(l)) return HASH_RULES;
  return null;
}

function kindOf(m: RegExpExecArray): TokenKind | null {
  if (m[1] !== undefined) return 'c';
  if (m[2] !== undefined) return 's';
  if (m[3] !== undefined) return 'n';
  const word = m[4] ?? '';
  if (KEYWORDS.has(word)) return 'k';
  return /^[A-Z][a-z]/.test(word) ? 't' : null;
}

/** Splits `code` into tokens; plain text has `kind: null`. Joining the texts gives `code` back. */
export function highlight(code: string, lang: string | undefined): Token[] {
  const rules = lang ? family(lang) : null;
  if (!rules || code.length > MAX) return [{ kind: null, text: code }];
  const re = new RegExp(rules.source, 'g');
  const out: Token[] = [];
  let at = 0;
  const plain = (text: string): void => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.kind === null) out[out.length - 1] = { kind: null, text: last.text + text };
    else out.push({ kind: null, text });
  };
  for (let m = re.exec(code); m; m = re.exec(code)) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    plain(code.slice(at, m.index));
    const kind = kindOf(m);
    if (kind) out.push({ kind, text: m[0] });
    else plain(m[0]);
    at = m.index + m[0].length;
  }
  plain(code.slice(at));
  return out;
}
