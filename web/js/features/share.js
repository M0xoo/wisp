// Sharing a task with people on your wisp Grid (server/services/share.js). Share… in a task's menus
// opens the dialog: anyone with the link, or only with a passkey; with its work or without. A
// share link pasted in the New task box shows as a card there (shareCard): Enter imports it, and
// whatever else you typed is its first follow-up.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { copy } from '../blocks.js';
import { overlay } from '../ui/overlay.js';
import { toast } from '../ui/toast.js';
import { runnerPicker } from './runner-picker.js';
import { paintRunnerBtn, savedEffort, savedModel } from './runners.js';

// <grid>/s/<16 characters>, anywhere in the text.
const LINK = /(https?:\/\/[^\s/]+\/s\/[A-Za-z0-9_-]{16})\/?(?=[\s.,;)]|$)/;
export const shareLinkIn = (text) => LINK.exec(String(text || ''))?.[1] || '';
const withoutLink = (text, link) => String(text || '').replace(new RegExp(`${link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?`), '').trim();
export const shareable = (s) => !!s && s.agent !== 'wisp' && !s.parentId && !s.kind && !s.pending && !s.delegated && !s.machine;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A passkey to suggest: four short words' worth of letters and digits, easy to read out.
const suggest = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('').replace(/(.{4})(?=.)/g, '$1-');

// --- Share… -------------------------------------------------------------------------------------

