// The `app` block: the sandboxed document around an agent's HTML (web/js/app-doc.js), the
// protocol entry behind Settings → Interactive answers, its text stand-in, and its saved state.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

process.env.WISP_HOME = tmp('app-home');
const RECORD = tmp('app-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_UPDATE_CHECK = '0';
installFakeBins();
const { APP_MAX_HTML, APP_MAX_STATE, appDoc, appKey, appProblem, themeCss } = await import('../web/js/app-doc.js');
const { systemPrompt, blockDocs } = await import('../server/protocol.js');
const { blocksToMarkdown } = await import('../server/render.js');
const { SPELL_EXAMPLES } = await import('../server/spell-guide.js');
const { startServer } = await import('../server/index.js');

test('the CSP comes before anything the agent wrote, and allows no network', () => {
  const doc = appDoc('<meta http-equiv="Content-Security-Policy" content="default-src *"><script>fetch("https://x.dev")</script>', { vars: { '--ink': '#111' } });
  const csp = doc.indexOf('Content-Security-Policy');
  assert.ok(csp > 0 && csp < doc.indexOf('<body>'), 'wisp\'s policy is in <head>');
  assert.match(doc.slice(csp, doc.indexOf('>', csp)), /default-src 'none'/);
  assert.doesNotMatch(doc.slice(csp, doc.indexOf('>', csp)), /connect-src|https?:/);
  assert.ok(doc.indexOf('fetch(') > doc.indexOf('<body>'), 'the agent\'s html is the body');
});

test('saved state and theme values can not close the bridge script or the style', () => {
  const doc = appDoc('<p>hi</p>', { state: { note: '</script><script>alert(1)</script>' }, vars: { '--ink': 'red;}</style><script>x()</script>' } });
  assert.equal(doc.match(/<\/script>/g).length, 1, 'only the bridge closes a script tag');
  assert.doesNotMatch(themeCss({ '--ink': 'red;} body{display:none' }), /;\}/);
  assert.match(themeCss({}, 'dark'), /color-scheme:dark/);
  assert.match(doc, /\\u003c\/script>/);
});

test('appProblem: html is required and capped; appKey is the block\'s place, else its content', () => {
  assert.match(appProblem({}), /no html/);
  assert.match(appProblem({ html: 'x'.repeat(APP_MAX_HTML + 1) }), /larger than/);
  assert.equal(appProblem({ html: '<p>ok</p>' }), '');
  const b = { type: 'app', html: '<p>a</p>' };
  assert.equal(appKey(b, [{ type: 'hero' }, b]), 'app:1');
  assert.match(appKey({ ...b }, [b]), /^app:h[0-9a-z]+$/);
  assert.equal(appKey({ ...b }, null), appKey({ ...b }, []));
});

