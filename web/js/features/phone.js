// Phone: questions and finished tasks over ntfy or Telegram, answered from there.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S } from '../core/state.js';
import { present } from '../ui/overlay.js';
import { toast, toastError } from '../ui/toast.js';
import { placeName, recentFirst } from './places.js';

export function phoneSummary(r) {
  if (!r) return '';
  const on = [r.ntfy.enabled && r.ntfy.topic && 'ntfy', r.telegram.enabled && r.telegram.linked && 'Telegram'].filter(Boolean);
  return on.length ? `${on.join(' + ')} · ${r.events.map((e) => (e === 'waiting' ? 'questions' : 'finished')).join(' & ')}` : 'Off';
}

export async function openPhone({ host } = {}) {
  const node = el(`<div class="modal phone-modal">
      <header><h2>Phone</h2><button class="icon-btn close">${icon('x')}</button></header>
      <p class="mem-lede">Get questions and finished tasks on your phone, and answer from there. wisp polls both services, so nothing needs to reach this machine. They receive titles, summaries and questions (with their context), never code or diffs.</p>
      <div class="ph-body"></div>
    </div>`);
  const close = present(node, host);
  let r;
  const put = async (patch) => {
    try {
      r = await api('/remote', { method: 'PUT', body: patch });
      paint();
    } catch (err) {
      toastError(err);
    }
  };
  const status = (st) => (!st ? '' : st.ok ? `<span class="ph-ok">${icon('check')}Working</span>` : `<span class="ph-bad">${icon('warn')}${esc(st.error || 'Failed')}</span>`);
  const paint = () => {
    const tg = r.telegram;
    const projects = S.config.projects || [];
    const lastUsed = [...projects].sort(recentFirst)[0];
    $('.ph-body', node).innerHTML = `
      <div class="settings-modal ph-sec">
        <div class="setting"><span>Send me</span>
          <label class="check"><input type="checkbox" data-ev="waiting" ${r.events.includes('waiting') ? 'checked' : ''}> Questions</label>
          <label class="check"><input type="checkbox" data-ev="finished" ${r.events.includes('finished') ? 'checked' : ''}> Finished tasks</label></div>
      </div>
      <section class="ph-sec">
        <h4>ntfy <span class="muted xs">· tap a button on the notification to answer</span>${status(r.status.ntfy)}<button class="switch" data-sw="ntfy" role="switch" aria-checked="${r.ntfy.enabled}"></button></h4>
        <div class="settings-modal">
          <label><span>Topic</span><input class="input mono" data-ntfy="topic" value="${esc(r.ntfy.topic)}" placeholder="wisp-…" spellcheck="false"></label>
          <label><span>Server</span><input class="input mono" data-ntfy="server" value="${esc(r.ntfy.server)}" spellcheck="false"></label>
          <label><span>Access token</span><input class="input mono" data-ntfy="token" value="${esc(r.ntfy.token)}" placeholder="Only for protected topics" spellcheck="false" type="password"></label>
        </div>
        <p class="hint">Install the ntfy app and subscribe to the topic. Anyone who knows the topic name can read it, so keep it long and random; answers are signed, so nobody else can send them.</p>
      </section>
      <section class="ph-sec">
        <h4>Telegram <span class="muted xs">· buttons, or reply to a message in your own words</span>${status(r.status.telegram)}<button class="switch" data-sw="telegram" role="switch" aria-checked="${tg.enabled}"></button></h4>
        <div class="settings-modal">
          <label><span>Bot token</span><input class="input mono" data-tg="token" value="${esc(tg.token)}" placeholder="123456:ABC… from @BotFather" spellcheck="false" type="password"></label>
        </div>
        <p class="hint">${
          tg.linked
            ? `${icon('check')} Linked to <b>${esc(tg.chatName || 'your chat')}</b>. <button class="link xs" data-act="unlink">Unlink</button>`
            : tg.token && tg.enabled
              ? `Now send <code>/link ${esc(tg.linkCode)}</code> to your bot. Only the chat that sends this code gets linked.`
              : 'Create a bot with @BotFather, paste its token here and switch Telegram on.'
        }</p>
        ${
          tg.linked
            ? `<div class="ph-start">
          <div class="ph-row"><span class="grow">Start tasks from Telegram</span><button class="switch" data-sw="tgStart" role="switch" aria-checked="${tg.allowStart}"></button></div>
          ${
            tg.allowStart
              ? `<div class="settings-modal"><label><span>Default project</span><select class="input" data-tg="project">
              <option value="">Last used${lastUsed ? ` (${esc(lastUsed.name)})` : ''}</option>
              ${projects.map((p) => `<option value="${esc(p.id)}" ${p.id === tg.project ? 'selected' : ''}>${esc(p.name)}${p.machine ? ` · ${esc(placeName(p.machine))}` : ''}</option>`).join('')}
            </select></label></div>
          <p class="hint">Send <code>/new fix the flaky login test</code> to start a task in the default project, or <code>/new @${esc(projects[0]?.name || 'project')} …</code> to pick one; <code>/projects</code> lists them. Tasks use the launcher's harness, model and mode. Only your linked chat can start them.</p>`
              : '<p class="hint">Off: the bot only answers and follows up on tasks you started here.</p>'
          }
        </div>`
            : ''
        }
      </section>
      <div class="ship-foot"><span class="grow"></span><button class="ghost sm" data-act="test">${icon('send')}Send a test</button></div>`;
  };
  node.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.ev) put({ events: $$('[data-ev]', node).filter((x) => x.checked).map((x) => x.dataset.ev) });
    if (t.dataset.ntfy) put({ ntfy: { ...r.ntfy, [t.dataset.ntfy]: t.value.trim() } });
    if (t.dataset.tg === 'token') put({ telegram: { enabled: r.telegram.enabled, token: t.value.trim() } });
    if (t.dataset.tg === 'project') put({ telegram: { project: t.value } });
  });
  node.addEventListener('click', async (e) => {
    const sw = e.target.closest('[data-sw]')?.dataset.sw;
    if (sw === 'ntfy') {
      // A fresh random topic the first time, so it isn't guessable.
      const topic = r.ntfy.topic || `wisp-${crypto.getRandomValues(new Uint32Array(2)).join('').slice(0, 14)}`;
      return put({ ntfy: { ...r.ntfy, enabled: !r.ntfy.enabled, topic } });
    }
    if (sw === 'telegram') return put({ telegram: { enabled: !r.telegram.enabled, token: r.telegram.token } });
    if (sw === 'tgStart') return put({ telegram: { allowStart: !r.telegram.allowStart } });
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'unlink') return put({ telegram: { enabled: r.telegram.enabled, token: r.telegram.token, unlink: true } });
    if (act === 'test') {
      try {
        r = await api('/remote/test', { method: 'POST', body: {} });
        paint();
        toast('Test sent');
      } catch (err) {
        toastError(err);
      }
    }
  });
  bus.on(
    'remote',
    async () => {
      if (node.contains(document.activeElement) && document.activeElement.matches('input')) return; // don't clobber typing
      r = await api('/remote').catch(() => r);
      if (r && node.isConnected) paint();
    },
    { node },
  );
  r = await api('/remote').catch((err) => (toastError(err), null));
  if (r) paint();
}
