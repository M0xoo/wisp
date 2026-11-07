// DKIM as grid/dkim.js checks it: no network, and a resolver that's a plain function. The RFC 8463
// message comes first, so canonicalization is proved against bytes this repo didn't sign. Generated
// keys cover the rest, one refusal at a time.

import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { headerFields, verifyDkim } from '../grid/dkim.js';
import { dkimSign, keyRecord } from './fixtures/dkim-sign.mjs';

const FOOTBALL = {
  'brisbane._domainkey.football.example.com': [['v=DKIM1; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=']],
  'test._domainkey.football.example.com': [['v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDkHlOQoBTzWR', 'iGs5V6NpP3idY6Wk08a5qhdR6wy5bdOKb2jLQiY/J16JYi0Qvx/byYzCNb3W91y3FutAC', 'DfzwQ/BC/e/8uBsCR+yz1Lxj+PL6lHvqMKrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3', 'Ip3G+2kryOTIKT+l/K4w3QIDAQAB']],
};
// RFC 8463, Appendix A.3, byte for byte. "A blank line follows the Joe. line."
const RFC8463 = [
  'DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed/relaxed;',
  ' d=football.example.com; i=@football.example.com;',
  ' q=dns/txt; s=brisbane; t=1528637909; h=from : to :',
  ' subject : date : message-id : from : subject : date;',
  ' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
  ' b=/gCrinpcQOoIfuHNQIbq4pgh9kyIK3AQUdt9OdqQehSwhEIug4D11Bus',
  ' Fa3bT3FY5OsU7ZbnKELq+eXdp1Q1Dw==',
  'DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed;',
  ' d=football.example.com; i=@football.example.com;',
  ' q=dns/txt; s=test; t=1528637909; h=from : to : subject :',
  ' date : message-id : from : subject : date;',
  ' bh=2jUSOH9NhtVGCQWNr9BrIAPreKQjO6Sn7XIkfJVOzv8=;',
  ' b=F45dVWDfMbQDGHJFlXUNB2HKfbCeLRyhDXgFpEL8GwpsRe0IeIixNTe3',
  ' DhCVlUrSjV4BwcVcOF6+FF3Zo9Rpo1tFOeS9mPYQTnGdaSGsgeefOsk2Jz',
  ' dA+L10TeYt9BgDfQNZtKdN1WO//KgIqXP7OdEFE4LjFYNcUxZQ4FADY+8=',
  'From: Joe SixPack <joe@football.example.com>',
  'To: Suzie Q <suzie@shopping.example.net>',
  'Subject: Is dinner ready?',
  'Date: Fri, 11 Jul 2003 21:00:37 -0700 (PDT)',
  'Message-ID: <20030712040037.46341.5F8J@football.example.com>',
  '',
  'Hi.',
  '',
  'We lost the game.  Are you hungry yet?',
  '',
  'Joe.',
  '',
  '',
].join('\r\n');

// resolveTxt from a table, keeping what it was asked. A name that isn't there is what DNS says then.
function dns(table) {
  const asked = [];
  const fn = async (name) => {
    asked.push(name);
    if (!(name in table)) throw Object.assign(new Error('queryTxt ENOTFOUND'), { code: 'ENOTFOUND' });
    return table[name];
  };
  return Object.assign(fn, { asked });
}

const ed = generateKeyPairSync('ed25519');
const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const edDns = { 'sel._domainkey.x.example': keyRecord(ed.publicKey) };
const rsaDns = { 'sel._domainkey.x.example': keyRecord(rsa.publicKey) };
const MSG = ['From: Ada  Lovelace <ada@x.example>', 'To: wisp <a@b.example>', 'Subject: fix', '  the bug', 'Date: Fri, 06 Nov 2026 10:00:00 +0000', 'Message-ID: <1@x.example>', '', 'it fails  on login   ', '', 'thanks', '', ''].join('\r\n');
const sign = (o = {}, raw = MSG) => dkimSign(raw, { d: 'x.example', key: ed.privateKey, ...o });
const NOW = () => Date.parse('2026-11-07T00:00:00Z');
const check = (raw, table = edDns, now = NOW) => verifyDkim(Buffer.from(raw, 'latin1'), { resolveTxt: dns(table), now });
const one = async (raw, table, now) => {
  const out = await check(raw, table, now);
  assert.equal(out.length, 1, JSON.stringify(out));
  return out[0];
};
async function refused(raw, why, table, now) {
  const r = await one(raw, table, now);
  assert.equal(r.ok, false, `passed: ${raw.slice(0, 200)}`);
  assert.match(r.why, why);
}

