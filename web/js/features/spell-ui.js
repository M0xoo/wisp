// Spells you see and handle: the `spell` block a Cast a spell task ends with (preview, Try it,
// Keep), Settings → Spells (on/off, import, export, cast), and the Cast a spell dialog.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { overlay } from '../ui/overlay.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { registerBlock } from '../blocks.js';
import { callSpell, cleanBlocks, drawBlocks, keep, setOn, spellData, tryOn, tryingId, undoTry } from './spells.js';

const KIND = {
  safe: ['Safe', 'Changes how wisp looks and what its buttons do. Runs nothing on your computer.'],
  acts: ['Acts for you', 'Sends follow-ups, starts or files tasks, when you click (or on its own, for hooks).'],
  reads: ['Reads GitHub', 'Runs read-only gh commands to show you things.'],
  runs: ['Runs commands', 'Runs commands on your computer or POSTs to a URL. Read what it runs first.'],
};
const kindBadge = (k) => `<span class="sp-kind k-${esc(k)}" title="${esc(KIND[k]?.[1] || '')}">${esc(KIND[k]?.[0] || k)}</span>`;

const checks = new Map(); // JSON of a spell -> Promise of /spells/check
const check = (spell) => {
  const key = JSON.stringify(spell);
  if (!checks.has(key)) checks.set(key, api('/spells/check', { method: 'POST', body: { spell } }));
  return checks.get(key);
};

export const EXAMPLES = [
  'A floating button that opens all my open PRs on GitHub, with how many there are',
  'A top bar button that shows my wisp tool stats for the last 30 days',
  'A "deploy" block agents can use to show where they deployed and whether it is healthy',
  'Compact cards with bold titles, the PR first, no machine or project, and an Open PR button on hover',
  'Quick replies above the follow-up box: Run the tests, Ship it, Explain why…',
  'When a task finishes with failing tests, send it back once to fix them',
  'A bigger monospace prompt box without the compare and team buttons',
  'Codex tasks always run the linter before they report',
];

// --- the spell block -------------------------------------------------------------------------

function previewButtons(spell) {
  const list = [...(spell.buttons || []), ...(spell.chips || [])];
  if (!list.length) return '';
  return `<div class="sp-pv-btns">${list
    .map((b) => {
      const where = { topbar: 'Top bar', float: 'Floating', palette: '⌘K', 'launcher.bar': 'Prompt box', 'launcher.chips': 'Under the prompt box', 'composer.bar': 'Follow-up box', 'composer.chips': 'Above the follow-up box', 'card.head': 'Card head', 'card.hover': 'Card, on hover', 'card.menu': 'Card menu' }[b.slot] || b.slot;
      const look = b.slot === 'float' ? 'sp-fab' : b.slot === 'topbar' ? 'auto-btn sp-btn' : b.slot === 'card.hover' ? 'it-quick sp-quick' : b.slot?.endsWith('chips') || b.text !== undefined ? 'sp-qr' : 'ghost sm sp-btn';
      const label = b.label || b.text || '';
      return `<span class="sp-pv"><small>${esc(where)}</small><span class="${look}">${b.icon ? icon(b.icon) : b.slot === 'float' || b.slot === 'topbar' ? icon('spark') : ''}${label ? `<span${b.slot === 'float' ? ' class="sp-fab-l"' : ''}>${esc(label)}</span>` : ''}</span></span>`;
    })
    .join('')}</div>`;
}

async function previewPanel(host, spell) {
  const p = (spell.panels || [])[0];
  if (!p) return;
  host.append(el(`<div class="sp-pv-panel"><small>${esc(p.title || p.id)} · ${p.as === 'card' ? 'in each card' : p.as === 'feed' ? 'above the feed' : 'a dialog'}</small><div class="sp-pv-body"><div class="it-loading"><span class="orb tiny"></span>Rendering with your data…</div></div></div>`));
  const body = $('.sp-pv-body', host);
  try {
    const sample = p.as === 'card' ? [...S.sessions.values()].find((s) => !s.pending && s.agent !== 'wisp') : null;
    const data = await spellData(spell, p.data || [], sample?.id || null);
    body.replaceChildren(drawBlocks(cleanBlocks(await callSpell(spell, p.render, [data, { session: sample || null }]))));
  } catch (err) {
    body.replaceChildren(el(`<div class="sp-error">${icon('warn')}<span>${esc(err.message)}</span></div>`));
  }
}

