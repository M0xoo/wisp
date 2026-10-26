// Settings → Connectors: MCP servers every task's agent gets, whatever the harness
// (server/connectors.js). The pane lists them; adding, editing and the import review open in
// Settings' main area (host), with Back to the list. Secret values go to the server and never
// come back: a saved one shows as an empty box that says so.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { ask } from '../ui/confirm.js';
import { present } from '../ui/overlay.js';
import { toast, toastError, tryApi } from '../ui/toast.js';

const NAMES = { claude: 'Claude Code', codex: 'Codex', copilot: 'Copilot', opencode: 'OpenCode', grok: 'Grok' };
const agentName = (id) => S.agents.find((a) => a.id === id)?.name || NAMES[id] || id;
const list = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// Starting points for the empty list: the form filled in, the secret left for you.
const EXAMPLES = [
  { label: 'GitHub', name: 'github', transport: 'remote', url: 'https://api.githubcopilot.com/mcp/', headers: [{ key: 'Authorization', placeholder: 'Bearer ghp_…' }] },
  { label: 'Filesystem', name: 'filesystem', transport: 'local', command: 'npx -y @modelcontextprotocol/server-filesystem ~/Documents' },
  { label: 'Postgres', name: 'postgres', transport: 'local', command: 'npx -y @modelcontextprotocol/server-postgres postgresql://localhost/mydb' },
];

let last = null; // the last list seen, painted at once next time while a fresh one loads
let repaint = () => {}; // the open pane's, for answers that arrive from a form
// What the server answered (every write returns the whole list): shown at once.
const took = (v) => {
  if (v?.connectors) (last = v), repaint();
  return v;
};

