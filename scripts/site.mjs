#!/usr/bin/env node
// Builds the docs site's generated pages next to the hand-written ones (docs/index.html, cloud.html):
// a page per harness under agents/, the guides under guides/ (scripts/guides.mjs), integrations.html
// changelog.html and privacy.html from their markdown, 404.html and sitemap.xml. The Pages workflow runs it before upload; the output is gitignored.
//
//   node scripts/site.mjs [outDir]     default: docs/

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { guides } from './guides.mjs';
import { FIGURES } from './figures.mjs';
import { TEMPLATES } from '../web/js/crew-templates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = path.join(ROOT, 'docs');
const SITE = 'https://trywisp.dev';
const REPO = 'https://github.com/M0xoo/wisp';
// Markdown with \n line ends, whatever the checkout has (Windows checks out CRLF).
const readText = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n?/g, '\n');
const INDEX = fs.readFileSync(path.join(DOCS, 'index.html'), 'utf8');
// Same stylesheet version and analytics as the landing page, so a bump there covers these pages too.
const CSS_V = INDEX.match(/style\.css\?v=(\d+)/)?.[1] || '1';
const RELAY_V = INDEX.match(/relay\.js\?v=(\d+)/)?.[1] || '1';
const SPELLS_V = INDEX.match(/spells\.js\?v=(\d+)/)?.[1] || '1';
// The guides' own stylesheet and script, named by their content so a change reaches readers at once.
const stamp = (f) => createHash('sha1').update(fs.readFileSync(path.join(DOCS, f))).digest('hex').slice(0, 8);
const GUIDE_ASSETS = `<link rel="stylesheet" href="/guide.css?v=${stamp('guide.css')}" />
  <script>document.documentElement.classList.add('js')</script>`;