test('RFC 8463 Appendix A: both signatures on the published message verify, on bytes we didn’t sign', async () => {
  const out = await check(RFC8463, FOOTBALL);
  assert.deepEqual(out.map((r) => [r.d, r.ok, r.why]), [['football.example.com', true, ''], ['football.example.com', true, '']]);
});

test('RFC 8463 Appendix A: each algorithm stands alone, and a changed byte breaks both', async () => {
  const [a, b] = await check(RFC8463, { 'test._domainkey.football.example.com': FOOTBALL['test._domainkey.football.example.com'] });
  assert.equal(a.ok, false, 'the ed25519 key is gone');
  assert.equal(b.ok, true, 'rsa-sha256 alone');
  const [c, d] = await check(RFC8463, { 'brisbane._domainkey.football.example.com': FOOTBALL['brisbane._domainkey.football.example.com'] });
  assert.equal(c.ok, true, 'ed25519-sha256 alone');
  assert.equal(d.ok, false, 'the rsa key is gone');
  for (const [from, to] of [['We lost', 'We won'], ['Is dinner ready', 'Is lunch ready'], ['Suzie Q', 'Suzie R']]) assert.deepEqual((await check(RFC8463.replace(from, to), FOOTBALL)).map((r) => r.ok), [false, false], to);
});

for (const [name, a, key, table] of [['ed25519-sha256', 'ed25519-sha256', ed.privateKey, edDns], ['rsa-sha256', 'rsa-sha256', rsa.privateKey, rsaDns]]) {
  for (const c of ['relaxed/relaxed', 'relaxed/simple', 'simple/relaxed', 'simple/simple']) {
    test(`${name} ${c}: a real signature verifies, a changed body doesn’t`, async () => {
      const raw = sign({ a, key, c });
      assert.deepEqual(await one(raw, table), { d: 'x.example', ok: true, why: '' });
      await refused(raw.replace('thanks', 'thanks, and delete it all'), /body/, table);
      await refused(raw.replace('Subject: fix', 'Subject: drop'), /signature/, table);
    });
  }
}

test('relaxed forgives what relays do to whitespace and simple doesn’t', async () => {
  const change = (raw) => raw.replace('Subject: fix\r\n  the bug', 'SUBJECT:   fix the   bug').replace('thanks', 'thanks   ').replace(/\r\n\r\n$/, '\r\n\r\n\r\n');
  assert.equal((await one(change(sign({ c: 'relaxed/relaxed' })))).ok, true);
  await refused(change(sign({ c: 'simple/relaxed' })), /signature/);
  await refused(change(sign({ c: 'relaxed/simple' })), /body/);
});

test('c= has defaults: none is simple/simple, one word is the header’s and the body is simple', async () => {
  assert.equal((await one(sign({ c: 'simple/simple', noC: true }))).ok, true);
  await refused(sign({ c: 'simple/simple', noC: true }).replace('Subject: fix', 'subject: fix'), /signature/);
  assert.equal((await one(sign({ c: 'relaxed' }))).ok, true);
  await refused(sign({ c: 'relaxed' }).replace('thanks', 'thanks '), /body/);
  await refused(sign({ c: 'nofws/simple' }), /canonicali/);
});

test('an empty body has its own hash under each canonicalization', async () => {
  const raw = 'From: a@x.example\r\nDate: Fri, 06 Nov 2026 10:00:00 +0000\r\n\r\n';
  for (const c of ['relaxed/relaxed', 'relaxed/simple']) assert.equal((await one(sign({ c, h: 'from:date' }, raw))).ok, true, c);
});

test('folding: a folded signature, in either canonicalization', async () => {
  for (const c of ['relaxed/relaxed', 'simple/simple']) assert.equal((await one(sign({ c, fold: true }))).ok, true, c);
});