// "npx", ["-y", "a b"] → npx -y 'a b'
const quote = (a) => (a === '' ? "''" : /[\s'"\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a);
const commandLine = (c) => [c.command, ...(c.args || [])].filter((x, i) => i > 0 || x).map(quote).join(' ');
const host = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

function statusHtml(c) {
  if (c.testing) return '<span class="cx-status muted"><span class="orb tiny"></span>Checking…</span>';
  if (!c.test) return '<span class="cx-status muted">Not checked</span>';
  if (c.test.ok) return `<span class="cx-status ok"><i class="dot ok"></i>${c.test.count} tool${c.test.count === 1 ? '' : 's'}</span>`;
  return `<span class="cx-status bad" title="${esc(c.test.error)}"><i class="dot bad"></i><span>${esc(c.test.error)}</span></span>`;
}

function rowHtml(c) {
  const what = c.transport === 'local' ? `Local · <code>${esc(c.line || commandLine(c))}</code>` : `Remote · <code>${esc(host(c.url))}</code>`;
  const own = c.own?.length ? `<small class="cx-own">${esc(list(c.own.map(agentName)))} ${c.own.length === 1 ? 'uses its' : 'use their'} own ${esc(c.name)}</small>` : '';
  return `<div class="sx-row cx-row${c.enabled ? '' : ' off'}" data-id="${esc(c.id)}">
    <span class="cx-ico">${icon('plug')}</span>
    <div class="sx-text"><b>${esc(c.name)}</b><small>${what}</small>${own}</div>
    <div class="sx-ctl">${statusHtml(c)}<button class="switch" data-act="toggle" role="switch" aria-checked="${c.enabled}" aria-label="${c.enabled ? 'Turn off' : 'Turn on'} ${esc(c.name)}" title="On / off"></button><button class="icon-btn" data-act="edit" title="Edit" aria-label="Edit ${esc(c.name)}">${icon('pen')}</button></div>
  </div>`;
}

// The pane: found servers to import, your connectors, and who they reach.
export function connectorsPane(box, host) {
  const paint = () => {
    const data = last;
    if (!data) {
      // Loading: rows the shape of the real ones.
      box.innerHTML = `<div class="sx-group cx-list">${'<div class="sx-row cx-row ph"><span class="cx-ico"></span><div class="sx-text"><b></b><small></small></div></div>'.repeat(2)}</div>`;
      return;
    }
    const found = data.found || [];
    const sources = [...new Set(found.flatMap((f) => f.from))];
    const reach = list((data.reach || []).map(agentName));
    box.innerHTML = `
      ${found.length ? `<div class="sx-group cx-found"><div class="sx-row"><span class="cx-ico">${icon('download')}</span><div class="sx-text"><b>${found.length} connector${found.length === 1 ? '' : 's'} found in ${esc(list(sources))}</b><small>${esc(found.map((f) => f.name).join(', '))}</small></div><div class="sx-ctl"><button class="ghost sm" data-act="dismiss">Not now</button><button class="primary sm" data-act="review">Review</button></div></div></div>` : ''}
      <div class="sx-head"><div><b>Your connectors</b><small>Tools like GitHub, a database or your docs, for the agent of every task</small></div><button class="ghost sm" data-act="add">${icon('plus')}Add connector</button></div>
      <div class="sx-group cx-list">${
        data.connectors.length
          ? data.connectors.map(rowHtml).join('')
          : `<div class="sx-row cx-empty"><div class="sx-text"><b>None yet</b><small>Add an MCP server, or start from one of these</small></div><div class="sx-ctl">${EXAMPLES.map((x, i) => `<button class="chip-tog" data-example="${i}">${esc(x.label)}</button>`).join('')}</div></div>`
      }</div>
      <p class="hint">They reach ${esc(reach)}, in Edits and Full auto; Plan mode runs without them. Cursor and Antigravity only read their own MCP settings.</p>`;
  };
  const load = async () => {
    const d = await api('/connectors').catch(() => null);
    if (d && box.isConnected) took(d);
  };
  repaint = () => box.isConnected && paint();
  paint();
  load();
  bus.on('connectors', load, { node: box });
  bus.on('agents', paint, { node: box });

  const find = (id) => last?.connectors.find((c) => c.id === id);
  box.onclick = async (e) => {
    const b = e.target.closest('[data-act], [data-example]');
    if (!b) return;
    if (b.dataset.example) return openEditor(host, { example: EXAMPLES[b.dataset.example] });
    const act = b.dataset.act;
    if (act === 'add') return openEditor(host);
    if (act === 'review') return openImport(host, last.found);
    if (act === 'dismiss') {
      const was = last.found;
      last.found = [];
      paint();
      const ok = took(await tryApi(() => api('/connectors/import', { method: 'POST', body: { dismiss: was.map((f) => f.name) } })));
      if (!ok) {
        last.found = was;
        paint();
      }
      return;
    }
    const c = find(b.closest('[data-id]')?.dataset.id);
    if (!c) return;
    if (act === 'edit') return openEditor(host, { item: c });
    if (act === 'toggle') {
      c.enabled = !c.enabled;
      paint();
      const ok = took(await tryApi(() => api(`/connectors/${c.id}`, { method: 'PATCH', body: { enabled: c.enabled } })));
      if (!ok) {
        c.enabled = !c.enabled;
        paint();
      }
    }
  };
}

// --- Add / edit ---

// Pasted config: Claude's or Cursor's { mcpServers: { name: {…} } }, { name: {…} } or one {…}.
function parsePasted(text) {
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const one = (name, s) => {
    if (!s || typeof s !== 'object') return null;
    const url = s.url || s.serverUrl;
    if (url) return { name, transport: 'remote', url, headers: Object.entries(s.headers || {}).map(([key, value]) => ({ key, value: String(value) })) };
    if (!s.command) return null;
    return { name, transport: 'local', command: commandLine({ command: s.command, args: (s.args || []).map(String) }), env: Object.entries(s.env || {}).map(([key, value]) => ({ key, value: String(value) })) };
  };
  if (j.command || j.url || j.serverUrl) return [one('', j)].filter(Boolean);
  const servers = j.mcpServers || j.servers || j;
  return Object.entries(servers)
    .map(([n, s]) => one(n, s))
    .filter(Boolean);
}

function pairRow(kind, p = {}) {
  const saved = p.set && !p.value;
  return `<div class="cx-pair" data-kind="${kind}">
    <input class="input mono" data-f="key" value="${esc(p.key || '')}" placeholder="${kind === 'env' ? 'API_KEY' : 'Authorization'}" spellcheck="false" autocomplete="off" aria-label="${kind === 'env' ? 'Env var name' : 'Header name'}">
    <input class="input mono" data-f="value" type="password" value="${esc(p.value || '')}" placeholder="${saved ? 'Saved · type to replace' : esc(p.placeholder || 'Value')}" spellcheck="false" autocomplete="new-password" aria-label="Value">
    <button type="button" class="icon-btn" data-act="unpair" title="Remove" aria-label="Remove ${kind === 'env' ? 'env var' : 'header'}">${icon('x')}</button>
  </div>`;
}

export function openEditor(host, { item, example, draft } = {}) {
  const d = draft || {
    name: item?.name ?? example?.name ?? '',
    transport: item?.transport || example?.transport || 'local',
    command: item ? commandLine(item) : example?.command || '',
    url: item?.url || example?.url || '',
    env: item?.env || [],
    headers: item?.headers || example?.headers || [],
  };
  const node = el(`<div class="modal cx-edit" role="dialog" aria-label="${item ? `Edit ${esc(item.name)}` : 'New connector'}">
      <header><h2>${item ? esc(item.name) : 'New connector'}</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <form class="ce-form" novalidate>
        <span class="pk-seg cx-kind" role="tablist"><button type="button" data-t="local" role="tab">Local</button><button type="button" data-t="remote" role="tab">Remote</button></span>
        <label class="ce-stack"><span>Name <small>how agents see its tools: lowercase, digits and _</small></span>
          <input class="input mono" name="name" maxlength="40" spellcheck="false" autocomplete="off" placeholder="github"></label>
        <label class="ce-stack" data-for="local"><span>Command <small>the line you’d run in a terminal. Pasting a config’s mcpServers JSON fills the form</small></span>
          <input class="input mono" name="command" spellcheck="false" autocomplete="off" placeholder="npx -y @modelcontextprotocol/server-filesystem ~/notes"></label>
        <label class="ce-stack" data-for="remote"><span>URL <small>its Streamable HTTP address, or an older one ending in /sse. Pasting JSON works here too</small></span>
          <input class="input mono" name="url" spellcheck="false" autocomplete="off" placeholder="https://mcp.example.com/mcp"></label>
        <div class="ce-stack" data-for="local"><span>Env vars <small>kept as secrets on this computer</small></span><div class="cx-pairs" data-kind="env"></div><button type="button" class="mem-add" data-act="pair" data-kind="env">${icon('plus')}Add env var</button></div>
        <div class="ce-stack" data-for="remote"><span>Headers <small>kept as secrets on this computer</small></span><div class="cx-pairs" data-kind="headers"></div><button type="button" class="mem-add" data-act="pair" data-kind="headers">${icon('plus')}Add header</button></div>
        <p class="cx-result" aria-live="polite"></p>
        <footer class="ce-foot">
          ${item ? `<button type="button" class="ghost sm danger" data-act="drop">${icon('trash')}Delete connector</button>` : ''}
          <span class="grow"></span>
          ${item ? `<button type="button" class="ghost sm cx-test" data-act="test">${icon('replay')}Check</button>` : ''}
          <button type="button" class="ghost sm" data-act="cancel">Cancel</button>
          <button class="primary sm">${item ? 'Save' : 'Add connector'}</button>
        </footer>
      </form>
    </div>`);
  const shut = present(node, host);
  // Done here: back to the list (in Settings), or closed (on its own).
  const close = () => (host && $('.sx-back', node) ? $('.sx-back', node).click() : shut());
  const f = $('form', node);
  const $f = (n) => $(`[name="${n}"]`, f);
  let transport = d.transport;
  const setKind = (t) => {
    transport = t;
    $$('.cx-kind button', node).forEach((b) => {
      b.classList.toggle('on', b.dataset.t === t);
      b.setAttribute('aria-selected', b.dataset.t === t);
    });
    // Both stay filled in: switching back finds what was typed.
    $$('[data-for]', f).forEach((x) => (x.hidden = x.dataset.for !== t));
  };
  const pairs = (kind, items) => ($(`.cx-pairs[data-kind="${kind}"]`, f).innerHTML = items.map((p) => pairRow(kind === 'env' ? 'env' : 'header', p)).join(''));
  const fill = (x) => {
    $f('name').value = x.name || '';
    $f('command').value = x.command || '';
    $f('url').value = x.url || '';
    pairs('env', x.env || []);
    pairs('headers', x.headers || []);
    setKind(x.transport || 'local');
  };
  fill(d);
  const read = (kind) =>
    $$(`.cx-pairs[data-kind="${kind}"] .cx-pair`, f)
      .map((r) => ({ key: $('[data-f="key"]', r).value.trim(), value: $('[data-f="value"]', r).value }))
      .filter((p) => p.key);
  const collect = () => ({ name: $f('name').value.trim(), transport, command: $f('command').value.trim(), url: $f('url').value.trim(), env: read('env'), headers: read('headers') });
  // The body the server takes: secrets as { KEY: value }, '' keeping a saved one.
  const body = (x) => ({
    name: x.name,
    transport: x.transport,
    ...(x.transport === 'local' ? { command: x.command, env: Object.fromEntries(x.env.map((p) => [p.key, p.value])) } : { url: x.url, headers: Object.fromEntries(x.headers.map((p) => [p.key, p.value])) }),
  });
  // A draft keeps which saved secrets it had, so coming back after a refusal still says "Saved".
  const asDraft = (x) => ({ ...x, env: x.env.map((p) => ({ ...p, set: !!item?.env.find((s) => s.key === p.key)?.set })), headers: x.headers.map((p) => ({ ...p, set: !!item?.headers.find((s) => s.key === p.key)?.set })) });

  $('.cx-kind', node).onclick = (e) => {
    const b = e.target.closest('[data-t]');
    if (b) setKind(b.dataset.t);
  };
  // Pasted JSON: one server fills the form; several are added at once.
  for (const name of ['command', 'url']) {
    $f(name).addEventListener('input', () => {
      const v = $f(name).value.trim();
      if (!v.startsWith('{')) return;
      const got = parsePasted(v);
      if (!got?.length) return;
      if (got.length === 1) {
        fill({ ...got[0], name: got[0].name || $f('name').value });
        return;
      }
      close();
      addMany(got);
    });
  }
  $f('name').addEventListener('blur', () => {
    $f('name').value = $f('name')
      .value.toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '');
  });
  f.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'cancel') return close();
    if (act === 'pair') {
      const kind = b.dataset.kind;
      $(`.cx-pairs[data-kind="${kind}"]`, f).insertAdjacentHTML('beforeend', pairRow(kind === 'env' ? 'env' : 'header'));
      return $(`.cx-pairs[data-kind="${kind}"] .cx-pair:last-child [data-f="key"]`, f).focus();
    }
    if (act === 'unpair') return b.closest('.cx-pair').remove();
    if (act === 'drop') {
      if (!(await ask(`Delete ${item.name}?\n\nIts saved secrets go with it. Tasks already running keep it until they finish.`, { ok: 'Delete connector', danger: true, anchor: b }))) return;
      close();
      const was = last;
      if (last) took({ ...last, connectors: last.connectors.filter((c) => c.id !== item.id) });
      const ok = took(await tryApi(() => api(`/connectors/${item.id}`, { method: 'DELETE' })));
      if (ok) toast(`Deleted ${esc(item.name)}`);
      else if (was) took(was);
      return;
    }
    if (act === 'test') {
      // Saves what's typed first, so the check is of what you see.
      const result = $('.cx-result', node);
      b.disabled = true;
      b.classList.add('busy');
      result.className = 'cx-result muted';
      result.innerHTML = '<span class="orb tiny"></span>Starting it the way an agent would…';
      try {
        took(await api(`/connectors/${item.id}`, { method: 'PATCH', body: body(collect()) }));
        const v = took(await api(`/connectors/${item.id}/test`, { method: 'POST', body: {} }));
        const t = v.connectors.find((c) => c.id === item.id)?.test;
        result.className = `cx-result ${t?.ok ? 'ok' : 'bad'}`;
        result.innerHTML = t?.ok ? `${icon('check')}<span>${t.count} tool${t.count === 1 ? '' : 's'}: ${esc(t.tools.slice(0, 12).join(', '))}${t.count > 12 ? ', …' : ''}</span>` : `${icon('warn')}<span>${esc(t?.error || 'It didn’t answer')}</span>`;
        $$('.cx-pair [data-f="value"]', f).forEach((x) => {
          if (x.value) (x.value = ''), (x.placeholder = 'Saved · type to replace');
        });
      } catch (err) {
        result.className = 'cx-result bad';
        result.innerHTML = `${icon('warn')}<span>${esc(err.message)}</span>`;
      } finally {
        b.disabled = false;
        b.classList.remove('busy');
      }
    }
  });
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const x = collect();
    const missing = !x.name ? 'name' : x.transport === 'local' ? (!x.command && 'command') : !x.url && 'url';
    if (missing) {
      $f(missing).setAttribute('aria-invalid', 'true');
      return $f(missing).focus();
    }
    close();
    // At once in the list, checking; refused: the form comes back with what you typed, and why.
    const was = last;
    if (last) {
      const row = { ...item, id: item?.id || 'new', name: x.name, transport: x.transport, line: x.command, url: x.url, enabled: item ? item.enabled : true, own: item?.own || [], test: null, testing: true };
      took({ ...last, connectors: item ? last.connectors.map((c) => (c.id === item.id ? row : c)) : [...last.connectors, row] });
    }
    const ok = took(await tryApi(() => (item ? api(`/connectors/${item.id}`, { method: 'PATCH', body: body(x) }) : api('/connectors', { method: 'POST', body: body(x) }))));
    if (!ok) {
      if (was) took(was);
      openEditor(host, { item, draft: asDraft(x) });
    }
  });
  for (const x of $$('input', f)) x.addEventListener('input', () => x.removeAttribute('aria-invalid'));
  setTimeout(() => {
    // An example leaves its secret for you: start there.
    const empty = $$('.cx-pair [data-f="value"]', f).find((x) => !x.value && !x.closest('[hidden]'));
    (example && empty ? empty : item ? $f(transport === 'local' ? 'command' : 'url') : $f('name')).focus();
  });
}