export async function shareTask(id) {
  const sum = S.sessions.get(id);
  if (!sum) return;
  // The dialog opens at once, in the shape it will have; what goes with it fills in.
  const node = el(`<div class="modal share-modal" role="dialog" aria-label="Share ${esc(sum.title)}">
      <header><h2>Share task</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <p class="sm-title">${esc(sum.title)}</p>
      <div class="sm-carry" aria-busy="true"><i class="sk sk-chip"></i><i class="sk sk-chip short"></i><i class="sk sk-chip"></i></div>
      <fieldset class="sm-who">
        <legend>Who can open it</legend>
        <label class="sm-opt"><input type="radio" name="who" value="link" checked><span><b>Anyone with the link</b><small>Reads it in a browser. People on your grid import it into their wisp.</small></span></label>
        <label class="sm-opt"><input type="radio" name="who" value="pass"><span><b>Only with a passkey</b><small>Opening or importing it asks for the passkey you give them.</small></span></label>
        <div class="sm-pass" hidden><input class="input" name="passkey" autocomplete="off" spellcheck="false" maxlength="128" aria-label="Passkey"><button type="button" class="icon-btn" data-a="new-pass" title="Another passkey" aria-label="Another passkey">${icon('rerun')}</button></div>
      </fieldset>
      <div class="cs-opts"><label class="check"><input type="checkbox" name="work" checked><span>Its work <small class="sm-work">the branch and uncommitted changes</small></span></label></div>
      <div class="sm-link" hidden><input class="input" readonly aria-label="Share link"><button type="button" class="ghost sm" data-a="copy">${icon('copy')}Copy</button></div>
      <div class="cs-out" aria-live="polite"></div>
      <footer class="ce-foot">
        <button type="button" class="ghost sm danger" data-a="stop" hidden>${icon('x')}Stop sharing</button>
        <span class="grow"></span>
        <button type="button" class="primary sm" data-a="share" disabled>${icon('share')}Share</button>
      </footer>
    </div>`);
  const close = overlay(node);
  $('.close', node).onclick = close;
  const out = $('.cs-out', node);
  const goBtn = $('[data-a="share"]', node);
  const stopBtn = $('[data-a="stop"]', node);
  const linkRow = $('.sm-link', node);
  const pass = $('[name="passkey"]', node);
  const passRow = $('.sm-pass', node);
  let info = null;
  const notes = (list = [], tone = 'info') => (out.innerHTML = list.map((n) => `<p class="${tone === 'bad' ? 'cs-bad' : 'cs-note'}">${icon(tone === 'bad' ? 'warn' : 'info')}<span>${esc(n)}</span></p>`).join(''));
  const paintLink = (shared) => {
    linkRow.hidden = !shared;
    stopBtn.hidden = !shared;
    if (shared) $('input', linkRow).value = shared.url;
    goBtn.innerHTML = `${icon('share')}${shared ? 'Update link' : 'Share'}`;
  };
  const paintWho = () => {
    const locked = $('[name="who"]:checked', node).value === 'pass';
    passRow.hidden = !locked;
    if (locked && !pass.value) pass.value = suggest();
    if (locked) pass.select();
  };
  node.addEventListener('change', (e) => e.target.name === 'who' && paintWho());
  $('[data-a="new-pass"]', node).onclick = () => {
    pass.value = suggest();
    pass.select();
  };
  $('[data-a="copy"]', node).onclick = (e) => {
    copy($('input', linkRow).value, e.currentTarget);
    toast('Link copied');
  };

  try {
    info = await api(`/sessions/${id}/share`);
  } catch (err) {
    $('.sm-carry', node).remove();
    return notes([err.message], 'bad');
  }
  const t = S.full.get(id);
  const turns = (t?.turns || []).filter((x) => x.status !== 'running').length;
  const chips = [
    turns && `${icon('comment')}${plural(turns, 'turn')}`,
    info.work?.branch && `${icon('branch')}${esc(info.work.branch)}`,
    info.delegates && `${icon('agent')}${plural(info.delegates, 'delegated task')}`,
    info.crew?.length && `${icon('crew')}${esc(info.crew.join(', '))}`,
    info.connectors?.length && `${icon('plug')}${plural(info.connectors.length, 'connector')}`,
    info.skills?.length && `${icon('read')}${plural(info.skills.length, 'skill')}`,
  ].filter(Boolean);
  const carry = $('.sm-carry', node);
  carry.removeAttribute('aria-busy');
  carry.innerHTML = chips.map((c) => `<span>${c}</span>`).join('') || '<span>The conversation</span>';
  carry.title = [info.connectors?.length && `Connectors: ${info.connectors.join(', ')} (never their keys)`, info.skills?.length && `Skills: ${info.skills.join(', ')}`].filter(Boolean).join('\n');
  const work = $('[name="work"]', node);
  if (!info.work) (work.checked = false), (work.disabled = true), ($('.sm-work', node).textContent = 'no git repo or files to send');
  else $('.sm-work', node).textContent = info.work.kind === 'files' ? 'the files in its folder' : `${info.work.branch ? `branch ${info.work.branch}` : 'its branch'} and uncommitted changes${info.work.repo ? '' : ' (no remote: the whole history goes)'}`;
  if (info.shared?.locked) ($('[value="pass"]', node).checked = true), (passRow.hidden = false), (pass.placeholder = 'Kept: type a new one to change it');
  paintLink(info.shared);
  if (!info.targets.length) {
    notes(['Sign in to a wisp Grid first (Settings → Cloud): tasks are shared with the people on it.'], 'bad');
    return;
  }
  notes([`On ${info.targets[0].host}. Secrets in the conversation are replaced with [redacted]; connectors go without their keys.`]);
  goBtn.disabled = false;

  goBtn.onclick = async () => {
    const locked = $('[name="who"]:checked', node).value === 'pass';
    const key = locked ? pass.value.trim() : '';
    if (locked && !key && !info.shared?.locked) return pass.focus();
    goBtn.disabled = true;
    goBtn.classList.add('busy');
    try {
      const r = await api(`/sessions/${id}/share`, { method: 'POST', body: { passkey: locked && !key ? undefined : key, work: work.checked } });
      info.shared = r;
      paintLink(r);
      copy(r.url);
      notes([`Link copied${locked ? '. Send the passkey separately' : ''}.`, ...(r.notes || [])]);
      const cur = S.sessions.get(id);
      if (cur) S.sessions.set(id, { ...cur, shared: r });
    } catch (err) {
      notes([err.message], 'bad');
    } finally {
      goBtn.disabled = false;
      goBtn.classList.remove('busy');
    }
  };
  // Stop sharing: the link goes at once; a refusal brings it back.
  stopBtn.onclick = async () => {
    const was = info.shared;
    paintLink(null);
    notes(['The link no longer opens.']);
    try {
      await api(`/sessions/${id}/share`, { method: 'DELETE' });
      info.shared = null;
      const cur = S.sessions.get(id);
      if (cur) S.sessions.set(id, { ...cur, shared: undefined });
    } catch (err) {
      paintLink(was);
      notes([err.message], 'bad');
    }
  };
}