registerBlock('spell', (b, ctx) => {
  const sessionId = ctx.session?.id || null;
  // A removal: { remove: id }, or (as agents also write it) { spell: { remove: id } }.
  if (!b.remove && typeof b.spell?.remove === 'string' && !b.spell.wispSpell) b = { ...b, remove: b.spell.remove };
  if (b.remove) {
    const have = (S.config.spells || []).find((s) => s.id === b.remove);
    const node = el(`<div class="b-spell card"><div class="sp-head">${icon('spark')}<b>Remove the spell ${esc(have?.name || b.remove)}</b></div><p class="sp-desc">Turns it off and deletes it. Whatever it changed goes back to how wisp was.</p><div class="sp-acts"><button class="ghost sm danger" data-a="rm">${icon('trash')}Remove</button></div></div>`);
    $('[data-a="rm"]', node).onclick = async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      const r = await tryApi(() => api(`/spells/${encodeURIComponent(b.remove)}`, { method: 'DELETE' }));
      if (r) (btn.innerHTML = `${icon('check')}Removed`), bus.emit('spells:changed');
      else btn.disabled = false;
    };
    return node;
  }
  const spell = b.spell && typeof b.spell === 'object' ? b.spell : {};
  const node = el(`
    <div class="b-spell card">
      <div class="sp-head">${icon('spark')}<b>${esc(spell.name || spell.id || 'Spell')}</b><span class="sp-ver">v${esc(spell.version || '1.0.0')}</span><span class="sp-kindslot"></span><span class="sp-state"></span></div>
      ${spell.description ? `<p class="sp-desc">${esc(spell.description)}</p>` : ''}
      <ul class="sp-lines"><li class="it-loading"><span class="orb tiny"></span>Checking it…</li></ul>
      <div class="sp-preview"></div>
      <div class="sp-acts">
        <button class="primary sm" data-a="keep" disabled>${icon('check')}Keep</button>
        <button class="ghost sm" data-a="try" disabled>${icon('play')}Try it</button>
        <button class="ghost sm" data-a="json">${icon('text')}JSON</button>
        <button class="ghost sm" data-a="copy">${icon('copy')}Copy</button>
      </div>
      <pre class="code sp-json" hidden><code>${esc(JSON.stringify(spell, null, 2))}</code></pre>
    </div>`);
  const pv = $('.sp-preview', node);
  pv.innerHTML = previewButtons(spell);
  if ((spell.blocks || []).length) pv.insertAdjacentHTML('beforeend', `<p class="sp-pv-note">${icon('spark')}Agents can use ${spell.blocks.map((x) => `<code>${esc(x.type)}</code>`).join(', ')} in their reports once it's on.</p>`);
  const paintState = (r) => {
    const on = (S.config.spells || []).find((s) => s.id === r.spell.id);
    const same = on && JSON.stringify(on) === JSON.stringify({ ...r.spell, kind: on.kind });
    const keepBtn = $('[data-a="keep"]', node);
    const tryBtn = $('[data-a="try"]', node);
    keepBtn.disabled = !!same;
    keepBtn.innerHTML = same ? `${icon('check')}On` : r.installed ? `${icon('check')}${r.installed.same ? 'Turn on' : `Keep (replaces v${esc(r.installed.version)})`}` : `${icon('check')}Keep`;
    tryBtn.disabled = !!same;
    tryBtn.innerHTML = tryingId() === r.spell.id ? `${icon('x')}Stop trying` : `${icon('play')}Try it`;
    $('.sp-state', node).innerHTML = same ? '<span class="sp-on">On</span>' : '';
  };
  check(spell)
    .then((r) => {
      if (!node.isConnected && !node.parentNode) return;
      if (!r.ok) {
        $('.sp-lines', node).innerHTML = r.problems.map((p) => `<li class="bad">${icon('x')}${esc(p)}</li>`).join('');
        const acts = $('.sp-acts', node);
        $('[data-a="keep"]', node).remove();
        $('[data-a="try"]', node).remove();
        if (ctx.reply && ctx.isLatest) {
          const fix = el(`<button class="primary sm" data-a="fix">${icon('pen')}Fix it</button>`);
          fix.onclick = () => {
            ctx.reply(`The spell has problems wisp found:\n${r.problems.map((p) => `- ${p}`).join('\n')}\n\nFix them (check with wisp_spell_check) and hand the spell back.`);
          };
          acts.prepend(fix);
        }
        return;
      }
      $('.sp-kindslot', node).innerHTML = kindBadge(r.kind);
      $('.sp-lines', node).innerHTML = r.summary.map((l) => `<li>${icon('check')}${esc(l)}</li>`).join('') + (r.warnings || []).map((w) => `<li class="warn">${icon('warn')}${esc(w)}</li>`).join('');
      paintState(r);
      node.spellCheck = r;
      previewPanel(pv, r.spell);
    })
    .catch((err) => ($('.sp-lines', node).innerHTML = `<li class="bad">${icon('x')}${esc(err.message)}</li>`));
  node.addEventListener('click', async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    const r = node.spellCheck;
    if (a === 'json') $('.sp-json', node).hidden = !$('.sp-json', node).hidden;
    if (a === 'copy') navigator.clipboard.writeText(JSON.stringify(spell, null, 2)).then(() => toast('Copied the spell'));
    if (!r) return;
    if (a === 'try') {
      if (tryingId() === r.spell.id) undoTry();
      else tryOn(r.spell, sessionId);
      paintState(r);
    }
    if (a === 'keep') {
      const btn = e.target.closest('button');
      btn.disabled = true;
      if (await keep(r.spell, sessionId)) paintState(r);
      else btn.disabled = false;
    }
  });
  bus.on('spells', () => node.spellCheck && paintState(node.spellCheck), { node });
  return node;
});

