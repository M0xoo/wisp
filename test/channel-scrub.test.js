// What leaves for ntfy and Telegram with the channel layer off (telegram.options, the default):
// never a secret, and everything else exactly as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { Remote } from '../server/remote.js';

// Built here, not written out: a realistic token in a file stops the push.
const TOKEN = ['ghp', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('_');
const NOTE = /wisp took a secret out of this message/;

async function fakes(t) {
  const fake = { ntfy: [], tg: [] };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const json = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
    if (req.url.startsWith('/bot')) {
      const method = req.url.split('/').pop();
      if (method === 'getUpdates') {
        const updates = fake.updates?.splice(0) || [];
        return json({ ok: true, result: updates });
      }
      fake.tg.push({ method, ...JSON.parse(body) });
      return json({ ok: true, result: { message_id: 100 + fake.tg.length } });
    }
    if (req.method === 'POST') fake.ntfy.push(JSON.parse(body));
    json({});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  fake.url = `http://127.0.0.1:${server.address().port}`;
  process.env.WISP_TELEGRAM_API = fake.url;
  return fake;
}

function hub(fake, { act = async () => 'ok', options = false } = {}) {
  const store = {
    config: { projects: [], remote: { ntfy: { enabled: true, server: fake.url, topic: 'wisp-t', token: '' }, telegram: { enabled: true, token: '1:a', chatId: 7, ...(options && { allowStart: true, options: true }) } } },
    saveConfig() {},
    get: () => null,
    save() {},
    all: () => [],
  };
  return new Remote({ store, act, ...(options && { context: () => ({}) }) });
}

const session = { id: 's1', title: 'A task' };
const until = async (fn) => {
  for (let i = 0; i < 300 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(fn(), 'timed out');
};

test('a secret in a report reaches neither ntfy nor Telegram, wherever it sits', async (t) => {
  const fake = await fakes(t);
  const r = hub(fake);
  await r.send({ title: `Done ${TOKEN}`, text: `The deploy used ${TOKEN} and worked.`, actions: [{ label: `Use ${TOKEN}`, kind: 'answer', ref: 'q', index: 0 }] }, session);
  const n = JSON.stringify(fake.ntfy[0]);
  const m = JSON.stringify(fake.tg[0]);
  assert.ok(!n.includes(TOKEN), 'ntfy');
  assert.ok(!m.includes(TOKEN), 'Telegram');
  assert.match(fake.ntfy[0].message, NOTE);
  assert.match(fake.tg[0].text, NOTE);
  assert.equal(fake.ntfy[0].title.match(NOTE), null, 'the message says it, once');
});

test('a secret astride the length limit is taken out before the cut, not left half there', async (t) => {
  const fake = await fakes(t);
  const r = hub(fake);
  await r.send({ title: 'Done', text: `${'x '.repeat(1496)}${TOKEN}`, actions: [] }, session);
  assert.ok(!fake.ntfy[0].message.includes(TOKEN.slice(0, 12)), 'ntfy cuts at 3000');
  assert.ok(!fake.tg[0].text.includes(TOKEN.slice(0, 12)));
});

test('a report with no secret leaves exactly as it did, @names and all', async (t) => {
  const fake = await fakes(t);
  const r = hub(fake);
  const text = 'Ran npm test as @mokh: 1490 pass, commit 612b165e.';
  await r.send({ title: 'Done', text, actions: [{ label: 'Merge', kind: 'answer', ref: 'q', index: 0 }] }, session);
  assert.equal(fake.ntfy[0].message, text);
  assert.equal(fake.ntfy[0].title, 'Done');
  assert.equal(fake.ntfy[0].actions[0].label, 'Merge');
  assert.ok(fake.tg[0].text.includes(text));
});

test('with telegram.options on, a report is still scrubbed and defused', async (t) => {
  const fake = await fakes(t);
  const r = hub(fake, { options: true });
  await r.send({ title: 'Done', text: `${TOKEN} for @mokh` }, null);
  assert.ok(!fake.ntfy[0].message.includes(TOKEN));
  assert.ok(fake.ntfy[0].message.includes('@​mokh'));
});

test('Telegram: what wisp says back in a chat carries no secret either', async (t) => {
  const fake = await fakes(t);
  let later;
  const r = hub(fake, { act: async (a) => ((later ||= a.later), a.kind === 'text' ? `Sent: ${TOKEN}` : `✓ Answered: ${TOKEN}`) });
  r.store.all = () => [{ id: 's1', remote: { tg: [50] } }];
  r.tgLongPoll = 0;
  t.after(() => r.stop());
  fake.updates = [
    { update_id: 1, message: { message_id: 60, chat: { id: 7 }, text: 'go on', reply_to_message: { message_id: 50 } } },
    { update_id: 2, callback_query: { id: 'c1', data: 'a:s1:q:0', message: { message_id: 50, chat: { id: 7 } } } },
  ];
  r.start();
  await until(() => fake.tg.some((x) => x.method === 'answerCallbackQuery'));
  await later(`Side answer: ${TOKEN}`);
  const out = fake.tg.filter((x) => x.method === 'sendMessage' || x.method === 'answerCallbackQuery');
  assert.equal(out.length, 3);
  for (const x of out) assert.ok(!JSON.stringify(x).includes(TOKEN), x.method);
});