// --- the card for a pasted link -----------------------------------------------------------------

// The card in the New task box. host: the row it paints into (.l-share); ta: the prompt box.
// → { active(), take(text) }: take resolves the request body for /shares/import (null when the
// card can't import yet, having said why).
export function shareCard(host, ta) {
  let link = '';
  let card = null; // the peek's answer
  let state = 'off'; // off | loading | open | locked | error
  let error = '';
  let dismissed = '';
  let passkey = '';
  let run = null; // { agent, model, effort } picked on the card
  const opts = { connectors: true, crew: true };
  let seq = 0;

  const face = (from) => (from?.avatar ? `<img class="ls-av" src="${esc(from.avatar)}" alt="">` : `<span class="ls-av">${esc((from?.name || from?.handle || '?').trim()[0]?.toUpperCase() || '?')}</span>`);
  const who = (from) => esc(from?.name || from?.handle || 'Someone');
  const paint = () => {
    host.hidden = state === 'off';
    host.dataset.state = state;
    if (state === 'off') return (host.innerHTML = '');
    const x = `<button type="button" class="att-x" data-a="x" aria-label="Not this link" title="Leave it as text">${icon('x')}</button>`;
    if (state === 'loading') return (host.innerHTML = `<div class="ls-card" aria-busy="true"><span class="ls-av sk"></span><span class="ls-main"><i class="sk sk-line short"></i><i class="sk sk-line"></i></span>${x}</div>`);
    if (state === 'error') return (host.innerHTML = `<div class="ls-card bad">${icon('warn')}<span class="ls-main"><b>Can’t open this shared task</b><small>${esc(error)}</small></span>${x}</div>`);
    if (state === 'locked')
      return (host.innerHTML = `<div class="ls-card">${face(card?.from)}<span class="ls-main"><b>${who(card?.from)} locked this task</b><small>${card?.wrong ? 'That passkey isn’t right. ' : ''}Type the passkey they gave you.</small><form class="ls-lock"><input class="input" type="password" name="passkey" autocomplete="off" placeholder="Passkey" aria-label="Passkey"><button class="ghost sm">${icon('lock')}Unlock</button></form></span>${x}</div>`);
    const c = card;
    const facts = [
      plural(c.turns, 'turn'),
      c.delegates && plural(c.delegates, 'delegated task'),
      c.work?.branch ? `branch ${c.work.branch}` : c.work?.kind === 'files' ? 'its files' : !c.work && 'no work attached',
      c.connectors?.length && plural(c.connectors.length, 'connector'),
      c.skills?.length && plural(c.skills.length, 'skill'),
    ].filter(Boolean);
    const r = run || c.run;
    const changed = !run && c.run?.note;
    const checks = [
      c.newConnectors?.length && `<label class="check"><input type="checkbox" name="connectors" ${opts.connectors ? 'checked' : ''}><span>Add their connectors <small>${esc(c.newConnectors.join(', '))}: a command one starts switched off</small></span></label>`,
      c.newCrew?.length && `<label class="check"><input type="checkbox" name="crew" ${opts.crew ? 'checked' : ''}><span>Add ${esc(c.newCrew.join(', '))} to your crew <small>it delegated to ${c.newCrew.length === 1 ? 'them' : 'them'}</small></span></label>`,
    ].filter(Boolean);
    host.innerHTML = `<div class="ls-card open">${face(c.from)}<span class="ls-main">
        <small class="ls-from">${who(c.from)} shared${c.locked ? ` ${icon('lock')}` : ''}</small>
        <b class="ls-title">${esc(c.title)}</b>
        <small class="ls-facts">${facts.map(esc).join(' · ')}</small>
        <span class="ls-run"><span>${r ? 'Carries on with' : 'No agent here to carry it on'}</span>${r ? `<button type="button" class="runner-btn" data-a="runner" title="Pick another harness or model for it"></button>` : ''}</span>
        ${changed ? `<small class="ls-note">${icon('info')}${esc(c.run.note)}</small>` : ''}
        ${checks.length ? `<span class="ls-checks">${checks.join('')}</span>` : ''}
        ${c.imported ? `<small class="ls-note">${icon('info')}You imported it before: <button type="button" class="link" data-a="open">open it</button>, or import it again.</small>` : ''}
        <small class="ls-hint">Enter imports it. Anything else you type is its first follow-up.</small>
      </span>${x}</div>`;
    const btn = $('[data-a="runner"]', host);
    if (btn && r) paintRunnerBtn(btn, r.agent, r.model, r.effort);
  };

  const look = async () => {
    const n = ++seq;
    state = card ? state : 'loading';
    if (!card) paint();
    try {
      const c = await api('/shares/peek', { method: 'POST', body: { url: link, ...(passkey && { passkey }) } });
      if (n !== seq) return;
      card = c;
      state = c.open ? 'open' : 'locked';
    } catch (err) {
      if (n !== seq) return;
      (state = 'error'), (error = err.message);
    }
    paint();
    if (state === 'locked') $('[name="passkey"]', host)?.focus();
  };

  host.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'x') {
      dismissed = link;
      (state = 'off'), (card = null);
      paint();
      ta.focus();
    }
    if (a === 'open' && card?.imported) import('./feed.js').then((m) => m.setFocus(card.imported));
    if (a === 'runner') {
      const r = run || card.run;
      runnerPicker(e.target.closest('button'), { agent: r.agent, model: r.model, effort: r.effort, savedModel, savedEffort, places: [''], auto: false, back: ta }, (agent, model, effort) => {
        run = { agent, model, effort };
        paint();
      });
    }
  });
  host.addEventListener('change', (e) => {
    if (e.target.name in opts) opts[e.target.name] = e.target.checked;
  });
  host.addEventListener('submit', (e) => {
    e.preventDefault();
    passkey = $('[name="passkey"]', host).value;
    if (passkey) look();
  });

  // Reads the box as you type: a new link shows its card, a link taken out takes it away.
  const read = () => {
    const found = shareLinkIn(ta.value);
    if (found === link) return;
    link = found;
    (card = null), (passkey = ''), (run = null), (error = '');
    opts.connectors = opts.crew = true;
    if (!link || link === dismissed) return (state = 'off'), paint();
    look();
  };
  ta.addEventListener('input', read);
  read();

  return {
    active: () => state !== 'off',
    // The import's request body for what's typed, or null (the card says what's missing).
    take(text) {
      if (state === 'loading') return toast('Still reading the shared task…'), null;
      if (state === 'locked') return $('[name="passkey"]', host)?.focus(), null;
      if (state === 'error') return toast(esc(error), { tone: 'bad' }), null;
      if (!card?.run && !run) return toast('Install a coding agent first (Settings → Agents) to carry it on.', { tone: 'bad' }), null;
      const r = run || card.run;
      return { url: link, ...(passkey && { passkey }), prompt: withoutLink(text, link), agent: r.agent, model: r.model, effort: r.effort, connectors: opts.connectors, crew: opts.crew, title: card.title, from: card.from };
    },
    // After an import went (or came back refused): the card goes with the text, or stays.
    reset() {
      link = '';
      (card = null), (state = 'off');
      paint();
    },
  };
}

// What the import's notes say once it's in: harness or model swaps, connectors to check, crew.
export function importedToast(s, body) {
  const notes = s.notes || [];
  toast(`${icon('check')} Imported <b>${esc(body.title || s.title)}</b>${body.from ? ` from ${esc(body.from.name || body.from.handle)}` : ''}${notes.length ? `<br><small>${notes.map(esc).join('<br>')}</small>` : ''}`, { timeout: notes.length ? 9000 : 4200 });
}
