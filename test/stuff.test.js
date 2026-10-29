// My Stuff (server/services/stuff.js, routes/stuff.js): what the user and their agents keep from
// tasks. A save is a copy, so it outlives the task's folder; the same thing saved twice is one item.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, tmp, until } from './helpers.js';
import { kindOf, Stuff } from '../server/services/stuff.js';

process.env.WISP_HOME = tmp('stuff-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
process.env.FAKE_RECORD = tmp('stuff-rec');
installFakeBins();
const { startServer } = await import('../server/index.js');
const { systemPrompt } = await import('../server/protocol.js');

// A 1×1 PNG.
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4b40000000049454e44ae426082', 'hex');

test('kindOf: pictures, videos, docs, code and the rest by their extension', () => {
  assert.equal(kindOf('shot.PNG'), 'image');
  assert.equal(kindOf('demo.webm'), 'video');
  assert.equal(kindOf('plan.md'), 'doc');
  assert.equal(kindOf('report.pdf'), 'doc');
  assert.equal(kindOf('limiter.ts'), 'code');
  assert.equal(kindOf('Dockerfile'), 'code');
  assert.equal(kindOf('build.zip'), 'file');
});

test('Stuff: files, text and links are kept, found by words, edited and removed; it reloads from disk', () => {
  const dir = tmp('stuff-dir');
  let changes = 0;
  const st = new Stuff(dir, { onChange: () => changes++ });
  const src = path.join(tmp('stuff-src'), 'logo.png');
  fs.writeFileSync(src, PNG);
  const img = st.addFile(src, { title: 'The logo', tags: ['Brand', '#logo'], by: 'agent' });
  assert.equal(img.kind, 'image');
  assert.equal(img.mime, 'image/png');
  assert.deepEqual(img.tags, ['brand', 'logo']);
  assert.ok(img.path.startsWith(dir) && fs.existsSync(img.path), 'a copy in its own folder');
  fs.rmSync(src);
  assert.ok(fs.existsSync(img.path), 'outlives the original');

  const doc = st.addText('---\ntitle: x\n---\n# Launch plan\n\nShip on Monday.\n', { title: 'Launch plan' });
  assert.equal(doc.kind, 'doc');
  assert.equal(doc.name, 'launch-plan.md');
  assert.match(doc.excerpt, /^# Launch plan\n\nShip on Monday\./, 'the opening, without front matter, lines kept');
  const code = st.addText('export const x = 1;\n', { lang: 'typescript' });
  assert.equal(code.kind, 'code');
  assert.match(code.name, /^snippet\.ts$/);
  const link = st.addLink('https://www.example.com/a?b=1', { note: 'the spec' });
  assert.equal(link.kind, 'link');
  assert.equal(link.title, 'example.com');
  assert.throws(() => st.addLink('javascript:alert(1)'), /http/);
  assert.throws(() => st.addText('  '), /empty/);

  assert.deepEqual(st.search('brand').map((x) => x.id), [img.id]);
  assert.deepEqual(st.search('spec').map((x) => x.id), [link.id], 'by its note');
  assert.deepEqual(st.search('', 'code').map((x) => x.id), [code.id]);
  assert.equal(st.view(img).path, undefined, 'the page never sees paths on this computer');

  const edited = st.update(img.id, { title: 'Logo, final', starred: true, note: 'x'.repeat(3000) });
  assert.equal(edited.title, 'Logo, final');
  assert.equal(edited.starred, true);
  assert.equal(edited.note.length, 2000);
  assert.equal(st.update(img.id, { title: '  ' }).title, 'Logo, final', 'an empty title keeps the old one');

  const again = new Stuff(dir);
  assert.equal(again.list().length, 4);
  assert.equal(again.get(img.id).title, 'Logo, final');
  assert.ok(st.remove(code.id));
  assert.ok(!fs.existsSync(code.path));
  assert.equal(new Stuff(dir).list().length, 3);
  assert.ok(changes >= 6);
});

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let srv;
let base;
before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

async function api(p, body, method = body ? 'POST' : 'GET', headers = {}) {
  const r = await fetch(`${base}/api${p}`, { method, headers: { ...(method === 'GET' ? {} : { 'content-type': 'application/json' }), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) throw Object.assign(new Error(`${p}: ${j.error}`), { status: r.status });
  return j;
}
const task = async (prompt) => {
  const s = await api('/sessions', { prompt, cwd: makeRepo(), agent: 'claude', worktree: false });
  await until(async () => (await api(`/sessions/${s.id}`)).state !== 'running' && !srv.runner.live.has(s.id));
  return s;
};

test('the page saves a task’s file, text and links; the same key is the same item; it serves, edits and removes them', async () => {
  const s = await task('make a screenshot');
  const cwd = srv.store.get(s.id).cwd;
  fs.writeFileSync(path.join(cwd, 'shot.png'), PNG);
  const key = `${s.id}|t1|media:shot.png`;
  const r = await fetch(`${base}/api/stuff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: s.id, path: 'shot.png', key, title: 'Login page' }) });
  assert.equal(r.status, 201);
  const img = await r.json();
  assert.equal(img.kind, 'image');
  assert.equal(img.title, 'Login page');
  assert.deepEqual({ session: img.from.session, key: img.from.key }, { session: s.id, key });
  assert.equal(img.from.title, srv.store.get(s.id).title, 'the task’s title, kept for once it’s gone');
  assert.equal(img.path, undefined);
  const twice = await api('/stuff', { session: s.id, path: 'shot.png', key });
  assert.equal(twice.id, img.id, 'saving it again finds the one already kept');

  await assert.rejects(api('/stuff', { session: s.id, path: '../../etc/passwd' }), /gone/, 'only files the task showed or has in its folder');
  await assert.rejects(api('/stuff', { session: 'nope', path: 'x.png' }), /isn’t on this computer/);
  await assert.rejects(api('/stuff', {}), /Say what to save/);

  const file = await fetch(`${base}/api/stuff/${img.id}/file`);
  assert.equal(file.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), PNG);
  const part = await fetch(`${base}/api/stuff/${img.id}/file`, { headers: { range: 'bytes=0-3' } });
  assert.equal(part.status, 206);
  assert.match((await fetch(`${base}/api/stuff/${img.id}/file?download=1`)).headers.get('content-disposition'), /attachment; filename\*=UTF-8''shot\.png/);

  const snippet = await api('/stuff', { text: 'print(1)\n', lang: 'python', session: s.id, key: `${s.id}|t1|code:abc` });
  assert.equal(snippet.kind, 'code');
  assert.equal(snippet.lang, 'python');
  assert.equal(snippet.excerpt, 'print(1)');

  const up = await fetch(`${base}/api/stuff/upload?name=${encodeURIComponent('notes.txt')}&title=Notes`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: 'hello there' });
  assert.equal(up.status, 201);
  const notes = await up.json();
  assert.deepEqual([notes.kind, notes.title, notes.size, notes.excerpt], ['doc', 'Notes', 11, 'hello there']);

  const starred = await api(`/stuff/${notes.id}`, { starred: true, tags: ['ideas'] }, 'PATCH');
  assert.equal(starred.starred, true);
  const list = (await api('/stuff')).items;
  assert.deepEqual(list.map((x) => x.id), [notes.id, snippet.id, img.id], 'newest first');
  assert.ok(list.every((x) => x.path === undefined));

  assert.equal((await api(`/stuff/${notes.id}`, undefined, 'DELETE')).ok, true);
  assert.equal((await fetch(`${base}/api/stuff/${notes.id}/file`)).status, 404);
  await assert.rejects(api(`/stuff/${notes.id}`, { title: 'x' }, 'PATCH'), /no longer in My Stuff/);
});

test('wisp_save and wisp_stuff: an agent keeps a file, text or a link for the user, and finds them with their paths', async () => {
  const s = await task('draw a chart');
  const token = { 'x-wisp-token': srv.token };
  const cwd = srv.store.get(s.id).cwd;
  fs.writeFileSync(path.join(cwd, 'chart.png'), PNG);
  const saved = await api('/internal/stuff', { session: s.id, path: 'chart.png', title: 'Revenue chart', tags: ['q3'], note: 'For the board deck' }, 'POST', token);
  assert.ok(saved.text.startsWith(`Saved “Revenue chart” (image, ${PNG.length} B) to the user's My Stuff`), saved.text);
  const it = srv.stuff.list().find((x) => x.title === 'Revenue chart');
  assert.equal(it.by, 'agent');
  assert.equal(it.from.session, s.id);
  await api('/internal/stuff', { session: s.id, text: '# Notes\n', name: 'notes' }, 'POST', token);
  assert.ok(srv.stuff.list().some((x) => x.name === 'notes.md'), 'text gets a .md name');
  await assert.rejects(api('/internal/stuff', { session: s.id, path: 'chart.png', url: 'https://x.dev' }, 'POST', token), /exactly one/);
  await assert.rejects(api('/internal/stuff', { session: s.id, path: 'missing.png' }, 'POST', token), /Nothing at/);
  assert.equal((await fetch(`${base}/api/internal/stuff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: s.id, url: 'https://x.dev' }) })).status, 403);

  const found = await api(`/internal/stuff/${s.id}?query=board`, undefined, 'GET', token);
  assert.ok(found.text.includes(`Revenue chart** — image, ${PNG.length} B`));
  assert.ok(found.text.includes(`file: ${it.path}`), 'the agent gets the path of the copy, to use it');
  assert.match(found.text, /#q3/);
  assert.match((await api(`/internal/stuff/${s.id}?query=nothing-like-this`, undefined, 'GET', token)).text, /Nothing in My Stuff matches/);
});

test('the protocol tells the agent about My Stuff, under the harness’s name for the tool', () => {
  assert.match(systemPrompt({ askTool: 'mcp__wisp__ask_user' }), /My Stuff with `wisp_save` \(mcp__wisp__wisp_save\)/);
  assert.doesNotMatch(systemPrompt({ askTool: null }), /wisp_save/);
});

test('wisp_save with an id updates an item in place, keeps the version before, and Restore swaps them back', async () => {
  const s = await task('write the plan');
  const token = { 'x-wisp-token': srv.token };
  await api('/internal/stuff', { session: s.id, text: '# Plan v1\n', name: 'plan.md', title: 'The plan' }, 'POST', token);
  const v1 = srv.stuff.list().find((x) => x.title === 'The plan');
  await api(`/stuff/${v1.id}`, { starred: true }, 'PATCH');
  const out = await api('/internal/stuff', { session: s.id, id: v1.id, text: '# Plan v2\n', name: 'plan.md' }, 'POST', token);
  assert.match(out.text, /Updated “The plan” \(doc, 10 B\) in the user's My Stuff, now v2/);
  const v2 = srv.stuff.get(v1.id);
  assert.deepEqual([v2.title, v2.starred, v2.at, v2.rev, v2.excerpt], ['The plan', true, v1.at, 2, '# Plan v2'], 'same item, place, title and star; new content');
  assert.equal(fs.readFileSync(v2.path, 'utf8'), '# Plan v2\n');
  assert.ok(fs.existsSync(v2.prev.path), 'the version before is kept');
  const page = (await api('/stuff')).items.find((x) => x.id === v1.id);
  assert.equal(page.prev.path, undefined, 'the page sees that there is one, not where');
  const back = await api(`/stuff/${v1.id}/restore`, {});
  assert.equal(back.excerpt, '# Plan v1');
  assert.equal(back.at, v1.at);
  assert.equal(fs.readFileSync(srv.stuff.get(v1.id).path, 'utf8'), '# Plan v1\n');
  await api('/internal/stuff', { session: s.id, id: v1.id, note: 'For Monday' }, 'POST', token);
  assert.equal(srv.stuff.get(v1.id).note, 'For Monday', 'an id alone edits its details');
  await assert.rejects(api('/internal/stuff', { session: s.id, id: 'nope000000', text: 'x' }, 'POST', token), /No item nope000000/);
  const detail = await api(`/internal/stuff/${s.id}?id=${v1.id}`, undefined, 'GET', token);
  assert.match(detail.text, /```md\n# Plan v1\n```/, 'a doc in full');
  assert.match(detail.text, /wisp_save with id/);
});

test('apps: an agent saves a folder as an app; wisp serves it on a port of its own, only from its folder and loopback names', async () => {
  const s = await task('make slides');
  const token = { 'x-wisp-token': srv.token };
  const cwd = srv.store.get(s.id).cwd;
  const dir = path.join(cwd, 'deck');
  fs.mkdirSync(path.join(dir, 'node_modules', 'x'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Deck</title><script type="module" src="assets/app.js"></script>');
  fs.writeFileSync(path.join(dir, 'assets', 'app.js'), 'console.log(1)');
  fs.writeFileSync(path.join(dir, 'node_modules', 'x', 'big.js'), 'x'.repeat(1000));
  fs.writeFileSync(path.join(dir, 'wisp-app.json'), JSON.stringify({ name: 'Q3 deck', description: 'Slides for the board' }));
  fs.writeFileSync(path.join(cwd, 'deck.png'), PNG);
  await assert.rejects(api('/internal/stuff', { session: s.id, app: 'missing-dir' }, 'POST', token), /Nothing at/);
  fs.writeFileSync(path.join(cwd, 'empty-app.txt'), 'x');
  await assert.rejects(api('/internal/stuff', { session: s.id, app: 'empty-app.txt' }, 'POST', token), /folder with an index.html/);
  const out = await api('/internal/stuff', { session: s.id, app: 'deck', cover: 'deck.png' }, 'POST', token);
  assert.match(out.text, /Saved “Q3 deck” \(app, .*launches it from My Stuff/);
  const it = srv.stuff.list().find((x) => x.kind === 'app');
  assert.deepEqual([it.files, it.entry, it.excerpt], [3, 'index.html', 'Slides for the board'], 'node_modules left out');
  assert.ok(!fs.existsSync(path.join(it.path, 'node_modules')));
  assert.equal((await fetch(`${base}/api/stuff/${it.id}/cover`)).headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/api/stuff/${it.id}/file`)).status, 404, 'an app has no one file');

  const { port, url } = await api(`/stuff/${it.id}/launch`, {});
  assert.equal(url, `http://localhost:${port}/`);
  assert.equal((await api(`/stuff/${it.id}/launch`, {})).port, port, 'launching again keeps the same one');
  assert.deepEqual((await api('/stuff')).items.find((x) => x.id === it.id).running, { port });
  const page = await fetch(url);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(await page.text(), /<title>Deck<\/title>/);
  assert.match((await fetch(`${url}assets/app.js`)).headers.get('content-type'), /javascript/);
  assert.equal((await fetch(`${url}..%2f..%2f..%2fetc%2fhosts`)).status, 404, "dot-dots stay in its folder");
  assert.equal((await fetch(`${url}%2e%2e/%2e%2e/etc/passwd`)).status, 404, 'nothing outside its folder');
  const rebound = await new Promise((resolve) => {
    const req = (http) => http.get({ host: '127.0.0.1', port, path: '/', headers: { host: `evil.example:${port}` } }, (r) => resolve(r.statusCode));
    import('node:http').then(req);
  });
  assert.equal(rebound, 403, 'only by its loopback name');
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);

  // Updated: the next launch serves the new folder.
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Deck v2</title>');
  await api('/internal/stuff', { session: s.id, id: it.id, app: 'deck' }, 'POST', token);
  const again = await api(`/stuff/${it.id}/launch`, {});
  assert.match(await (await fetch(again.url)).text(), /Deck v2/);
  assert.equal(srv.stuff.get(it.id).title, 'Q3 deck');
  assert.ok(srv.stuff.get(it.id).cover, 'keeps its picture');
  await api(`/stuff/${it.id}/launch`, undefined, 'DELETE');
  await assert.rejects(fetch(again.url));
  await api(`/stuff/${it.id}`, undefined, 'DELETE');
  assert.ok(!fs.existsSync(it.path));
});

test('an HTML file in My Stuff only downloads, never opens on wisp’s origin', async () => {
  const up = await fetch(`${base}/api/stuff/upload?name=page.html`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: '<script>alert(1)</script>' });
  const it = await up.json();
  const r = await fetch(`${base}/api/stuff/${it.id}/file`);
  assert.match(r.headers.get('content-disposition'), /^attachment/);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream');
});

test('@-mentioned My Stuff in a prompt: the agent gets each item’s file and how to update it', async () => {
  const { agentPrompt, plainMentions } = await import('../server/mentions.js');
  const it = srv.stuff.addText('# Brand\n\nBlue.\n', { title: 'Brand guide' });
  const prompt = `Use @[Brand guide](stuff:${it.id}) for the page, and @[Gone](stuff:abcdef123456).`;
  assert.equal(plainMentions(prompt), 'Use @Brand guide for the page, and @Gone.');
  const out = agentPrompt(prompt, srv.store, { tool: 'mcp__wisp__wisp_session', stuff: srv.stuff });
  assert.match(out, new RegExp(`Use @Brand guide \\(My Stuff item ${it.id}\\) for the page`));
  assert.match(out, /<wisp-stuff>\nThe user points at things they kept in My Stuff\. Use them from these paths\. To change one for the user, save the new version with wisp_save and its id\./);
  assert.ok(out.includes(`file: ${it.path}`));
  assert.match(out, /```md\n# Brand\n\nBlue\.\n```/);
  assert.match(out, /`abcdef123456` \(Gone\): no longer in My Stuff/);
  assert.doesNotMatch(agentPrompt('no mentions', srv.store, { stuff: srv.stuff }), /wisp-stuff/);
});

test('the page’s mention form: a My Stuff chip round-trips like a task’s or a member’s, and renders as a button', async () => {
  const { decode, encode, mentionHtml, plain } = await import('../web/js/mention-text.js');
  const stored = 'Use @[Brand guide](stuff:abc123def456) with @[Ada](crew:aaa111bbb222)';
  const d = decode(stored);
  assert.equal(d.text, 'Use @Brand guide with @Ada');
  assert.deepEqual(d.mentions[0], { id: 'abc123def456', title: 'Brand guide', kind: 'stuff' });
  assert.equal(encode(d.text, d.mentions), stored);
  assert.equal(plain(stored), 'Use @Brand guide with @Ada');
  assert.match(mentionHtml(stored), /<button type="button" class="mn stuff" data-stuff="abc123def456"/);
});

test('a task launched with @-mentioned My Stuff: the agent’s prompt carries each item’s file', async () => {
  const { records } = await import('./helpers.js');
  const it = srv.stuff.addText('# Tone\n\nShort sentences.\n', { title: 'Tone guide' });
  const s = await task(`Rewrite the README in @[Tone guide](stuff:${it.id}) style`);
  const sent = records(process.env.FAKE_RECORD, 'claude').find((r) => (r.stdin || '').includes('Tone guide') || r.argv.join(' ').includes('Tone guide'));
  assert.ok(sent, 'the run was recorded');
  const text = `${sent.stdin || ''} ${sent.argv.join(' ')}`;
  assert.ok(text.includes(`@Tone guide (My Stuff item ${it.id})`));
  assert.ok(text.includes('<wisp-stuff>') && text.includes(it.path));
  assert.equal(srv.store.get(s.id).title.includes('stuff:'), false, 'titles read as people write');
});

test('the stuff block: the agent is told; what it saved this turn shows as a card even if it left it out', async () => {
  const { SYSTEM_PROMPT } = await import('../server/protocol.js').then((m) => ({ SYSTEM_PROMPT: m.systemPrompt({ askTool: 'mcp__wisp__ask_user' }) }));
  assert.match(SYSTEM_PROMPT, /"type":"stuff","id"/);
  const { BUILTIN_BLOCKS, PARTS } = await import('../web/js/spell-schema.js');
  assert.ok(BUILTIN_BLOCKS.includes('stuff') && PARTS['stuff.block'] && PARTS['stuff.frame']);
  const { blocksToMarkdown } = await import('../server/render.js');
  assert.match(blocksToMarkdown([{ type: 'stuff', id: 'abc', title: 'Flappy Bird', note: 'a game' }]), /📦 \*\*Flappy Bird\*\* \(My Stuff `abc`\) — a game/);

  const s = await task('make a game');
  const token = { 'x-wisp-token': srv.token };
  const cwd = srv.store.get(s.id).cwd;
  fs.mkdirSync(path.join(cwd, 'game'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'game', 'index.html'), '<title>Game</title>');
  const out = await api('/internal/stuff', { session: s.id, app: 'game', title: 'Flappy Bird' }, 'POST', token);
  const it = srv.stuff.list().find((x) => x.title === 'Flappy Bird');
  assert.ok(out.text.includes(`{"type":"stuff","id":"${it.id}"}`), 'the reply tells the agent how to show it');
  await api(`/sessions/${s.id}/reply`, { text: 'thanks' });
  await until(async () => (await api(`/sessions/${s.id}`)).turns.length === 2 && !srv.runner.live.has(s.id));
  const blocks = (await api(`/sessions/${s.id}`)).turns[1].presentation.blocks;
  const card = blocks.find((b) => b.type === 'stuff');
  assert.deepEqual({ id: card.id, title: card.title, kind: card.kind }, { id: it.id, title: 'Flappy Bird', kind: 'app' });
  assert.equal(srv.store.get(s.id).savedStuff, undefined, 'one card, on that turn');
});

test('bundle: a folder packs into one body and unpacks the same, never outside its folder', async () => {
  const { packDir, unpackTo, bundlePath } = await import('../server/bundle.js');
  const src = tmp('bundle-src');
  fs.mkdirSync(path.join(src, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(src, 'index.html'), '<p>hi</p>');
  fs.writeFileSync(path.join(src, 'a', 'b', 'pic.png'), PNG);
  const { body, files, size } = packDir(src);
  assert.deepEqual([files, size], [2, 9 + PNG.length]);
  const out = path.join(tmp('bundle-out'), 'site');
  assert.deepEqual(unpackTo(body, out), { files: 2, size: 9 + PNG.length });
  assert.deepEqual(fs.readFileSync(path.join(out, 'a', 'b', 'pic.png')), PNG);
  assert.throws(() => packDir(src, { maxBytes: 5 }), (e) => e.tooBig);
  for (const p of ['../x', '/etc/x', 'a/../../x', 'a\\b', '', 'a//b', './x']) assert.equal(bundlePath(p), null, p);
  assert.equal(bundlePath('a/b.js'), 'a/b.js');
  const head = Buffer.from(JSON.stringify({ path: '../evil', size: 1 }));
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length);
  assert.throws(() => unpackTo(Buffer.concat([len, head, Buffer.from('x')]), path.join(tmp('bundle-bad'), 's')), /bad file/);
  assert.throws(() => unpackTo(Buffer.concat([len, head]), path.join(tmp('bundle-bad'), 's')), /bad file/);
  assert.throws(() => unpackTo(Buffer.from([0, 0]), path.join(tmp('bundle-bad'), 's')), /ends early/);
});

test('publish: GET /stuff says where an app can go; without a wisp Grid, publishing says to sign in', async () => {
  const src = tmp('pub-app');
  fs.writeFileSync(path.join(src, 'index.html'), '<p>app</p>');
  const it = srv.stuff.addApp(src, { title: 'Demo' });
  const list = await api('/stuff');
  assert.deepEqual(list.publishTo, []);
  await assert.rejects(api(`/stuff/${it.id}/publish`, {}), (e) => e.status === 409 && /Sign in to a wisp Grid/.test(e.message));
  await assert.rejects(api(`/stuff/${it.id}/publish`, undefined, 'DELETE'), (e) => e.status === 404);
  const doc = srv.stuff.addText('# hi', { title: 'Note' });
  await assert.rejects(api(`/stuff/${doc.id}/publish`, {}), (e) => e.status === 404 && /Only apps/.test(e.message));
});

// App data needs node:sqlite (Node 22.13+): on older Node the endpoint says so, and these skip.
const sqlite = await import('node:sqlite').then(
  () => true,
  () => false,
);

test('app data: an app whose wisp-app.json asks gets its own SQLite database, made from its seed, reset on demand', { skip: !sqlite && 'needs node:sqlite' }, async () => {
  const src = tmp('db-app');
  fs.writeFileSync(path.join(src, 'index.html'), '<p>todos</p>');
  fs.writeFileSync(path.join(src, 'wisp-app.json'), JSON.stringify({ name: 'Todos', db: 'schema/seed.sql' }));
  fs.mkdirSync(path.join(src, 'schema'));
  fs.writeFileSync(path.join(src, 'schema', 'seed.sql'), "CREATE TABLE todos (id INTEGER PRIMARY KEY, text TEXT, done INTEGER DEFAULT 0); INSERT INTO todos (text) VALUES ('first');");
  const it = srv.stuff.addApp(src, {});
  assert.deepEqual(it.db, { seed: 'schema/seed.sql' });
  const listed = (await api('/stuff')).items.find((x) => x.id === it.id);
  assert.deepEqual([listed.db, listed.data], [true, false], 'the page sees whether it has one, not where');
  const { url } = await api(`/stuff/${it.id}/launch`, {});
  const q = (sql, params = [], headers = {}) => fetch(`${url}_wisp/db`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ sql, params }) });

  assert.match(await (await fetch(`${url}_wisp/db.js`)).text(), /export async function sql/);
  assert.deepEqual((await (await q('SELECT text, done FROM todos')).json()).rows, [{ text: 'first', done: 0 }]);
  assert.deepEqual(await (await q('INSERT INTO todos (text, done) VALUES (?, ?)', ['second', true])).json(), { changes: 1, lastId: 2 });
  assert.deepEqual((await (await q('UPDATE todos SET done = 1 WHERE id = ? RETURNING id', [1])).json()).rows, [{ id: 1 }]);
  assert.equal((await (await q('SELECT count(*) AS n FROM todos WHERE done = 1')).json()).rows[0].n, 2);
  assert.ok((await api('/stuff')).items.find((x) => x.id === it.id).data);

  // Only this app's own data, from its own pages.
  assert.match((await (await q("ATTACH DATABASE '/tmp/x.db' AS x")).json()).error, /ATTACH/);
  assert.equal((await q('PRAGMA max_page_count = 999999')).status, 400);
  assert.equal((await q('SELECT 1', [], { origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${url}_wisp/db`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"sql":"DELETE FROM todos"}' })).status, 415, 'a form from another site can’t post it');
  assert.equal((await q('SELECT ?', [{ a: 1 }])).status, 400);
  assert.match((await (await q('SELECT * FROM nope')).json()).error, /no such table/);

  // Updated by an agent: the data stays. Reset: made again from the seed.
  fs.writeFileSync(path.join(src, 'index.html'), '<p>todos v2</p>');
  srv.stuff.addApp(src, { replace: it.id });
  assert.equal((await (await q('SELECT count(*) AS n FROM todos')).json()).rows[0].n, 2);
  const reset = await api(`/stuff/${it.id}/data`, undefined, 'DELETE');
  assert.equal(reset.data, false);
  assert.equal((await (await q('SELECT count(*) AS n FROM todos')).json()).rows[0].n, 1);

  // An app without one says how to turn it on; removing an app takes its data.
  const plain = tmp('db-none');
  fs.writeFileSync(path.join(plain, 'index.html'), 'x');
  const other = srv.stuff.addApp(plain, {});
  const o = await api(`/stuff/${other.id}/launch`, {});
  assert.match((await (await fetch(`${o.url}_wisp/db`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).error, /"db": true/);
  await assert.rejects(api(`/stuff/${other.id}/data`, undefined, 'DELETE'), /no database/);
  const file = srv.stuff.dataFile(it.id);
  assert.ok(fs.existsSync(file));
  await api(`/stuff/${it.id}`, undefined, 'DELETE');
  assert.ok(!fs.existsSync(file));
  const noSeed = tmp('db-noseed');
  fs.writeFileSync(path.join(noSeed, 'index.html'), 'x');
  fs.writeFileSync(path.join(noSeed, 'wisp-app.json'), JSON.stringify({ db: 'missing.sql' }));
  assert.throws(() => srv.stuff.addApp(noSeed, {}), /No missing\.sql/);
});

test('app data: a query that never ends is stopped, and the next one works; the size cap holds', { skip: !sqlite && 'needs node:sqlite' }, async () => {
  const http = await import('node:http');
  const { createAppDb } = await import('../server/app-db.js');
  const db = createAppDb({ maxBytes: 64 * 1024, timeoutMs: 800 });
  const file = path.join(tmp('db-unit'), 'a.sqlite');
  const s = http.createServer((req, res) => db.handle(req, res, { file, seed: 'CREATE TABLE t (v TEXT);' }));
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const q = async (sql, params = []) => {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/_wisp/db`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql, params }) });
    return { status: r.status, ...(await r.json()) };
  };
  try {
    const forever = await q('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c');
    assert.deepEqual([forever.status, /stopped/.test(forever.error)], [503, true]);
    assert.deepEqual((await q('SELECT 1 AS one')).rows, [{ one: 1 }], 'a fresh worker takes over');
    let full;
    for (let i = 0; i < 40 && !full; i++) {
      const r = await q('INSERT INTO t VALUES (?)', ['x'.repeat(8000)]);
      if (r.error) full = r;
    }
    assert.match(full?.error || '', /full \(0 MB at most\)|full/);
  } finally {
    db.close();
    s.close();
  }
});

test('publish by an agent: wisp_save with publish says why it couldn’t, and keeps the app saved', async () => {
  const s = await task('make a demo');
  const token = { 'x-wisp-token': srv.token };
  const dir = path.join(srv.store.get(s.id).cwd, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<p>demo</p>');
  const out = await api('/internal/stuff', { session: s.id, app: 'demo', publish: true }, 'POST', token);
  assert.match(out.text, /Saved “demo” \(app/);
  assert.match(out.text, /wasn't published: Sign in to a wisp Grid first/);
  const it = srv.stuff.list().find((x) => x.title === 'demo');
  assert.ok(it && !it.published);
  const { systemPrompt: sp } = await import('../server/protocol.js');
  assert.match(String(sp({ agent: 'claude', tools: true }) || ''), /publish: true|^$/);
});