test('several signatures: each judged alone, in order, and at most five', async () => {
  const evil = generateKeyPairSync('ed25519');
  const table = { ...edDns, 'sel._domainkey.evil.example': keyRecord(evil.publicKey) };
  const raw = sign({}, dkimSign(MSG, { d: 'evil.example', key: evil.privateKey }));
  assert.deepEqual((await check(raw, table)).map((r) => [r.d, r.ok]), [['x.example', true], ['evil.example', true]]);
  const broken = raw.replace(/(b=[A-Za-z0-9+/]{8})/, (m) => `${m.slice(0, -1)}${m.endsWith('A') ? 'B' : 'A'}`);
  assert.deepEqual((await check(broken, table)).map((r) => [r.d, r.ok]), [['x.example', false], ['evil.example', true]]);
  let many = MSG;
  for (let i = 0; i < 7; i++) many = dkimSign(many, { d: 'x.example', s: `s${i}`, key: ed.privateKey, h: 'from' });
  const resolveTxt = dns({});
  const out = await verifyDkim(Buffer.from(many, 'latin1'), { resolveTxt, now: NOW });
  assert.equal(out.length, 5);
  assert.equal(resolveTxt.asked.length, 5);
});

test('headers are taken bottom-up: an unsigned one on top changes nothing a signature covers', async () => {
  const raw = 'From: a@x.example\r\nSubject: first\r\nSubject: second\r\n\r\nhi\r\n';
  const signed = sign({ h: 'from:subject' }, raw);
  assert.equal((await one(signed)).ok, true);
  assert.equal((await one(`Subject: on top\r\n${signed}`)).ok, true, 'added above the signed instance');
  await refused(signed.replace('Subject: second', 'Subject: changed'), /signature/);
  assert.equal((await one(signed.replace('Subject: first', 'Subject: not covered'))).ok, true, 'only the bottom one was signed');
  const twice = sign({ h: 'from:subject:subject' }, raw);
  await refused(twice.replace('Subject: first', 'Subject: changed'), /signature/);
  assert.equal((await one(sign({ h: 'from:from' }, raw))).ok, true, 'a name with no instance left adds nothing');
  await refused(`From: evil@evil.example\r\n${sign({ h: 'from:from' }, raw)}`, /signature/);
});

test('refused: l=, whatever it covers', async () => {
  await refused(sign({ l: true }), /l=/);
  await refused(sign({ l: true }).replace(/\r\n$/, 'appended\r\n'), /l=/);
});

test('refused: rsa-sha1, and any algorithm that isn’t on the list', async () => {
  await refused(sign({ a: 'rsa-sha1', key: rsa.privateKey }), /algorithm/, rsaDns);
  await refused(sign().replace('a=ed25519-sha256', 'a=rsa-md5'), /algorithm/);
});

test('refused: an h= without from', async () => {
  await refused(sign({ h: 'to:subject:date' }), /from/);
});

test('refused: x= in the past; a future x= and none are fine', async () => {
  const at = Math.floor(NOW() / 1000);
  await refused(sign({ tags: `x=${at - 1}` }), /expired/);
  assert.equal((await one(sign({ tags: `x=${at}` }))).ok, true);
  assert.equal((await one(sign({ tags: `x=${at + 100}` }))).ok, true);
  await refused(sign({ tags: `t=${at + 200}; x=${at + 100}` }), /expired|x=/);
});

test('i= sits within d=: its domain or a subdomain, nothing else', async () => {
  assert.equal((await one(sign({ tags: 'i=@x.example' }))).ok, true);
  assert.equal((await one(sign({ tags: 'i=ada@mail.x.example' }))).ok, true);
  await refused(sign({ tags: 'i=@evil.example' }), /i=/);
  await refused(sign({ tags: 'i=@notx.example' }), /i=/);
  await refused(sign({ tags: 'i=nodomain' }), /i=/);
});

