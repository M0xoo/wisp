// A language server for the tests (server/lsp.js): speaks LSP's frames, knows `function name` as
// a definition, every whole-word use as a reference, hovers a function's line, and flags TODO.
const docs = new Map(); // uri -> text
let buf = Buffer.alloc(0);
const send = (msg) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
};
const wordAt = (text, { line, character }) => {
  const l = text.split('\n')[line] || '';
  let a = character;
  let b = character;
  while (a > 0 && /\w/.test(l[a - 1])) a--;
  while (b < l.length && /\w/.test(l[b])) b++;
  return l.slice(a, b);
};
const find = (re) => {
  const out = [];
  for (const [uri, text] of docs) text.split('\n').forEach((l, i) => { for (const m of l.matchAll(re)) out.push({ uri, range: { start: { line: i, character: m.index }, end: { line: i, character: m.index + m[0].length } } }); });
  return out;
};
const diagnose = (uri) => send({ method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: find(/TODO/g).filter((x) => x.uri === uri).map((x) => ({ range: x.range, severity: 2, message: 'Something is left to do' })) } });
function handle(m) {
  if (m.method === 'initialize') return send({ id: m.id, result: { capabilities: { definitionProvider: true, referencesProvider: true, hoverProvider: true } } });
  if (m.method === 'shutdown') return send({ id: m.id, result: null });
  if (m.method === 'exit') return process.exit(0);
  if (m.method === 'textDocument/didOpen') return docs.set(m.params.textDocument.uri, m.params.textDocument.text), diagnose(m.params.textDocument.uri);
  if (m.method === 'textDocument/didChange') return docs.set(m.params.textDocument.uri, m.params.contentChanges.at(-1).text), diagnose(m.params.textDocument.uri);
  const name = m.params?.position && wordAt(docs.get(m.params.textDocument.uri) || '', m.params.position);
  if (m.method === 'textDocument/definition') return send({ id: m.id, result: find(new RegExp(`(?<=function )${name}\\b`, 'g'))[0] || null });
  if (m.method === 'textDocument/references') return send({ id: m.id, result: find(new RegExp(`\\b${name}\\b`, 'g')) });
  if (m.method === 'textDocument/completion') return send({ id: m.id, result: { items: [{ label: 'add', detail: 'function add(a, b)' }, { label: 'addAll', insertText: 'addAll' }] } });
  if (m.method === 'textDocument/rename') {
    const changes = {};
    for (const x of find(new RegExp(`\\b${name}\\b`, 'g'))) (changes[x.uri] ||= []).push({ range: x.range, newText: m.params.newName });
    return send({ id: m.id, result: { changes } });
  }
  if (m.method === 'textDocument/hover') return send({ id: m.id, result: name ? { contents: { kind: 'markdown', value: `\`\`\`ts\nfunction ${name}(a: number, b: number): number\n\`\`\`` } } : null });
  if (m.id != null) send({ id: m.id, result: null });
}
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const head = buf.indexOf('\r\n\r\n');
    if (head < 0) return;
    const len = Number(/Content-Length: *(\d+)/i.exec(buf.slice(0, head).toString())[1]);
    if (buf.length < head + 4 + len) return;
    handle(JSON.parse(buf.slice(head + 4, head + 4 + len).toString()));
    buf = buf.slice(head + 4 + len);
  }
});
