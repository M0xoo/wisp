// scripts/site.mjs: the docs site's generated pages (agents/, integrations, changelog, 404, sitemap).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, markdown, AGENTS } from '../scripts/site.mjs';
import { adapters } from '../server/adapters/index.js';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const ADAPTERS = fileURLToPath(new URL('../server/adapters/', import.meta.url));
const SITE = 'https://trywisp.dev';

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-site-'));
const pages = build(out);
const read = (p) => fs.readFileSync(path.join(out, p.file), 'utf8');

test('every generated page has its own title, description, canonical and one h1', () => {
  const titles = new Set();
  for (const p of pages.filter((x) => x.file)) {
    const html = read(p);
    const title = html.match(/<title>(.*?)<\/title>/)?.[1];
    assert.ok(title, p.path);
    assert.ok(!titles.has(title), `duplicate title ${title}`);
    titles.add(title);
    assert.match(html, /<meta name="description" content="[^"]{50,}"/, p.path);
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1, `${p.path}: one h1`);
    if (p.noindex) assert.match(html, /<meta name="robots" content="noindex"/);
    else assert.ok(html.includes(`<link rel="canonical" href="${SITE}${p.path}" />`), p.path);
    for (const m of html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gs)) JSON.parse(m[1]);
  }
});

test('internal links and assets on generated pages resolve', () => {
  for (const p of pages.filter((x) => x.file)) {
    for (const [, href] of read(p).matchAll(/(?:href|src|srcset)="(\/[^"#?]*)/g)) {
      const rel = href.endsWith('/') ? `${href}index.html` : href;
      const found = [out, DOCS].some((dir) => fs.existsSync(path.join(dir, rel)));
      assert.ok(found, `${p.path} links to missing ${href}`);
    }
  }
});

test('sitemap lists every indexable page on the canonical domain', () => {
  const xml = fs.readFileSync(path.join(out, 'sitemap.xml'), 'utf8');
  const locs = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  assert.deepEqual(locs, pages.filter((p) => !p.noindex).map((p) => `${SITE}${p.path}`));
  assert.ok(locs.includes(`${SITE}/agents/claude-code.html`));
  assert.match(fs.readFileSync(path.join(DOCS, 'robots.txt'), 'utf8'), new RegExp(`Sitemap: ${SITE}/sitemap.xml`));
});

test('there is a page for every harness, and its mode flags match the adapter', () => {
  assert.deepEqual(AGENTS.map((a) => a.id).sort(), Object.keys(adapters).sort());
  for (const a of AGENTS) {
    const src = fs.readFileSync(path.join(ADAPTERS, `${a.id}.js`), 'utf8');
    for (const flag of Object.values(a.modes)) {
      // Each flag's distinctive word ("bypassPermissions", "--force", "read-only") is in the adapter.
      const word = flag.match(/--[\w-]+$|[\w-]+(?="?$)/)?.[0];
      if (!flag.startsWith('(')) assert.ok(word && src.includes(word.replace(/^--/, '')), `${a.id}: ${flag}`);
    }
    assert.ok(src.includes(a.resume.split(' ')[1].replace(/^--/, '')), `${a.id}: ${a.resume}`);
  }
});

test('markdown: headings, nested lists, tables, code and links', () => {
  const html = markdown([
    '## The [MCP](#mcp) server',
    '',
    '- **One** with `code`',
    '  - nested *two*',
    '- three',
    '  wrapped',
    '',
    '| A | B |',
    '|---|---|',
    '| `x` | [docs](integrations.md#mcp) |',
    '',
    '```sh',
    'echo "<hi>"',
    '```',
    '',
    'See [the README](../README.md#cli).',
  ].join('\n'), 'https://github.com/M0xoo/wisp/blob/main/docs/');
  assert.match(html, /<h2 id="the-mcp-server">The <a href="#mcp">MCP<\/a> server<\/h2>/);
  assert.match(html, /<ul><li><strong>One<\/strong> with <code>code<\/code><ul><li>nested <em>two<\/em><\/li><\/ul><\/li><li>three wrapped<\/li><\/ul>/);
  assert.match(html, /<td><code>x<\/code><\/td><td><a href="\/integrations.html#mcp">docs<\/a><\/td>/);
  assert.match(html, /<pre data-lang="sh"><code>echo &quot;&lt;hi&gt;&quot;<\/code><\/pre>/);
  assert.match(html, /<a href="https:\/\/github.com\/M0xoo\/wisp\/blob\/main\/README.md#cli">the README<\/a>/);
});