test('s= and d= are checked before anything is looked up', async () => {
  for (const o of [{ s: 'a/b' }, { s: 'x._domainkey.evil.example.' }, { s: 'a b' }, { d: 'x.example.' }, { d: 'x..example' }, { d: 'localhost' }, { d: '-x.example' }, { d: `${'a'.repeat(64)}.example` }]) {
    const resolveTxt = dns(edDns);
    const [r] = await verifyDkim(Buffer.from(sign(o), 'latin1'), { resolveTxt, now: NOW });
    assert.equal(r.ok, false, JSON.stringify(o));
    assert.deepEqual(resolveTxt.asked, [], JSON.stringify(o));
  }
});

test('a bad body hash costs no lookup', async () => {
  const resolveTxt = dns(edDns);
  const [r] = await verifyDkim(Buffer.from(sign().replace('thanks', 'nope'), 'latin1'), { resolveTxt, now: NOW });
  assert.equal(r.ok, false);
  assert.deepEqual(resolveTxt.asked, []);
});

test('refused: tags that aren’t a signature', async () => {
  await refused(sign({ tags: 'd=evil.example' }), /tag/, 'duplicate tag');
  await refused(sign({ noV: true }), /v=/);
  await refused(sign().replace('v=1', 'v=2'), /v=/);
  await refused(sign({ tags: 'q=dns/other' }), /q=/);
  for (const t of ['bh=', 'b=']) await refused(sign().replace(new RegExp(`; ${t}[^;\\r]*`), ''), /tag/, t);
  await refused(sign().replace(/s=sel; /, ''), /tag/);
  await refused(sign().replace(/d=x\.example; /, ''), /tag/);
  await refused(sign().replace(/h=[^;]*; /, ''), /tag/);
  await refused(sign().replace('a=ed25519-sha256; ', ''), /tag/);
});

const key = (more) => ({ 'sel._domainkey.x.example': keyRecord(ed.publicKey, more) });

test('refused: a revoked key (empty p=)', async () => {
  await refused(sign(), /revoked/, { 'sel._domainkey.x.example': [['v=DKIM1; k=ed25519; p=']] });
});

test('refused: k= that doesn’t match a=, either way', async () => {
  await refused(sign(), /key/, { 'sel._domainkey.x.example': [[`v=DKIM1; k=rsa; p=${keyRecord(ed.publicKey)[0].join('').split('p=')[1]}`]] });
  await refused(sign({ a: 'rsa-sha256', key: rsa.privateKey }), /key/, { 'sel._domainkey.x.example': [[keyRecord(rsa.publicKey)[0].join('').replace('k=rsa', 'k=ed25519')]] });
  await refused(sign({ a: 'rsa-sha256', key: rsa.privateKey }), /key/, edDns);
  await refused(sign({ a: 'rsa-sha256', key: rsa.privateKey }), /key/, { 'sel._domainkey.x.example': [[keyRecord(rsa.publicKey)[0].join('').replace('k=rsa; ', '').replace('v=DKIM1; ', '').replace('p=', 'k=ed25519; p=')]] });
  assert.equal((await one(sign({ a: 'rsa-sha256', key: rsa.privateKey }), { 'sel._domainkey.x.example': [[keyRecord(rsa.publicKey)[0].join('').replace('k=rsa; ', '')]] })).ok, true, 'k= defaults to rsa');
});

test('a key’s t=s: the domain of i= has to be exactly d=', async () => {
  assert.equal((await one(sign({ tags: 'i=@x.example' }), key('t=s'))).ok, true);
  assert.equal((await one(sign(), key('t=s'))).ok, true, 'no i= is @d');
  await refused(sign({ tags: 'i=@mail.x.example' }), /t=s/, key('t=s'));
  assert.equal((await one(sign({ tags: 'i=@mail.x.example' }), key('t=y:x'))).ok, false, 't=y is testing: no better than unsigned');
});

test('a key’s h= and s= have to allow this use', async () => {
  assert.equal((await one(sign(), key('h=sha1:sha256; s=email'))).ok, true);
  assert.equal((await one(sign(), key('s=*'))).ok, true);
  await refused(sign(), /key/, key('h=sha1'));
  await refused(sign(), /key/, key('s=tlsrpt'));
});

