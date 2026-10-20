// Spells: install, check, turn on and off, export, and the data and links spells use.

import { spawn } from 'node:child_process';
import { describeSpell, normalizeSpell } from '../spells.js';
import { summarize } from '../runner.js';
import { bad } from '../util.js';

const MAX_SPELL_BYTES = 512 * 1024;
const MAX_OPEN = 20;

// Fetch a spell from a link: any https URL to the JSON, or gist:<id> (the first *.spell.json in it).
export async function fetchSpell(src) {
  const s = String(src || '').trim();
  const gist = /^gist:([a-f0-9]{6,64})$/i.exec(s) || /^https:\/\/gist\.github\.com\/(?:[\w-]+\/)?([a-f0-9]{6,64})\/?$/i.exec(s);
  const get = async (url, json) => {
    const res = await fetch(url, { headers: { accept: json ? 'application/vnd.github+json' : 'application/json', 'user-agent': 'wisp' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw bad(`Couldn't fetch ${url}: ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_SPELL_BYTES) throw bad('That spell is bigger than 512 KB.');
    return text;
  };
  if (gist) {
    const g = JSON.parse(await get(`https://api.github.com/gists/${gist[1]}`, true));
    const file = Object.values(g.files || {}).find((f) => /\.spell\.json$/i.test(f.filename)) || Object.values(g.files || {}).find((f) => /\.json$/i.test(f.filename));
    if (!file) throw bad('That gist has no .spell.json file.');
    return { spell: JSON.parse(file.truncated ? await get(file.raw_url) : file.content), source: { kind: 'gist', url: `gist:${gist[1]}`, owner: g.owner?.login || '' } };
  }
  if (!/^https:\/\//i.test(s)) throw bad('A spell link is an https URL or gist:<id>.');
  return { spell: JSON.parse(await get(s)), source: { kind: 'url', url: s } };
}

// The body's spell: { spell: {…} }, { text: '<json>' } (pasted), or { url } (fetched).
async function spellOf(body) {
  if (body.url) return fetchSpell(body.url);
  if (typeof body.text === 'string') {
    try {
      return { spell: JSON.parse(body.text), source: { kind: 'file', name: String(body.name || '') } };
    } catch (err) {
      throw bad(`That isn't JSON: ${err.message}`);
    }
  }
  if (body.spell && typeof body.spell === 'object') return { spell: body.spell, source: body.source && typeof body.source === 'object' ? { kind: String(body.source.kind || 'local'), ...(body.source.session && { session: String(body.source.session) }) } : null };
  throw bad('Send { spell }, { text } or { url }.');
}

// Open links in the default browser (a page can open only one popup per click; this can open several).
export function openUrls(urls) {
  const list = (Array.isArray(urls) ? urls : [urls]).map(String).filter((u) => /^https?:\/\/[^\s"']+$/i.test(u));
  if (!list.length) throw bad('Nothing to open: only http(s) links.');
  for (const url of list.slice(0, MAX_OPEN)) {
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
    if (process.env.WISP_NO_OPEN === '1') continue; // tests
    try {
      spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
    } catch {}
  }
  return list.slice(0, MAX_OPEN);
}

export function register(r, app) {
  const { spells, store } = app;
  const one = (fn) => async (c) => {
    const s = spells.get(c.params.id);
    if (!s) return c.send(404, { error: 'no such spell' });
    return fn(c, s);
  };

  r.route('GET', '/spells', (c) => c.send(200, spells.list()));

  // Validate without installing: what it does, its riskiest kind, problems or warnings.
  r.route('POST', '/spells/check', async (c) => {
    const { spell: raw } = await spellOf(await c.body());
    try {
      const { spell, warnings } = normalizeSpell(raw);
      const d = describeSpell(spell);
      const installed = spells.get(spell.id);
      c.send(200, { ok: true, spell, summary: d.lines, kind: d.kind, warnings, installed: installed ? { version: installed.version, enabled: spells.isOn(spell.id), same: JSON.stringify(installed) === JSON.stringify(spell) } : null });
    } catch (err) {
      if (!err.problems) throw err;
      c.send(200, { ok: false, problems: err.problems, error: err.message });
    }
  });

  // Install (or update). Off unless enable: true, which only the user's own click sends.
  r.route('POST', '/spells', async (c) => {
    const body = await c.body();
    const { spell, source } = await spellOf(body);
    const out = spells.install(spell, { source, enable: body.enable === true });
    app.telemetry?.track('spell_installed', { source: source?.kind || 'local', enabled: body.enable === true, kind: out.spell.kind });
    c.send(out.updated ? 200 : 201, out);
  });

  // Turn every spell off (the way out when one makes the page unusable).
  r.route('POST', '/spells/off', (c) => {
    for (const s of spells.enabled()) spells.setEnabled(s.id, false, { quiet: true });
    spells.onChange();
    c.send(200, spells.list());
  });

  r.route('GET', '/spells/:id', one((c, s) => c.send(200, spells.view(s))));
  r.route(
    'PATCH',
    '/spells/:id',
    one(async (c, s) => {
      const body = await c.body();
      if (typeof body.enabled !== 'boolean') return c.send(400, { error: 'enabled must be true or false' });
      c.send(200, spells.setEnabled(s.id, body.enabled));
    }),
  );
  r.route('DELETE', '/spells/:id', (c) => {
    spells.remove(c.params.id);
    c.send(200, { ok: true });
  });
  r.route('GET', '/spells/:id/export', one((c, s) => c.send(200, spells.exported(s.id))));

  // A spell's data source, fetched for it. session: the card's task, for per-task sources.
  r.route(
    'POST',
    '/spells/:id/data/:name',
    one(async (c, s) => {
      const body = await c.body();
      const source = s.data?.[c.params.name];
      if (!source) return c.send(404, { error: `${s.name} has no data source ${c.params.name}` });
      const session = body.session ? store.get(String(body.session)) : null;
      const value = await app.spellData.get(s.id, c.params.name, source, { session, summary: session ? summarize(session, store) : null, fresh: body.fresh === true });
      c.send(200, { value });
    }),
  );

  // Try it: a data source of a spell that isn't installed (or is, in another version), checked first.
  r.route('POST', '/spells/try-data', async (c) => {
    const body = await c.body();
    const { spell } = normalizeSpell(body.spell);
    const name = String(body.name || '');
    const source = spell.data?.[name];
    if (!source) return c.send(404, { error: `${spell.name} has no data source ${name}` });
    const session = body.session ? store.get(String(body.session)) : null;
    const value = await app.spellData.get(`try-${spell.id}`, name, source, { session, summary: session ? summarize(session, store) : null });
    c.send(200, { value });
  });

  // Open http(s) links in the default browser.
  r.route('POST', '/open', async (c) => {
    const { urls } = await c.body();
    c.send(200, { opened: openUrls(urls) });
  });
}