// --- casting ---------------------------------------------------------------------------------

export async function cast(prompt) {
  const text = String(prompt || '').trim();
  if (!text) return null;
  const out = await api('/sessions', { method: 'POST', body: { prompt: text, kind: 'spell', agent: S.config.defaults.agent || undefined, model: S.config.defaults.model || undefined, effort: S.config.defaults.effort || undefined } });
  S.sessions.set(out.id, out);
  const { renderFeed, reveal } = await import('./feed.js');
  renderFeed();
  reveal(out.id);
  toast(`${icon('spark')} Casting: the agent writes the spell, then you try it and keep it`);
  return out;
}

export function openCast(prefill = '') {
  const node = el(`
    <form class="modal sp-cast">
      <header><h2>${icon('spark')} Cast a spell</h2><button type="button" class="icon-btn close">${icon('x')}</button></header>
      <p class="hint">Say what to change in wisp: a button, a panel, a block for agents, a different look, how agents behave. An agent writes it as a spell; you see a preview, try it and keep it. Nothing changes until you do.</p>
      <textarea class="input" rows="3" placeholder="A floating button that opens all my PRs…" spellcheck="false"></textarea>
      <div class="sp-examples">${EXAMPLES.slice(0, 6).map((x) => `<button type="button" class="sp-qr">${esc(x)}</button>`).join('')}</div>
      <footer><span class="hint">Runs on ${esc(S.config.defaults.agent === 'auto' || !S.config.defaults.agent ? 'Auto' : S.config.defaults.agent)} in an empty folder of its own: it writes the spell, not your code.</span><button class="primary" type="submit">${icon('spark')}Cast</button></footer>
    </form>`);
  const ta = $('textarea', node);
  ta.value = prefill;
  const close = overlay(node);
  $('.close', node).onclick = close;
  $('.sp-examples', node).onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    ta.value = b.textContent;
    ta.focus();
  };
  ta.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      node.requestSubmit();
    }
  };
  node.onsubmit = async (e) => {
    e.preventDefault();
    const text = ta.value.trim();
    if (!text) return ta.focus();
    close();
    await cast(text).catch((err) => {
      toastError(err);
      openCast(text);
    });
  };
  setTimeout(() => ta.focus(), 50);
}

// --- Settings → Spells -----------------------------------------------------------------------

const sourceLabel = (src) => (!src ? '' : src.kind === 'cast' ? 'Cast here' : src.kind === 'gist' ? `From a gist${src.owner ? ` by ${src.owner}` : ''}` : src.kind === 'url' ? 'From a link' : src.kind === 'file' ? `Imported${src.name ? ` (${src.name})` : ''}` : 'Added here');