// Several servers pasted at once: each is added, and a refusal names which.
async function addMany(servers) {
  let added = 0;
  for (const s of servers) {
    const b = { name: s.name, transport: s.transport, ...(s.transport === 'local' ? { command: s.command, env: Object.fromEntries(s.env.map((p) => [p.key, p.value])) } : { url: s.url, headers: Object.fromEntries(s.headers.map((p) => [p.key, p.value])) }) };
    try {
      took(await api('/connectors', { method: 'POST', body: b }));
      added++;
    } catch (err) {
      toastError(new Error(`${s.name}: ${err.message}`));
    }
  }
  if (added) toast(`Added ${added} connector${added === 1 ? '' : 's'}`);
}

// --- Import review: servers in the harnesses' own configs ---

function openImport(host, found) {
  const node = el(`<div class="modal cx-import" role="dialog" aria-label="Import connectors">
      <header><h2>Import connectors</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <p class="hint">Found in your harnesses’ own MCP settings. Their env vars and headers come along as secrets; those settings stay as they are, and each harness keeps using its own copy.</p>
      <div class="cx-pick">${found
        .map(
          (s) => `<label class="ki-row"><input type="checkbox" data-name="${esc(s.name)}" checked>${icon('plug')}<span class="ki-text"><b>${esc(s.name)}</b><small>in ${esc(list(s.from))}${(s.env || s.headers || []).length ? ` · ${esc((s.env || s.headers).join(', '))}` : ''}</small><code>${esc(s.transport === 'local' ? commandLine(s) : s.url)}</code></span></label>`,
        )
        .join('')}</div>
      <footer class="ce-foot"><span class="grow"></span><button type="button" class="ghost sm" data-act="cancel">Cancel</button><button class="primary sm" data-act="import"></button></footer>
    </div>`);
  const shut = present(node, host);
  const close = () => (host && $('.sx-back', node) ? $('.sx-back', node).click() : shut());
  const picked = () => $$('[data-name]', node).filter((x) => x.checked).map((x) => x.dataset.name);
  const count = () => {
    const n = picked().length;
    const b = $('[data-act="import"]', node);
    b.textContent = `Import ${n}`;
    b.disabled = !n;
  };
  count();
  node.addEventListener('change', count);
  $('[data-act="cancel"]', node).onclick = () => {
    close();
  };
  $('[data-act="import"]', node).onclick = async () => {
    const names = picked();
    close();
    if (last) took({ ...last, found: last.found.filter((f) => !names.includes(f.name)) });
    const r = took(await tryApi(() => api('/connectors/import', { method: 'POST', body: { names } })));
    if (!r) return;
    for (const s of r.skipped || []) toastError(new Error(`${s.name}: ${s.error}`));
    const n = names.length - (r.skipped || []).length;
    if (n) toast(`Imported ${n} connector${n === 1 ? '' : 's'} · checking them now`);
  };
}