test('refused: an RSA key under 1024 bits; 1024 is fine', async () => {
  const small = generateKeyPairSync('rsa', { modulusLength: 768 });
  await refused(sign({ a: 'rsa-sha256', key: small.privateKey }), /1024/, { 'sel._domainkey.x.example': keyRecord(small.publicKey) });
  const min = generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.equal((await one(sign({ a: 'rsa-sha256', key: min.privateKey }), { 'sel._domainkey.x.example': keyRecord(min.publicKey) })).ok, true);
});

test('a key record that isn’t one, or isn’t alone, proves nothing', async () => {
  await refused(sign(), /key/, { 'sel._domainkey.x.example': [] });
  await refused(sign(), /key/, { 'sel._domainkey.x.example': [['not a key record']] });
  await refused(sign(), /key/, { 'sel._domainkey.x.example': [['v=DKIM1; k=ed25519; p=AAAA']] });
  await refused(sign(), /key/, { 'sel._domainkey.x.example': [...keyRecord(ed.publicKey), ...keyRecord(ed.publicKey)] });
  await refused(sign(), /key/, { 'sel._domainkey.x.example': [['v=DKIM2; k=ed25519; p=11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=']] });
});

test('a DNS failure is a refusal and never an exception', async () => {
  await refused(sign(), /DNS|lookup/, {});
  const r = await verifyDkim(Buffer.from(sign(), 'latin1'), { resolveTxt: () => { throw new Error('boom'); }, now: NOW });
  assert.equal(r[0].ok, false);
  const s = await verifyDkim(Buffer.from(sign(), 'latin1'), { resolveTxt: async () => 'not a list', now: NOW });
  assert.equal(s[0].ok, false);
});

test('a lookup that never answers ends at 5 seconds, in a refusal', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const pending = verifyDkim(Buffer.from(sign(), 'latin1'), { resolveTxt: () => new Promise(() => {}), now: NOW });
    await new Promise((r) => setImmediate(r));
    mock.timers.tick(4999);
    let over = false;
    pending.then(() => (over = true));
    await new Promise((r) => setImmediate(r));
    assert.equal(over, false, 'not before 5 s');
    mock.timers.tick(1);
    const [r] = await pending;
    assert.equal(r.ok, false);
    assert.match(r.why, /DNS|lookup/);
  } finally {
    mock.timers.reset();
  }
});

test('a header section only splits one way: bare CR, bare LF, a blank fold or a line that’s no header make it unprovable', async () => {
  const good = sign();
  assert.ok(headerFields(good));
  assert.ok(headerFields('From: a@b.example\r\n\r\nbody\nwith a bare LF\r and a bare CR'), 'the body is its own matter');
  const cases = {
    'bare LF ends headers early': good.replace('To: wisp', 'X: y\n\nFrom: evil@evil.example\r\nTo: wisp'),
    'bare LF, once': good.replace('To: wisp', 'X: y\nFrom: evil@evil.example\r\nTo: wisp'),
    'bare CR': good.replace('To: wisp', 'X: y\rFrom: evil@evil.example\r\nTo: wisp'),
    'LF before the blank line': good.replace('\r\n\r\nit fails', '\n\r\nit fails'),
    'a line of spaces': good.replace('To: wisp', 'X: y\r\n \r\nFrom: evil@evil.example\r\nTo: wisp'),
    'a line that’s no header': good.replace('To: wisp', 'not a header\r\nTo: wisp'),
    'a fold on the first line': ` ${good}`,
    'a name with a space in it': good.replace('To: wisp', 'Fro m: x\r\nTo: wisp'),
    'no end to the headers': 'From: a@x.example\r\nTo: b@x.example\r\n',
  };
  for (const [name, raw] of Object.entries(cases)) {
    assert.equal(headerFields(raw), null, name);
    assert.deepEqual(await check(raw), [], name);
  }
});

test('a space before the colon is the same field to both readers', async () => {
  const f = headerFields('From : a@x.example\r\nSubject:\r\n fold\r\n\r\nb');
  assert.deepEqual(f.fields.map((x) => x.name), ['from', 'subject']);
  assert.equal(f.fields[1].raw, 'Subject:\r\n fold');
  assert.equal(f.body, 'b');
});