function download(name, json) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Review before installing: what it does and how risky, and Keep (on) / Add (off) / Cancel.
export async function reviewImport(body) {
  const r = await api('/spells/check', { method: 'POST', body });
  if (!r.ok) {
    toast(`That spell has problems: ${esc(r.problems.slice(0, 2).join('; '))}${r.problems.length > 2 ? '…' : ''}`, { tone: 'bad', timeout: 8000 });
    return;
  }
  const node = el(`
    <div class="modal sp-review">
      <header><h2>${icon('spark')} ${esc(r.spell.name)} <span class="sp-ver">v${esc(r.spell.version)}</span></h2><button class="icon-btn close">${icon('x')}</button></header>
      ${r.spell.author ? `<p class="hint">By ${esc(r.spell.author)}</p>` : ''}
      ${r.spell.description ? `<p>${esc(r.spell.description)}</p>` : ''}
      <div class="sp-review-kind">${kindBadge(r.kind)}<span>${esc(KIND[r.kind]?.[1] || '')}</span></div>
      <ul class="sp-lines">${r.summary.map((l) => `<li>${icon('check')}${esc(l)}</li>`).join('')}</ul>
      ${r.installed ? `<p class="hint">You have v${esc(r.installed.version)}${r.installed.enabled ? ' (on)' : ''}; this replaces it.</p>` : ''}
      <details><summary>The spell's JSON</summary><pre class="code"><code>${esc(JSON.stringify(r.spell, null, 2))}</code></pre></details>
      <footer><button class="ghost" data-a="try">${icon('play')}Try it</button><span class="grow"></span><button class="ghost" data-a="add">Add, off</button><button class="primary" data-a="keep">${icon('check')}Keep and turn on</button></footer>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  node.onclick = async (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'try') return close(), tryOn(r.spell);
    close();
    if (a === 'keep') return keep(r.spell);
    const out = await tryApi(() => api('/spells', { method: 'POST', body: { spell: r.spell, source: body.url ? undefined : { kind: 'file' } } }));
    if (out) toast(`Added <b>${esc(r.spell.name)}</b>, off. Turn it on in Settings → Spells`), bus.emit('spells:changed');
  };
}

export function spellsPane(section) {
  section.innerHTML = `
    <div class="sx-group sp-castbox">
      <div class="sx-row"><div class="sx-text"><b>Cast a spell</b><small>Ask for a change to wisp. An agent writes it; you try it and keep it.</small></div></div>
      <div class="sp-castrow"><textarea class="input" rows="2" placeholder="A floating button that opens all my PRs…" spellcheck="false"></textarea><button class="primary sm" data-a="cast">${icon('spark')}Cast</button></div>
      <div class="sp-examples">${EXAMPLES.map((x) => `<button type="button" class="sp-qr">${esc(x)}</button>`).join('')}</div>
    </div>
    <div class="sx-group sp-list"></div>
    <div class="sx-group">
      <div class="sx-row"><div class="sx-text"><b>Add a spell</b><small>A <code>.spell.json</code> file a colleague sent, its JSON, or a link (https or <code>gist:&lt;id&gt;</code>). You review it before anything changes.</small></div>
        <div class="sx-ctl"><button class="ghost sm" data-a="file">${icon('file')}File…</button><input type="file" accept=".json,application/json" hidden></div></div>
      <div class="sp-castrow"><input class="input mono" placeholder="Paste JSON or a link" spellcheck="false"><button class="ghost sm" data-a="paste">Review</button></div>
    </div>
    <p class="hint sp-foot"></p>`;
  const list = $('.sp-list', section);
  const paint = async () => {
    const r = await api('/spells').catch(() => null);
    if (!section.isConnected || !r) return;
    $('.sp-foot', section).innerHTML = r.safe
      ? `${icon('warn')} Safe mode: wisp started with <code>WISP_SAFE=1</code> (or <code>--safe</code>), so every spell is off.`
      : `Spells live in <code>~/.wisp/spells</code>. Turning one off puts back exactly what it changed. <button class="link xs" data-a="alloff">Turn every spell off</button>`;
    if (!r.spells.length && !r.broken.length) {
      list.innerHTML = `<div class="sp-none">${icon('spark')}<div><b>No spells yet</b><p>Cast one above, or add one a colleague sent you.</p></div></div>`;
      return;
    }
    list.innerHTML =
      r.spells
        .map(
          (s) => `
      <div class="sx-row sp-row" data-id="${esc(s.id)}">
        <div class="sx-text"><b>${esc(s.name)} <span class="sp-ver">v${esc(s.version)}</span> ${kindBadge(s.kind)}</b>
          <small>${esc(s.description || s.summary[0] || '')}${s.source ? ` · ${esc(sourceLabel(s.source))}` : ''}</small>
          <details><summary>What it does</summary><ul class="sp-lines">${s.summary.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details></div>
        <div class="sx-ctl">
          <button class="icon-btn" data-a="export" title="Export ${esc(s.name)} as a file to share">${icon('arrow')}</button>
          <button class="icon-btn" data-a="copy" title="Copy its JSON (to paste in a chat)">${icon('copy')}</button>
          <button class="icon-btn" data-a="remove" title="Remove">${icon('trash')}</button>
          <button class="switch" role="switch" aria-checked="${s.enabled}" aria-label="${s.enabled ? 'On' : 'Off'}" data-a="toggle" ${r.safe ? 'disabled' : ''}></button>
        </div>
      </div>`,
        )
        .join('') + r.broken.map((b) => `<div class="sx-row sp-row broken" data-id="${esc(b.id)}"><div class="sx-text"><b>${esc(b.id)} <span class="sp-kind k-runs">Broken</span></b><small>${esc(b.error)}</small></div><div class="sx-ctl"><button class="icon-btn" data-a="remove" title="Remove">${icon('trash')}</button></div></div>`).join('');
  };
  paint();
  bus.on('config', paint, { node: section });
  bus.on('spells:changed', paint, { node: section });
  const castTa = $('.sp-castbox textarea', section);
  const doCast = async () => {
    const text = castTa.value.trim();
    if (!text) return castTa.focus();
    castTa.value = '';
    const out = await cast(text).catch(toastError);
    if (!out) castTa.value = text;
    else $('#overlay').close?.();
  };
  castTa.onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      doCast();
    }
  };
  const file = $('input[type=file]', section);
  file.onchange = async () => {
    const f = file.files[0];
    if (f) await reviewImport({ text: await f.text(), name: f.name }).catch(toastError);
    file.value = '';
  };
  section.ondragover = (e) => e.preventDefault();
  section.ondrop = async (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    await reviewImport({ text: await f.text(), name: f.name }).catch(toastError);
  };
  section.onclick = async (e) => {
    const b = e.target.closest('[data-a]');
    if (!b) {
      const ex = e.target.closest('.sp-examples .sp-qr');
      if (ex) (castTa.value = ex.textContent), castTa.focus();
      return;
    }
    const a = b.dataset.a;
    const id = b.closest('[data-id]')?.dataset.id;
    if (a === 'cast') return doCast();
    if (a === 'file') return file.click();
    if (a === 'paste') {
      const v = $('.sp-castrow input', section).value.trim();
      if (!v) return;
      await reviewImport(/^(https:\/\/|gist:)/i.test(v) ? { url: v } : { text: v }).catch(toastError);
      $('.sp-castrow input', section).value = '';
      return;
    }
    if (a === 'alloff') {
      await tryApi(() => api('/spells/off', { method: 'POST', body: {} }));
      return paint();
    }
    if (a === 'toggle') {
      const on = b.getAttribute('aria-checked') !== 'true';
      b.setAttribute('aria-checked', on); // optimistic
      if (!(await setOn(id, on))) b.setAttribute('aria-checked', !on);
      return;
    }
    if (a === 'export') return download(`${id}.spell.json`, await api(`/spells/${id}/export`));
    if (a === 'copy') {
      await navigator.clipboard.writeText(JSON.stringify(await api(`/spells/${id}/export`), null, 2));
      return toast('Copied. Paste it to a colleague; they add it in Settings → Spells');
    }
    if (a === 'remove') {
      const row = b.closest('.sp-row');
      row.hidden = true; // optimistic
      const r = await tryApi(() => api(`/spells/${id}`, { method: 'DELETE' }));
      if (!r) row.hidden = false;
      else bus.emit('spells:changed');
    }
  };
}

// Drop a .spell.json anywhere on the window: review it.
document.addEventListener('drop', async (e) => {
  const f = [...(e.dataTransfer?.files || [])].find((x) => /\.spell\.json$/i.test(x.name));
  if (!f || e.defaultPrevented) return;
  e.preventDefault();
  await reviewImport({ text: await f.text(), name: f.name }).catch(toastError);
});

// #/spell?src=gist:… (a share link opened in wisp): review it.
export function routeSpell() {
  const m = location.hash.match(/^#\/spell\?src=(.+)$/);
  if (!m) return false;
  history.replaceState(null, '', '#/');
  reviewImport({ url: decodeURIComponent(m[1]) }).catch(toastError);
  return true;
}