const POSTHOG = INDEX.match(/<script>\s*!function\(t,e\)[\s\S]*?<\/script>/)?.[0] || '';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slug = (s) => s.toLowerCase().replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/<[^>]+>/g, '').replace(/[`*[\]]/g, '').replace(/[^\w\s.-]/g, '').trim().replace(/[\s.]+/g, '-');

// ---------- markdown (the subset integrations.md and CHANGELOG.md use) ----------

// base: where relative links in the file point (its folder on GitHub).
function inline(text, base) {
  const codes = [];
  let s = text.replace(/`([^`]+)`/g, (_, c) => `\u0000${codes.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  s = esc(s)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) => `<a href="${esc(link(href.replace(/&amp;/g, '&'), base))}">${t}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?![\w*])/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[i]);
}

function link(href, base) {
  if (/^(https?:|mailto:|#)/.test(href)) return href;
  const url = new URL(href, base).href;
  // Pages this site renders itself.
  if (url.startsWith(`${REPO}/blob/main/docs/integrations.md`)) return url.replace(/^.*integrations\.md/, '/integrations.html');
  if (url.startsWith(`${REPO}/blob/main/docs/privacy.md`)) return url.replace(/^.*privacy\.md/, '/privacy.html');
  if (url.startsWith(`${REPO}/blob/main/CHANGELOG.md`)) return url.replace(/^.*CHANGELOG\.md/, '/changelog.html');
  return url;
}

export function markdown(src, base = `${REPO}/blob/main/`) {
  const lines = src.replace(/\r/g, '').split('\n').filter((l) => !/^\[[^\]]+\]:\s+\S/.test(l));
  const out = [];
  const indent = (l) => l.match(/^ */)[0].length;
  const item = /^(\s*)([-*]|\d+\.)\s+(.*)$/;
  const startsBlock = (l) => /^(```|#{1,6}\s|\||>)/.test(l) || item.test(l);

  function list(i, depth) {
    const ordered = /^\s*\d+\./.test(lines[i]);
    const items = [];
    while (i < lines.length) {
      const l = lines[i];
      const m = l.match(item);
      if (m && indent(l) === depth) {
        items.push({ text: m[3], sub: '' });
        i++;
      } else if (m && indent(l) > depth && items.length) {
        const [html, next] = list(i, indent(l));
        items.at(-1).sub += html;
        i = next;
      } else if (l.trim() && indent(l) > depth && items.length) {
        items.at(-1).text += ` ${l.trim()}`; // a wrapped line of the item above
        i++;
      } else break;
    }
    const tag = ordered ? 'ol' : 'ul';
    return [`<${tag}>${items.map((x) => `<li>${inline(x.text, base)}${x.sub}</li>`).join('')}</${tag}>`, i];
  }

  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^```(\w*)/))) {
      const body = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      i++;
      out.push(`<pre${m[1] ? ` data-lang="${m[1]}"` : ''}><code>${esc(body.join('\n'))}</code></pre>`);
    } else if ((m = l.match(/^(#{1,6})\s+(.*)$/))) {
      const n = m[1].length;
      out.push(`<h${n} id="${slug(m[2])}">${inline(m[2], base)}</h${n}>`);
      i++;
    } else if (l.startsWith('|')) {
      const rows = [];
      for (; i < lines.length && lines[i].startsWith('|'); i++) rows.push(lines[i]);
      const cells = (r) => r.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => inline(c.trim().replace(/\\\|/g, '|'), base));
      const [head, , ...body] = rows;
      out.push(`<div class="table"><table><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (l.startsWith('>')) {
      const body = [];
      for (; i < lines.length && lines[i].startsWith('>'); i++) body.push(lines[i].replace(/^>\s?/, ''));
      out.push(`<blockquote>${markdown(body.join('\n'), base)}</blockquote>`);
    } else if (item.test(l)) {
      const [html, next] = list(i, indent(l));
      out.push(html);
      i = next;
    } else {
      const body = [];
      for (; i < lines.length && lines[i].trim() && (!body.length || !startsBlock(lines[i])); i++) body.push(lines[i].trim());
      out.push(`<p>${inline(body.join(' '), base)}</p>`);
    }
  }
  return out.join('\n');
}

// ---------- the harnesses ----------
// What wisp actually passes each CLI (server/adapters/*.js). Keep in step when an adapter changes.

const MODES = { plan: 'Plan (read-only)', edits: 'Edits', auto: 'Full auto' };

export const AGENTS = [
  {
    id: 'claude', slug: 'claude-code', name: 'Claude Code', vendor: 'Anthropic', bin: 'claude', logo: 'claudecode-color.svg',
    docs: 'https://claude.com/claude-code',
    lede: 'Hand Claude Code a task and close the tab. wisp runs it headless in its own git worktree, routes its questions and permission prompts to you, and hands back a one-screen report with the real diff and the test run.',
    run: 'claude -p --output-format stream-json \\\n  --permission-mode acceptEdits \\\n  --append-system-prompt "<wisp protocol>" \\\n  --mcp-config \'{"mcpServers":{"wisp":…}}\' --verbose',
    modes: { plan: '--permission-mode plan', edits: '--permission-mode acceptEdits', auto: '--permission-mode bypassPermissions' },
    ask: 'An MCP tool, <code>mcp__wisp__ask_user</code>, added with <code>--mcp-config</code>. The run pauses, you get a notification, and your answer goes straight back into the same session.',
    approve: 'In Edits mode, Claude Code’s permission prompts go to wisp’s <code>approve</code> tool (<code>--permission-prompt-tool</code>). The card asks <em>Allow Claude Code to run <code>npm publish</code>?</em> with <b>Allow</b>, <b>Always allow in this task</b> and <b>Deny</b>.',
    btw: 'answered on a copy of the conversation (<code>--resume &lt;id&gt; --fork-session</code>), so it knows what the run did and why',
    resume: 'claude --resume <id>',
    models: 'Opus, Sonnet or Haiku (or whatever Claude Code is set to), plus a thinking level passed as <code>--effort</code>.',
    extras: [
      'Several folders in one task: the others are passed as <code>--add-dir</code>.',
      'Claude in Chrome: when it is on by default in your Claude settings, wisp adds <code>--chrome</code>, which headless runs need.',
      'Delegate: a Claude Code lead can hand work to Codex, opencode or another Claude, here or on your other machines, through wisp’s <code>delegate</code> tool.',
    ],
  },
  {
    id: 'codex', slug: 'codex', name: 'Codex', vendor: 'OpenAI', bin: 'codex', logo: 'codex-color.svg',
    docs: 'https://github.com/openai/codex',
    lede: 'Run OpenAI’s Codex CLI on real tasks without watching it. wisp starts <code>codex exec</code> in a fresh worktree, keeps the sandbox you pick, and turns the JSON event stream into a readable report: what changed, what ran, what passed.',
    run: 'codex exec --json --skip-git-repo-check \\\n  -c sandbox_mode="workspace-write" \\\n  -c mcp_servers.wisp.command=…',
    modes: { plan: '-c sandbox_mode="read-only"', edits: '-c sandbox_mode="workspace-write"', auto: '--dangerously-bypass-approvals-and-sandbox' },
    ask: 'An MCP tool, <code>mcp__wisp__ask_user</code>, configured for the run. Codex pauses on it, and your answer comes back as the tool result.',
    approve: 'Codex has no “accept edits only” mode, so Edits uses the <code>workspace-write</code> sandbox: it edits the project and runs sandboxed commands. Anything the sandbox refuses shows up on the card with <b>Allow &amp; retry</b>.',
    btw: 'answered on a fork of the thread (<code>codex exec fork &lt;id&gt;</code>), so it knows what the run did and why',
    resume: 'codex resume <id>',
    models: 'Any model your Codex CLI can use, plus a reasoning level passed as <code>-c model_reasoning_effort</code>.',
    extras: [
      'Several folders in one task: <code>--add-dir</code> on the first turn, writable roots in the sandbox config after that.',
      'Pasted screenshots go in as images.',
      'Compare: run the same task on Codex and Claude Code side by side and keep the better branch.',
    ],
  },
  {
    id: 'cursor', slug: 'cursor', name: 'Cursor CLI', vendor: 'Cursor', bin: 'cursor-agent', logo: 'cursor.svg', mono: true,
    docs: 'https://cursor.com/cli',
    lede: 'Use the Cursor agent outside the editor. wisp drives <code>cursor-agent</code> in print mode on its own branch, reads its stream of tool calls, and gives you a report you can ship from, with any model your Cursor plan includes.',
    run: 'cursor-agent -p --output-format stream-json --trust \\\n  [--mode plan | --force] [--model <id>]',
    modes: { plan: '--mode plan', edits: '(its own permissions)', auto: '--force' },
    ask: 'Cursor CLI can’t load extra MCP servers per run, so wisp asks it to end the turn with a question block. The card shows the options; your pick resumes the session.',
    approve: 'Without <code>--force</code>, calls Cursor’s permissions refuse come back on the card with <b>Allow &amp; retry</b>.',
    btw: 'answered from wisp’s record of the task (requests, reports, actions and files changed), since Cursor CLI can’t fork a chat',
    resume: 'cursor-agent --resume <id>',
    models: 'The list from <code>cursor-agent --list-models</code>, so new models show up without a wisp update.',
    extras: [
      'Prompts go in on stdin, so long tasks and pasted logs aren’t cut by the shell.',
      'Subagent calls show on the card as <em>Delegating</em>.',
    ],
  },
  {
    id: 'opencode', slug: 'opencode', name: 'opencode', vendor: 'SST', bin: 'opencode', logo: 'opencode.svg', mono: true,
    docs: 'https://opencode.ai',
    lede: 'Point opencode at any provider and let it work in the background. wisp runs <code>opencode run</code> with the model and variant you pick, gives it a way to ask you questions, and turns the session into a short report.',
    run: 'opencode run --format json --print-logs --log-level ERROR \\\n  [--agent plan | --auto] [--model provider/model --variant <effort>]',
    modes: { plan: '--agent plan', edits: '(its own permissions)', auto: '--auto' },
    ask: 'An MCP tool, <code>wisp_ask_user</code>, added through opencode’s inline config, with a long MCP timeout so it can wait for you.',
    approve: 'Calls opencode refuses come back on the card with <b>Allow &amp; retry</b>, which re-runs the turn with just that call allowed.',
    btw: 'answered on a fork of the session (<code>--session &lt;id&gt; --fork</code>), so it knows what the run did and why',
    resume: 'opencode --session <id>',
    models: 'Every <code>provider/model</code> from <code>opencode models</code>, with each model’s variants as the thinking level.',
    extras: [
      'Attachments go in with <code>--file</code>.',
      'When a free model is rate-limited and opencode keeps retrying in silence, wisp stops waiting and says so on the card.',
      'If opencode isn’t on your PATH, wisp can install its own copy from the launcher.',
    ],
  },
  {
    id: 'antigravity', slug: 'antigravity', name: 'Antigravity CLI', vendor: 'Google', bin: 'agy', logo: 'antigravity-color.svg',
    docs: 'https://antigravity.google/docs/cli/headless/',
    lede: 'Run Google’s Antigravity agent headless on long tasks. wisp drives <code>agy</code> over stream-json with a long print timeout, so it isn’t cut off at five minutes, and turns its steps into a report.',
    run: 'agy --input-format stream-json --output-format stream-json \\\n  --print-timeout <long> --mode accept-edits',
    modes: { plan: '--mode plan', edits: '--mode accept-edits', auto: '--dangerously-skip-permissions' },
    ask: 'wisp asks it to end the turn with a question block. The card shows the options; your pick resumes the conversation.',
    approve: 'In headless mode shell commands are governed by Antigravity’s permissions; refused ones come back on the card with <b>Allow &amp; retry</b>.',
    btw: 'answered from wisp’s record of the task (requests, reports, actions and files changed)',
    resume: 'agy --conversation <id>',
    models: 'The list from <code>agy models</code>, plus a thinking level passed as <code>--effort</code>.',
    extras: [
      'Attachment folders are added with <code>--add-dir</code>.',
      'Browser steps and delegation to its own subagents show on the card as they happen.',
    ],
  },
  {
    id: 'grok', slug: 'grok', name: 'Grok Build', vendor: 'xAI', bin: 'grok', logo: 'grok.svg', mono: true,
    docs: 'https://x.ai/cli',
    lede: 'Put xAI’s Grok Build CLI to work in the background. wisp runs <code>grok</code> with your permission mode, gives it wisp’s tools through a throwaway agent file, and hands you the report when it’s done.',
    run: 'grok --prompt-file <task> --output-format streaming-messages-json \\\n  --permission-mode acceptEdits --rules "<wisp protocol>" \\\n  --agent <file with wisp’s MCP server> --no-auto-update',
    modes: { plan: '--permission-mode plan', edits: '--permission-mode acceptEdits', auto: '--permission-mode bypassPermissions' },
    ask: 'An MCP tool, reached as <code>wisp__ask_user</code>. Each turn writes an agent file that keeps Grok’s stock prompt and only adds wisp’s server.',
    approve: 'Calls its permission mode refuses come back on the card with <b>Allow &amp; retry</b>.',
    btw: 'answered from wisp’s record of the task (requests, reports, actions and files changed)',
    resume: 'grok --resume <id>',
    models: 'The list from <code>grok models</code>, with each model’s reasoning levels as <code>--reasoning-effort</code>.',
    extras: [
      'Grok’s own question tool is turned off so questions come to you through wisp.',
      'Auto-updates are off during a run, so a task never stalls on one.',
    ],
  },
  {
    id: 'copilot', slug: 'copilot', name: 'Copilot CLI', vendor: 'GitHub', bin: 'copilot', logo: 'githubcopilot.svg', mono: true,
    docs: 'https://docs.github.com/copilot/how-tos/copilot-cli',
    lede: 'Put the GitHub Copilot CLI to work in the background, with any model your Copilot plan includes. wisp hands <code>copilot</code> the task on stdin, adds wisp’s tools for the run, and turns its JSON event stream into a report you can ship from.',
    run: 'copilot --output-format json --allow-tool=write \\\n  --session-id <uuid> --no-ask-user \\\n  --additional-mcp-config \'{"mcpServers":{"wisp":…}}\' < task',
    modes: { plan: '--mode plan', edits: '--allow-tool=write', auto: '--allow-all' },
    ask: 'An MCP tool, reached as <code>wisp-ask_user</code>, added with <code>--additional-mcp-config</code> and allowed with <code>--allow-tool=wisp</code>. Copilot’s own question tool is off (<code>--no-ask-user</code>), so its questions come to you.',
    approve: 'Copilot can’t hand a permission prompt to wisp, so in Edits mode the commands its permissions refuse come back on the card with <b>Allow &amp; retry</b>, which re-runs the turn with exactly those commands allowed (<code>--allow-tool=shell(npm publish)</code>).',
    btw: 'answered from wisp’s record of the task (requests, reports, actions and files changed)',
    resume: 'copilot --resume=<id>',
    models: 'The models <code>copilot help config</code> lists (Claude, GPT, Gemini, Grok…), plus a thinking level passed as <code>--reasoning-effort</code>.',
    extras: [
      'The task goes in on stdin, so long prompts and pasted logs aren’t cut by the shell.',
      'Several folders in one task: the others are passed as <code>--add-dir</code>. Pasted screenshots go in with <code>--attachment</code>.',
      'Delegate: a Copilot lead hands work through wisp’s <code>delegate</code> tool, with its own <code>task</code> subagents turned off.',
    ],
  },
];

// ---------- page shell ----------

const GH_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

const COPY_JS = `<script>
    for (const b of document.querySelectorAll('[data-copy]')) b.addEventListener('click', async () => {
      const l = b.querySelector('.copy');
      try { await navigator.clipboard.writeText(b.dataset.copy); b.classList.add('copied'); if (l) l.textContent = 'Copied'; window.posthog?.capture?.('install_copied', { method: b.dataset.copy.split(' ')[0] }); } catch { if (l) l.textContent = 'Select'; }
      setTimeout(() => { b.classList.remove('copied'); if (l) l.textContent = 'Copy'; }, 1600);
    });
    for (const a of document.querySelectorAll('[data-cloud-cta]')) a.addEventListener('click', () => { window.posthog?.capture?.('cloud_cta_clicked', { where: a.dataset.cloudCta }, { transport: 'sendBeacon' }); });
    const nav = document.querySelector('.nav');
    addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 8), { passive: true });
  </script>`;

const installButton = (cmd = 'npx wisp-agents') =>
  `<button class="cmd" data-copy="${esc(cmd)}" aria-label="Copy install command"><span class="p">$</span><code>${esc(cmd)}</code><span class="copy">Copy</span></button>`;

// Every way to get wisp, as tabs (the landing page's selector; docs/guide.js switches them):
// npx, npm, curl, brew, and Download, which shows this OS's app (on a Mac, the curl --app install).
const WAYS = [
  ['npx', 'npx wisp-agents', 'macOS · Linux and Windows in beta · Node 20+ · MIT'],
  ['npm', 'npm install -g wisp-agents', 'Puts the wisp command on your PATH · any OS · Node 20+'],
  ['curl', 'curl -fsSL https://trywisp.dev/install.sh | bash', 'macOS and Linux · checks for Node 20+, then installs with npm'],
  ['brew', 'brew install m0xoo/tap/wisp-agents', 'Homebrew · CLI and browser mode; the desktop app is the download'],
  ['app', '', 'Free, no Node needed'],
];
const DL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11M7 10.5l5 5 5-5M5 20h14"/></svg>';
let installN = 0;
const installTabs = () => {
  const id = `get${++installN}`;
  return `<div class="g-install" data-tabs>
      <div class="hero-tabs" role="tablist" aria-label="How to get wisp">${WAYS.map(([k, cmd, note], i) => `<button class="tab" role="tab" type="button" id="${id}-${k}" aria-controls="${id}-panel" aria-selected="${!i}" tabindex="${i ? -1 : 0}" data-tab="${k}"${cmd ? ` data-cmd="${esc(cmd)}"` : ''} data-note="${esc(note)}">${k === 'app' ? 'Download' : k}</button>`).join('')}</div>
      <div role="tabpanel" id="${id}-panel" aria-labelledby="${id}-npx">
        <a class="cmd dl" hidden href="https://github.com/M0xoo/wisp/releases/latest/download/wisp-mac-arm64.dmg" data-tab-dl>${DL_ICON}<span data-dl-label>Download for macOS</span><span class="copy" data-dl-kind>.dmg</span></a>
        <button class="cmd" type="button" data-copy="npx wisp-agents" data-tab-copy aria-label="Copy install command"><span class="p">$</span><code data-tab-code>npx wisp-agents</code><span class="copy">Copy</span></button>
      </div>
      <p class="fine" data-tab-note>${WAYS[0][2]}</p>
    </div>`;
};

// path: site path ('/agents/codex.html'); crumbs: [[label, path], …] after Home.
// scripts: extra <script> tags for the end of <body> (a guide's demo).
// image: the social preview (Cloud pages get their own).
// head: extra tags for <head>; main: the <main> class; trail: false hides the breadcrumb (it stays in the schema).
function page({ path: p, title, description, crumbs = [], body, schema = [], noindex = false, scripts = '', image = '/assets/og.png', head = '', main = 'doc wrap', trail: showTrail = true }) {
  const url = `${SITE}${p}`;
  const trail = [['wisp', '/'], ...crumbs];
  const breadcrumb = {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([name, at], i) => ({ '@type': 'ListItem', position: i + 1, name, item: `${SITE}${at}` })),
  };
  const graph = noindex ? [] : [breadcrumb, ...schema];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />
${noindex ? '  <meta name="robots" content="noindex" />' : `  <link rel="canonical" href="${url}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />`}
  <meta name="theme-color" content="#f4f3ef" media="(prefers-color-scheme: light)" />
  <meta name="theme-color" content="#0e0e0d" media="(prefers-color-scheme: dark)" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="wisp" />
  <meta property="og:url" content="${url}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${SITE}${image}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${SITE}${image}" />
  <link rel="icon" href="/favicon.ico" sizes="48x48" />
  <link rel="icon" href="/assets/icon.svg" type="image/svg+xml" />
  <link rel="icon" href="/assets/favicon-192.png" type="image/png" sizes="192x192" />
  <link rel="icon" href="/assets/favicon-96.png" type="image/png" sizes="96x96" />
  <link rel="icon" href="/assets/favicon-48.png" type="image/png" sizes="48x48" />
  <link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" sizes="180x180" />
${graph.length ? `  <script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@graph': graph })}</script>\n` : ''}  <link rel="stylesheet" href="/style.css?v=${CSS_V}" />
${head ? `  ${head}\n` : ''}  ${POSTHOG}
</head>
<body class="docpage">
  <header class="nav">
    <div class="wrap nav-in">
      <a class="brand" href="/" aria-label="wisp home"><span class="mark" aria-hidden="true"></span>wisp</a>
      <nav class="links" aria-label="Primary">
        <a href="/agents/"${p.startsWith('/agents/') ? ' aria-current="page"' : ''}>Agents</a>
        <a href="/guides/"${p.startsWith('/guides/') ? ' aria-current="page"' : ''}>Guides</a>
        <a href="/integrations.html"${p === '/integrations.html' ? ' aria-current="page"' : ''}>Integrations</a>
        <a href="/changelog.html"${p === '/changelog.html' ? ' aria-current="page"' : ''}>Changelog</a>
        <a href="/cloud.html">Cloud</a>
      </nav>
      <a class="gh" href="${REPO}" target="_blank" rel="noopener">${GH_ICON}<span>GitHub</span></a>
    </div>
  </header>

  <main id="top" class="${main}">
${crumbs.length && showTrail ? `    <nav class="crumbs" aria-label="Breadcrumb"><ol>${trail.map(([name, at], i) => (i < trail.length - 1 ? `<li><a href="${at}">${esc(name)}</a></li>` : `<li aria-current="page">${esc(name)}</li>`)).join('')}</ol></nav>\n` : ''}${body}
  </main>

  <footer class="foot wrap">
    <span class="brand"><span class="mark" aria-hidden="true"></span>wisp</span>
    <span class="muted">MIT © M0xoo</span>
    <span class="grow"></span>
    <a href="/agents/">Agents</a>
    <a href="/guides/">Guides</a>
    <a href="/integrations.html">Integrations</a>
    <a href="/changelog.html">Changelog</a>
    <a href="/cloud.html">wisp Cloud</a>
    <a href="/privacy.html">Privacy</a>
    <a href="https://www.npmjs.com/package/wisp-agents" target="_blank" rel="noopener">npm</a>
    <a href="${REPO}" target="_blank" rel="noopener">GitHub</a>
  </footer>
  ${COPY_JS}${scripts ? `\n  ${scripts}` : ''}
</body>
</html>
`;
}

const APP = { '@id': `${SITE}/#app` };
const logo = (a, size = 22) => `<img src="/assets/logos/${a.logo}" alt="" width="${size}" height="${size}"${a.mono ? ' class="mono"' : ''} />`;
// prefix: 'story-' for the landing page's story shots (story-dark-compare.webp).
const shot = (name, alt, prefix = '') =>
  `<figure class="doc-shot"><picture><source srcset="/assets/shots/${prefix}dark-${name}.webp" media="(prefers-color-scheme: dark)" /><img src="/assets/shots/${prefix}light-${name}.webp" alt="${esc(alt)}" loading="lazy" /></picture></figure>`;

function agentPage(a) {
  const others = AGENTS.filter((x) => x !== a);
  const body = `
    <header class="doc-head">
      <p class="eyebrow">Agents · ${esc(a.name)}</p>
      <h1>${logo(a, 34)}Run ${esc(a.name)} in the background</h1>
      <p class="doc-lede">${a.lede}</p>
      <div class="doc-cta">${installButton()}<a class="btn" href="${a.docs}" target="_blank" rel="noopener">${esc(a.name)} docs</a></div>
      <p class="fine muted">Free and open source · uses your own ${esc(a.vendor)} account · macOS, Linux, Windows (beta) · Node 20+</p>
    </header>

    ${shot('report', `A wisp report for a task ${a.name} finished: headline, numbers, the diff and the test run`)}

    <section>
      <h2 id="what-you-get">What wisp adds to ${esc(a.name)}</h2>
      <ul class="doc-list">
        <li><b>A worktree per task.</b> Each task gets its own branch from <code>origin/main</code>, so several ${esc(a.name)} runs can work on the same repo at once without colliding.</li>
        <li><b>A report instead of a transcript.</b> When the run ends you read a headline, the numbers that changed, the real diff from its own edits, the test run and what to do next.</li>
        <li><b>Questions mid-run.</b> When it needs a decision, the card moves to <em>Needs you</em> and you get a notification, on your desktop or your phone.</li>
        <li><b>Ship it.</b> One click commits, pushes and opens the pull request; the card follows CI and review, and <b>Merge</b> syncs your local main.</li>
        <li><b>Take over any time.</b> Press <kbd>T</kbd> and your terminal opens in the worktree with <code>${esc(a.resume)}</code>.</li>
      </ul>
    </section>

    <section>
      <h2 id="how-wisp-runs-it">How wisp runs ${esc(a.name)}</h2>
      <p>wisp doesn’t replace or wrap ${esc(a.name)}’s model access: it starts the <code>${esc(a.bin)}</code> CLI you already have installed and signed in, in headless mode, and reads its event stream. Roughly:</p>
      <pre data-lang="sh"><code>${esc(a.run)}</code></pre>
      <p>Follow-ups resume the same session, so ${esc(a.name)} keeps its context. Override the binary with <code>WISP_${a.id.toUpperCase()}_BIN</code>.</p>
    </section>

    <section>
      <h2 id="permission-modes">Permission modes</h2>
      <p>Pick a mode per launch in the launcher (<kbd>Shift</kbd><kbd>Tab</kbd> cycles them) or with <code>--mode</code> on the CLI. Here is what each one passes to <code>${esc(a.bin)}</code>:</p>
      <div class="table"><table>
        <thead><tr><th>wisp mode</th><th>${esc(a.name)} flag</th></tr></thead>
        <tbody>${Object.entries(MODES).map(([k, label]) => `<tr><td>${label}</td><td><code>${esc(a.modes[k])}</code></td></tr>`).join('')}</tbody>
      </table></div>
      <p>${a.approve}</p>
    </section>

    <section>
      <h2 id="questions">Questions, <code>/btw</code> and take over</h2>
      <dl class="doc-dl">
        <div><dt>Asking you</dt><dd>${a.ask}</dd></div>
        <div><dt><code>/btw</code> side questions</dt><dd>Type <code>/btw did you update the docs too?</code> while it works. The question is ${a.btw}; the running task never sees it.</dd></div>
        <div><dt>Take over</dt><dd>Press <kbd>T</kbd> on the card, or run <code>${esc(a.resume)}</code> yourself in the task’s worktree.</dd></div>
        <div><dt>Models</dt><dd>${a.models}</dd></div>
      </dl>
      <ul class="doc-list">${a.extras.map((x) => `<li>${x}</li>`).join('')}</ul>
    </section>

    <section>
      <h2 id="get-started">Get started</h2>
      <ol class="doc-steps">
        <li><b>Install ${esc(a.name)} and sign in.</b> Follow <a href="${a.docs}" target="_blank" rel="noopener">${esc(a.vendor)}’s instructions</a> until <code>${esc(a.bin)}</code> runs in your terminal.</li>
        <li><b>Start wisp.</b> ${installButton()}</li>
        <li><b>Pick ${esc(a.name)} in the launcher</b>, describe the task and press Enter. From a shell: <code>wisp "fix the flaky auth test" --agent ${a.id}</code>.</li>
      </ol>
    </section>

    <section>
      <h2 id="other-agents">Run it next to other agents</h2>
      <p>The same queue takes every harness. Compare one task on two of them side by side, or let <b>Auto</b> pick the harness and model per task from what worked before.</p>
      <ul class="agent-grid">${others.map((x) => `<li><a href="/agents/${x.slug}.html">${logo(x)}<span>${esc(x.name)}</span></a></li>`).join('')}</ul>
      <p>Guides: ${GUIDES.filter((g) => ['run-claude-code-and-codex-in-parallel', 'run-coding-agents-on-multiple-machines', 'multi-agent-coding'].includes(g.slug)).map((g) => `<a href="/guides/${g.slug}.html">${esc(g.h1)}</a>`).join(' · ')}.</p>
    </section>
`;
  return page({
    path: `/agents/${a.slug}.html`,
    title: `Run ${a.name} in the background — wisp`,
    description: `Run ${a.name} (${a.bin}) headless in its own git worktree with wisp: questions mid-run, permission modes, /btw, take over, and a one-screen report with the real diff instead of a transcript.`,
    crumbs: [['Agents', '/agents/'], [a.name, `/agents/${a.slug}.html`]],
    body,
    schema: [
      {
        '@type': 'TechArticle',
        headline: `Run ${a.name} in the background`,
        url: `${SITE}/agents/${a.slug}.html`,
        inLanguage: 'en',
        author: { '@type': 'Person', name: 'M0xoo', url: 'https://github.com/M0xoo' },
        about: [APP, { '@type': 'SoftwareApplication', name: a.name, applicationCategory: 'DeveloperApplication', publisher: { '@type': 'Organization', name: a.vendor } }],
        isPartOf: { '@id': `${SITE}/#website` },
      },
    ],
  });
}

function agentsIndex() {
  const yes = '<span class="yes">Yes</span>';
  const rows = [
    ['CLI', (a) => `<code>${esc(a.bin)}</code>`],
    ['Plan', (a) => `<code>${esc(a.modes.plan)}</code>`],
    ['Full auto', (a) => `<code>${esc(a.modes.auto)}</code>`],
    ['Asks you via', (a) => (/MCP tool/.test(a.ask) ? 'MCP tool' : 'question block')],
    ['/btw on a fork', (a) => (/fork|copy/.test(a.btw) ? yes : 'task record')],
    ['Take over', (a) => `<code>${esc(a.resume)}</code>`],
  ];
  const body = `
    <header class="doc-head">
      <p class="eyebrow">Agents</p>
      <h1>Every coding agent CLI, one queue</h1>
      <p class="doc-lede">wisp runs the agent CLIs you already pay for: Claude Code, Codex, Cursor CLI, opencode, Antigravity CLI, Grok Build and GitHub Copilot CLI. Each runs headless on its own branch, and each hands back the same one-screen report.</p>
      <div class="doc-cta">${installButton()}</div>
    </header>

    <ul class="agent-cards">${AGENTS.map((a) => `
      <li><a href="/agents/${a.slug}.html">
        <span class="agent-name">${logo(a)}${esc(a.name)}</span>
        <span class="muted">${esc(a.vendor)} · <code>${esc(a.bin)}</code></span>
        <span class="agent-more">Run ${esc(a.name)} in the background →</span>
      </a></li>`).join('')}
    </ul>

    <section class="wide">
      <h2 id="compare">How they differ inside wisp</h2>
      <p>wisp gives every harness the same queue, reports, worktrees and shipping. What differs is what each CLI exposes: the flags behind each permission mode, whether it can load wisp’s MCP tools, and whether it can fork a conversation.</p>
      <div class="table"><table class="matrix">
        <thead><tr><th></th>${AGENTS.map((a) => `<th><a href="/agents/${a.slug}.html">${esc(a.name)}</a></th>`).join('')}</tr></thead>
        <tbody>${rows.map(([label, f]) => `<tr><th scope="row">${label}</th>${AGENTS.map((a) => `<td>${f(a)}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>
      <p>Adding a harness is one adapter file in <a href="${REPO}/tree/main/server/adapters" target="_blank" rel="noopener"><code>server/adapters/</code></a>.</p>
    </section>

    ${shot('picker', 'The wisp launcher’s harness and model picker')}
`;
  return page({
    path: '/agents/',
    title: 'Coding agents wisp runs: Claude Code, Codex, Cursor, opencode, Antigravity, Grok, Copilot',
    description: 'Run Claude Code, OpenAI Codex, Cursor CLI, opencode, Antigravity CLI, Grok Build and GitHub Copilot CLI in the background with wisp. How each one is driven, its permission flags, questions and take over.',
    crumbs: [['Agents', '/agents/']],
    body,
    schema: [{
      '@type': 'ItemList',
      name: 'Coding agents wisp runs',
      itemListElement: AGENTS.map((a, i) => ({ '@type': 'ListItem', position: i + 1, name: a.name, url: `${SITE}/agents/${a.slug}.html` })),
    }],
  });
}

// ---------- guides ----------

const sh = (code) => `<pre data-lang="sh"><code>${esc(code)}</code></pre>`;
export const GUIDES = guides({ esc, sh, shot, installButton, install: installTabs, agents: AGENTS, fig: FIGURES });
const guideUrl = (g) => `/guides/${g.slug}.html`;
// A guide's `demo`: a working copy of the feature in place of its screenshot (docs/relay.js, docs/spells.js).
// A guide's `figure`: its own diagram (inline SVG) instead of a screenshot.
const DEMOS = {
  relay: {
    html: `<div data-relay id="relay" aria-label="Try it: a task card whose next follow-up you can send to another computer or agent"></div>`,
    script: `<script src="/relay.js?v=${RELAY_V}" defer></script>`,
  },
  spells: {
    html: `<div data-spells id="spellbook" aria-label="Try it: cast a spell and watch a small wisp window change"></div>`,
    script: `<script src="/spells.js?v=${SPELLS_V}" defer></script>`,
  },
};

// The guides' sections on the index, in this order (each guide's `topic`).
const TOPICS = [
  ['agents', 'Agents side by side', 'Several agents on one repo, compared, as a team, or until the tests pass.'],
  ['machines', 'Machines and phones', 'Your other computers over SSH or the grid, and your agents from your phone.'],
  ['cloud', 'wisp Cloud', 'Agents that keep working with every lid shut, on our server or yours.'],
  ['yours', 'Make it yours', 'Change wisp itself, bring a second account, share an agent with your team.'],
];
const plain = (html) => html.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ');
// Minutes to read the words (figures and code count a little).
function readMinutes(g) {
  const words = plain(`${g.lede} ${g.body} ${g.faq.flat().join(' ')}`).split(/\s+/).filter(Boolean).length;
  return Math.max(2, Math.round(words / 230));
}
const readTime = (g) => `${readMinutes(g)} min read`;
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const LINK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" d="M6.8 9.2a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.7.7M9.2 6.8a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.7-.7"/></svg>';
const guideCard = (r) => `<li><a href="${guideUrl(r)}"><span class="k">${esc(TOPICS.find(([k]) => k === r.topic)?.[1] || 'Guide')}</span><b>${esc(r.h1)}</b><p>${esc(r.card)}</p><span class="t">${readTime(r)}</span></a></li>`;

function guidePage(g) {
  const related = g.related.map((r) => GUIDES.find((x) => x.slug === r));
  const topic = TOPICS.find(([k]) => k === g.topic);
  const updated = lastmod(['scripts/guides.mjs']);
  // The contents: every h2 in the body, then the questions.
  const toc = [...g.body.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)].map(([, id, t]) => [id, plain(t).replace(/\s+/g, ' ').trim()]);
  toc.push(['faq', 'Questions']);
  const cta = g.cloud
    ? `<div class="doc-cta"><a class="cmd link" href="https://grid.trywisp.dev" data-cloud-cta="guide-${esc(g.slug)}">Try wisp Cloud</a></div><p class="g-or">or run it on your own computers</p>${installTabs()}`
    : `${installTabs()}<p class="g-or"><a href="${REPO}" target="_blank" rel="noopener">Source on GitHub</a></p>`;
  const body = `
    <div class="g-progress" aria-hidden="true"></div>
    <article class="g-art">
      <header class="g-head">
        <p class="g-kicker"><span><a href="/guides/">Guides</a></span>${topic ? `<span>${esc(topic[1])}</span>` : ''}</p>
        <h1>${esc(g.h1)}</h1>
        <p class="g-dek">${esc(g.card)}</p>
        <div class="g-byline">
          <span class="g-avatar" aria-hidden="true"><span class="mark"></span></span>
          <div><b>wisp guides</b><span>Updated <time datetime="${updated}">${longDate(updated)}</time> · ${readTime(g)}</span></div>
          <span class="grow"></span>
          <button class="g-share" type="button" data-link aria-label="Copy a link to this guide" title="Copy a link to this guide">${LINK_ICON}<span>Copy link</span></button>
        </div>
      </header>

      <div class="g-hero">${DEMOS[g.demo]?.html || g.figure || shot(...g.shot)}${g.caption ? `<p class="g-hero-cap">${g.caption}</p>` : ''}</div>

      <div class="g-body">
        <aside class="g-toc"><nav aria-label="On this page"><p>On this page</p><ol>${toc.map(([id, t]) => `<li><a href="#${id}">${esc(t)}</a></li>`).join('')}</ol></nav></aside>
        <section class="g-intro">
          <p class="g-lede">${g.lede}</p>
          <div class="g-try-line">${g.cloud ? '<a class="cmd link" href="https://grid.trywisp.dev" data-cloud-cta="guide-intro">Try wisp Cloud</a><span>Free during the preview</span>' : installTabs()}</div>
        </section>
${g.body}
        <section class="g-faq">
          <h2 id="faq">Questions</h2>
          <div>${g.faq.map(([q, a]) => `<details><summary>${esc(q)}</summary><p>${esc(a)}</p></details>`).join('')}</div>
        </section>

        <section class="g-try">
          <div>
            <h2 id="try-it">${g.cloud ? 'Try it with the lid shut' : 'Try it on your own repo'}</h2>
            <p>${g.cloud ? 'Sign in with GitHub and give your own cloud wisp a task. Or run wisp on your own computers: same app, MIT.' : 'One command starts wisp in this folder. It runs the agent CLIs you already have, signed in as you.'}</p>
            ${cta}
            <p class="fine">Runs Claude Code, Codex, Cursor CLI, opencode, Antigravity CLI, Grok Build and Copilot CLI</p>
          </div>
        </section>
      </div>
    </article>

    <section class="g-more" aria-labelledby="related">
      <div>
        <h2 id="related">Keep reading</h2>
        <ul class="g-cards">${related.map(guideCard).join('')}</ul>
      </div>
    </section>
`;
  return page({
    path: guideUrl(g),
    title: g.title,
    description: g.description,
    crumbs: [['Guides', '/guides/'], [g.h1, guideUrl(g)]],
    trail: false,
    main: 'doc guide',
    head: GUIDE_ASSETS,
    body,
    scripts: `${DEMOS[g.demo]?.script || ''}<script src="/guide.js?v=${stamp('guide.js')}" defer></script>`,
    image: g.cloud ? '/assets/og-cloud.png' : undefined,
    schema: [
      {
        '@type': 'TechArticle',
        headline: g.h1,
        description: g.description,
        url: `${SITE}${guideUrl(g)}`,
        image: `${SITE}/assets/${g.cloud ? 'og-cloud' : 'og'}.png`,
        inLanguage: 'en',
        dateModified: updated,
        timeRequired: `PT${readMinutes(g)}M`,
        author: { '@type': 'Person', name: 'M0xoo', url: 'https://github.com/M0xoo' },
        about: APP,
        isPartOf: { '@id': `${SITE}/#website` },
      },
      {
        '@type': 'FAQPage',
        mainEntity: g.faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
      },
    ],
  });
}

function guidesIndex() {
  const lead = GUIDES.find((g) => g.slug === 'run-claude-code-and-codex-in-parallel');
  const body = `
    <article class="g-art">
      <header class="g-head">
        <p class="g-kicker"><span>Guides</span><span>${GUIDES.length} guides</span></p>
        <h1>Run coding agents in parallel, anywhere</h1>
        <p class="g-dek">Claude Code, Codex and the rest side by side on one repo, on several machines, as a team and in the background. Each guide shows the manual way with plain <code>git</code> and <code>ssh</code> first, then how wisp does it.</p>
      </header>
      <div class="g-hero">
        <a class="g-feature" href="${guideUrl(lead)}">
          <div><span class="g-kicker"><span>Start here</span><span>${readTime(lead)}</span></span><b>${esc(lead.h1)}</b><p>${esc(lead.card)}</p><span class="t">Read the guide →</span></div>
          ${shot(...lead.shot)}
        </a>
      </div>
    </article>
${TOPICS.map(([k, name, about]) => `
    <section class="g-more g-topic" aria-labelledby="t-${k}">
      <div>
        <h2 id="t-${k}">${esc(name)} <small>${GUIDES.filter((g) => g.topic === k).length}</small></h2>
        <p>${esc(about)}</p>
        <ul class="g-cards">${GUIDES.filter((g) => g.topic === k && g !== lead).map(guideCard).join('')}</ul>
      </div>
    </section>`).join('')}

    <section class="g-more g-topic" aria-labelledby="agents">
      <div>
        <h2 id="agents">By agent</h2>
        <p>How wisp runs each CLI: the flags behind each permission mode, how it asks you questions, and the take-over command.</p>
        <ul class="agent-grid">${AGENTS.map((x) => `<li><a href="/agents/${x.slug}.html">${logo(x)}<span>${esc(x.name)}</span></a></li>`).join('')}</ul>
      </div>
    </section>
`;
  return page({
    path: '/guides/',
    title: 'Guides: run Claude Code, Codex and other coding agents in parallel — wisp',
    description: 'Guides to running coding agents in parallel: Claude Code and Codex side by side, several Claude Code sessions on one repo, agents on multiple machines over SSH, multi-agent teams and background runs.',
    crumbs: [['Guides', '/guides/']],
    trail: false,
    main: 'doc guide g-index',
    head: GUIDE_ASSETS,
    body,
    schema: [{
      '@type': 'ItemList',
      name: 'wisp guides',
      itemListElement: GUIDES.map((g, i) => ({ '@type': 'ListItem', position: i + 1, name: g.h1, url: `${SITE}${guideUrl(g)}` })),
    }],
  });
}

function integrationsPage() {
  const src = readText(path.join(DOCS, 'integrations.md'));
  const title = src.match(/^# (.+)$/m)?.[1] || 'Integrating wisp';
  const html = markdown(src.replace(/^# .+\n/m, ''), `${REPO}/blob/main/docs/`);
  const toc = [...html.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map(([, id, t]) => `<li><a href="#${id}">${t}</a></li>`).join('');
  return page({
    path: '/integrations.html',
    title: 'wisp integrations: MCP server, CLI, JS SDK, HTTP API and webhooks',
    description: 'Hand tasks to wisp from Claude Code, Codex, Cursor, scripts or CI: the wisp MCP server, agent skill, scriptable CLI, JS SDK, OpenAPI HTTP API and webhooks.',
    crumbs: [['Integrations', '/integrations.html']],
    body: `
    <header class="doc-head">
      <p class="eyebrow">Docs</p>
      <h1>${esc(title)}</h1>
    </header>
    <nav class="toc" aria-label="On this page"><p class="eyebrow">On this page</p><ul>${toc}</ul></nav>
    <article class="prose">${html}</article>
`,
    schema: [{ '@type': 'TechArticle', headline: title, url: `${SITE}/integrations.html`, inLanguage: 'en', about: APP, isPartOf: { '@id': `${SITE}/#website` } }],
  });
}

function changelogPage() {
  const src = readText(path.join(ROOT, 'CHANGELOG.md'));
  // Released versions only: Unreleased describes main, not what `npx wisp-agents` gets.
  const releases = src.split(/^(?=## \[)/m).filter((s) => /^## \[\d/.test(s));
  const section = (r) => {
    const [, version, date] = r.match(/^## \[([^\]]+)\](?:\s*-\s*(\S+))?/);
    const rest = r.replace(/^.*\n/, '');
    return { version, date, html: `<section class="release" id="v${esc(version)}">
      <h2><a href="#v${esc(version)}">${esc(version)}</a>${date ? ` <time datetime="${esc(date)}">${esc(date)}</time>` : ''}</h2>
      ${markdown(rest)}
    </section>` };
  };
  // A week per group (from Monday), newest open: several releases a day read as one week's work.
  const weeks = [];
  for (const r of releases.map(section)) {
    const d = r.date ? new Date(`${r.date}T00:00:00Z`) : null;
    if (d) d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = d ? d.toISOString().slice(0, 10) : '';
    if (weeks.at(-1)?.key !== key) weeks.push({ key, d, list: [] });
    weeks.at(-1).list.push(r);
  }
  const weekName = (d) => (d ? `Week of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}` : 'Earlier');
  const body = weeks.map((w, i) => {
    const span = w.list.length > 1 ? `${w.list.at(-1).version} – ${w.list[0].version}` : w.list[0].version;
    return `<details class="rel-week"${i === 0 ? ' open' : ''}>
      <summary><b>${esc(weekName(w.d))}</b><span class="muted">${esc(span)}</span></summary>
      ${w.list.map((r) => r.html).join('\n')}
    </details>`;
  }).join('\n');
  const latest = releases[0]?.match(/^## \[([^\]]+)\]/)?.[1];
  return page({
    path: '/changelog.html',
    title: 'wisp changelog: what’s new in each release',
    description: `Release notes for wisp (wisp-agents on npm)${latest ? `, latest ${latest}` : ''}: new features, changes and fixes for the coding agent launcher.`,
    crumbs: [['Changelog', '/changelog.html']],
    body: `
    <header class="doc-head">
      <p class="eyebrow">Changelog</p>
      <h1>What’s new in wisp</h1>
      <p class="doc-lede">Every release of <code>wisp-agents</code>, a week at a time, newest first. Update with <code>npm install -g wisp-agents@latest</code>, or let the app update itself.</p>
      <p>Three channels: <b>stable</b> (<code>npm install -g wisp-agents</code>), <b>beta</b> (<code>wisp-agents@next</code>, previews like <code>0.43.0-beta.1</code>) and <b>nightly</b> (<code>wisp-agents@nightly</code>, or the apps from the <a href="https://github.com/M0xoo/wisp/releases/tag/nightly">nightly release</a>): a build of <code>main</code> every night its full test suite passes. Pick one in Settings → General → Updates and wisp updates along it.</p>
    </header>
    <article class="prose">${body}</article>
`,
    // A link to a release in a closed week opens that week.
    scripts: `<script>
    function openRelease() { const el = location.hash && document.getElementById(location.hash.slice(1)); const wk = el && el.closest('details'); if (wk && !wk.open) { wk.open = true; el.scrollIntoView(); } }
    addEventListener('hashchange', openRelease); openRelease();
  </script>`,
  });
}

// The privacy policy: the Play listing links to it (and to its #delete-your-wisp-cloud-account).
function privacyPage() {
  const src = readText(path.join(DOCS, 'privacy.md'));
  const html = markdown(src.replace(/^# .+\n/m, ''), `${REPO}/blob/main/docs/`);
  const toc = [...html.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map(([, id, t]) => `<li><a href="#${id}">${t}</a></li>`).join('');
  return page({
    path: '/privacy.html',
    title: 'wisp privacy policy',
    description: 'What wisp, the wisp Android app, wisp Cloud and trywisp.dev collect, what never leaves your computer, how to turn usage stats off and how to delete your account.',
    crumbs: [['Privacy', '/privacy.html']],
    body: `
    <header class="doc-head">
      <p class="eyebrow">Legal</p>
      <h1>Privacy policy</h1>
    </header>
    <nav class="toc" aria-label="On this page"><p class="eyebrow">On this page</p><ul>${toc}</ul></nav>
    <article class="prose">${html}</article>
`,
  });
}

function notFoundPage() {
  return page({
    path: '/404.html',
    title: 'Page not found — wisp',
    description: 'This page doesn’t exist. Find the wisp agents, integrations and changelog from here.',
    noindex: true,
    body: `
    <header class="doc-head">
      <p class="eyebrow">404</p>
      <h1>Nothing here</h1>
      <p class="doc-lede">That page doesn’t exist, or it moved. Try the <a href="/">home page</a>, the <a href="/agents/">agents</a>, the <a href="/guides/">guides</a>, the <a href="/integrations.html">integrations</a> or the <a href="/changelog.html">changelog</a>.</p>
      <div class="doc-cta">${installButton()}</div>
    </header>
`,
  });
}

// ---------- sitemap ----------

function lastmod(files) {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cs', '--', ...files], { cwd: ROOT, encoding: 'utf8' }).trim() || today();
  } catch {
    return today();
  }
}
const today = () => new Date().toISOString().slice(0, 10);

export function build(out = DOCS) {
  const pages = [
    { path: '/', file: null, sources: ['docs/index.html'], priority: '1.0' },
    { path: '/agents/', file: 'agents/index.html', html: agentsIndex(), sources: ['scripts/site.mjs', 'server/adapters'], priority: '0.8' },
    ...AGENTS.map((a) => ({ path: `/agents/${a.slug}.html`, file: `agents/${a.slug}.html`, html: agentPage(a), sources: ['scripts/site.mjs', `server/adapters/${a.id}.js`], priority: '0.8' })),
    { path: '/guides/', file: 'guides/index.html', html: guidesIndex(), sources: ['scripts/site.mjs', 'scripts/guides.mjs'], priority: '0.9' },
    ...GUIDES.map((g) => ({ path: guideUrl(g), file: `guides/${g.slug}.html`, html: guidePage(g), sources: ['scripts/guides.mjs'], priority: '0.9' })),
    { path: '/integrations.html', file: 'integrations.html', html: integrationsPage(), sources: ['docs/integrations.md'], priority: '0.7' },
    { path: '/changelog.html', file: 'changelog.html', html: changelogPage(), sources: ['CHANGELOG.md'], priority: '0.6' },
    { path: '/privacy.html', file: 'privacy.html', html: privacyPage(), sources: ['docs/privacy.md'], priority: '0.3' },
    { path: '/cloud.html', file: null, sources: ['docs/cloud.html'], priority: '0.6' },
    { path: '/404.html', file: '404.html', html: notFoundPage(), noindex: true },
  ];
  for (const p of pages.filter((x) => x.file)) {
    fs.mkdirSync(path.dirname(path.join(out, p.file)), { recursive: true });
    fs.writeFileSync(path.join(out, p.file), p.html);
  }
  // The crew templates as files to import (wisp crew import https://trywisp.dev/crew/ci.crew.json).
  fs.mkdirSync(path.join(out, 'crew'), { recursive: true });
  for (const t of TEMPLATES) fs.writeFileSync(path.join(out, 'crew', `${t.key}.crew.json`), `${JSON.stringify({ wispCrew: 1, members: [t] }, null, 2)}\n`);
  // The crew section draws the app's own spirits (docs/crew.js imports it).
  fs.copyFileSync(path.join(ROOT, 'web/js/spirit.js'), path.join(out, 'spirit.js'));
  const urls = pages.filter((p) => !p.noindex).map((p) => `  <url>\n    <loc>${SITE}${p.path}</loc>\n    <lastmod>${lastmod(p.sources)}</lastmod>\n    <priority>${p.priority}</priority>\n  </url>`);
  fs.writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`);
  return pages;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] || DOCS);
  const pages = build(out);
  console.log(`site: ${pages.filter((p) => p.file).length} pages + sitemap.xml (${pages.filter((p) => !p.noindex).length} urls) → ${path.relative(process.cwd(), out) || '.'}`);
}