test('the protocol offers app blocks only when Interactive answers is on', () => {
  assert.doesNotMatch(systemPrompt(), /"type":"app"/);
  // With wisp's tools the catalogue names it and wisp_blocks has its fields; without them it's in full.
  const p = systemPrompt({ apps: true });
  assert.match(p, /- \{"type":"app",…\} A small interactive page[^\n]*`wisp_blocks` \(mcp__wisp__wisp_blocks\)/);
  assert.doesNotMatch(p, /wisp\.send\(text\)/);
  for (const full of [systemPrompt({ apps: true, askTool: null }), blockDocs(['app'])]) {
    assert.match(full, /- \{"type":"app","title":"…","html":/);
    assert.match(full, /wisp\.send\(text\)/);
    assert.match(full, /320px/);
  }
  assert.ok(p.indexOf('"type":"app"') < p.indexOf('Strings must be valid JSON'));
  const both = systemPrompt({ apps: true, extraBlocks: [{ type: 'deploy', doc: 'After you deploy.', spell: 'Deploy' }] });
  assert.ok(both.indexOf('"type":"app"') < both.indexOf('"type":"deploy"'));
});

test('as text, an app is its title and its fallback blocks', () => {
  const md = blocksToMarkdown([{ type: 'app', title: 'Easing tuner', html: '<p>x</p>', fallback: [{ type: 'question', question: 'Which curve?', options: ['snappy', 'material'] }, { type: 'app', html: 'nested' }] }]);
  assert.match(md, /🧩 Easing tuner\*\* _\(interactive: open it in wisp\)_/);
  assert.match(md, /Which curve\?/);
  assert.doesNotMatch(md, /nested/);
  assert.match(blocksToMarkdown([{ type: 'app', html: 'x' }]), /🧩 Interactive/);
});

test('the Rank block example returns an app with a fallback', async () => {
  const ex = SPELL_EXAMPLES.find((x) => x.spell.id === 'rank-block');
  const mod = await import(`data:text/javascript,${encodeURIComponent(ex.spell.script)}`);
  const [b] = mod.rank({ title: 'Order', items: ['a', '</script>b'] });
  assert.equal(b.type, 'app');
  assert.equal(appProblem(b), '');
  assert.equal(b.html.match(/<\/script>/g).length, 1, 'an item can not end the script');
  assert.equal(b.fallback[0].items.length, 2);
});

// --- saved state, through a real server ------------------------------------------------------

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
  srv = await startServer({ port, handleSignals: false });
  base = `http://127.0.0.1:${port}`;
});
after(() => {
  srv.shutdown();
  srv.server.close();
});
const call = async (method, p, body) => {
  const r = await fetch(`${base}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
};

test('POST /sessions/:id/app-state keeps what an app saved on its turn, within limits', async () => {
  const { json: s } = await call('POST', '/sessions', { prompt: 'pick a curve', scratch: true });
  await until(async () => (await call('GET', `/sessions/${s.id}`)).json.turns?.at(-1)?.status === 'done', { timeout: 20_000 });
  const turnId = (await call('GET', `/sessions/${s.id}`)).json.turns.at(-1).id;
  assert.equal((await call('POST', `/sessions/${s.id}/app-state`, { turnId, key: 'app:2', state: { curve: [0.2, 0.8, 0.2, 1] } })).status, 200);
  assert.deepEqual((await call('GET', `/sessions/${s.id}`)).json.turns.at(-1).appState, { 'app:2': { curve: [0.2, 0.8, 0.2, 1] } });
  assert.equal((await call('POST', `/sessions/${s.id}/app-state`, { turnId, key: 'bad key', state: 1 })).status, 400);
  const big = await call('POST', `/sessions/${s.id}/app-state`, { turnId, key: 'app:2', state: 'x'.repeat(APP_MAX_STATE) });
  assert.equal(big.status, 400);
  assert.match(big.json.error, /larger than/);
  assert.equal((await call('POST', `/sessions/${s.id}/app-state`, { turnId: 'nope', key: 'app:0' })).status, 404);
});

test('Interactive answers is on by default; off keeps app blocks out of the agent\'s prompt', async () => {
  const promptOf = () => {
    const rec = records(RECORD, 'claude').at(-1);
    return rec.argv[rec.argv.indexOf('--append-system-prompt') + 1];
  };
  const run = async (prompt) => {
    const { json: s } = await call('POST', '/sessions', { prompt, cwd: makeRepo(), agent: 'claude' });
    await until(async () => (await call('GET', `/sessions/${s.id}`)).json.turns?.at(-1)?.status === 'done', { timeout: 20_000 });
    return promptOf();
  };
  assert.equal((await call('GET', '/config')).json.defaults.apps, undefined, 'nothing saved: the default');
  assert.match(await run('pick a colour'), /"type":"app"/);
  await call('PATCH', '/config', { defaults: { apps: 'off' } });
  assert.doesNotMatch(await run('pick a colour again'), /"type":"app"/);
  await call('PATCH', '/config', { defaults: { apps: 'on' } });
});
