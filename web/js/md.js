// Tiny markdown + syntax highlighting. Enough for agent output; no dependencies.

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function inline(src) {
  const codes = [];
  let s = esc(src).replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(c) - 1}\u0000`);
  s = s
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
    .replace(/(^|\W)_([^_\s][^_]*)_(?=\W|$)/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[i]}</code>`);
}

export function md(src = '') {
  const lines = String(src).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\S*)/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre class="code"><code>${highlight(buf.join('\n'), fence[1])}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      out.push(`<h${h[1].length + 2}>${inline(h[2])}</h${h[1].length + 2}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\1]*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push(`<blockquote>${md(buf.join('\n'))}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:-]+\|[\s|:-]*$/.test(lines[i + 1] || '')) {
      const row = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = row(line);
      i += 2;
      const body = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) body.push(row(lines[i++]));
      out.push(
        `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
        if (m) items.push(m[3]);
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += ' ' + lines[i].trim();
        else break;
        i++;
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(
        `<${tag}>${items
          .map((t) => {
            const task = t.match(/^\[( |x)\]\s+(.*)/i);
            return task ? `<li class="task ${task[1] === ' ' ? '' : 'done'}">${inline(task[2])}</li>` : `<li>${inline(t)}</li>`;
          })
          .join('')}</${tag}>`,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,4}\s|>|[-*+]\s|\d+[.)]\s|\|)/.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('');
}

export const inlineMd = inline;

// --- highlighting -----------------------------------------------------------

const KEYWORDS = new Set(
  (
    'abstract as async await break case catch class const continue def default defer del delete do elif else enum export extends ' +
    'false final finally fn for from func function go if impl import in instanceof interface is let match mod module mut new nil ' +
    'none null package pass private protected pub public raise return self select static struct super switch this throw throws ' +
    'true try type typeof undefined use var void while with yield lambda not and or None True False readonly override'
  ).split(' '),
);

const TOKEN =
  /(\/\/[^\n]*|#(?![\w{[])[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d[\d_.]*(?:e[+-]?\d+)?[a-z]*\b|\b[A-Za-z_$][\w$]*\b|[^\sA-Za-z_$\d"'`/#]+|\s+|.)/g;

export function highlight(code, lang = '') {
  lang = lang.toLowerCase();
  if (['', 'text', 'txt', 'plain', 'output', 'log'].includes(lang)) return esc(code);
  const shellish = ['sh', 'bash', 'zsh', 'shell', 'console', 'yaml', 'yml', 'toml', 'py', 'python', 'rb', 'ruby'].includes(lang);
  let out = '';
  for (const [tok] of code.matchAll(TOKEN)) {
    let cls = '';
    if (/^(\/\/|\/\*)/.test(tok) || (tok.startsWith('#') && shellish)) cls = 'c';
    else if (tok.startsWith('#')) cls = '';
    else if (/^["'`]/.test(tok)) cls = 's';
    else if (/^\d/.test(tok)) cls = 'n';
    else if (KEYWORDS.has(tok)) cls = 'k';
    else if (/^[A-Z][\w$]*$/.test(tok)) cls = 't';
    if (cls === '' && tok.startsWith('#') && !shellish) {
      out += esc(tok);
      continue;
    }
    out += cls ? `<span class="tk-${cls}">${esc(tok)}</span>` : esc(tok);
  }
  return out;
}

export function langOf(file = '') {
  const ext = file.split('.').pop().toLowerCase();
  return { mjs: 'js', cjs: 'js', jsx: 'js', tsx: 'ts', yml: 'yaml' }[ext] || ext;
}
