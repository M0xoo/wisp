// Phone: questions and finished tasks over ntfy or Telegram, answered from there, and tasks started
// from a GitHub comment.

import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S, here } from '../core/state.js';
import { present } from '../ui/overlay.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { placeName, recentFirst } from './places.js';

export const PHONE_HINT = 'ntfy, Telegram or GitHub: reach wisp from your phone';

export function phoneSummary(r) {
  if (!r) return '';
  const on = [r.ntfy.enabled && r.ntfy.topic && 'ntfy', r.telegram.enabled && r.telegram.linked && 'Telegram'].filter(Boolean);
  const all = [...on, r.github?.enabled && 'GitHub'].filter(Boolean).join(' + ');
  if (!on.length) return all || 'Off'; // the events are what ntfy and Telegram send; GitHub answers where it was asked
  return `${all} · ${r.events.map((e) => (e === 'waiting' ? 'questions' : 'finished')).join(' & ')}`;
}

// What's wrong with the GitHub channel, in words, and what to do. → { html, fix }: fix is the button.
function ghTrouble(error) {
  if (/spawn\b.*ENOENT/.test(error)) return { html: `wisp can’t find <code>gh</code> on ${esc(here)}. Install it and sign in, and wisp picks it up within a minute.`, fix: 'Install the GitHub CLI' };
  if (/auth login|logged in|HTTP 401|bad credentials/i.test(error)) return { html: `<code>gh</code> isn’t signed in, so wisp can’t tell which comments are yours. Sign in, and wisp picks it up within a minute.`, fix: 'Sign in to GitHub' };
  const repo = /^([\w.-]+\/[\w.-]+): /.exec(error)?.[1];
  if (repo && /HTTP 404/.test(error)) return { html: `wisp can’t read <b>${esc(repo)}</b>. Check the project’s origin, and that your <code>gh</code> account can see the repo.` };
  return { html: `${esc(error)}${/Looking again/.test(error) ? '' : ' wisp tries again every minute.'}` };
}

// Settings → Agents, at its git / GitHub row (as tips.js does).
function openToolsRow() {
  import('./settings.js').then((m) => {
    m.openSettings({ pane: 'agents' });
    $('.sx .sx-tool')?.scrollIntoView({ block: 'center' });
  });
}

export async function openPhone({ host } = {}) {
  const node = el(`<div class="modal phone-modal">
      <header><h2>Phone</h2><button class="icon-btn close" title="Close" aria-label="Close">${icon('x')}</button></header>
      <p class="mem-lede">Get questions and finished tasks on your phone, and answer from there. wisp polls these services, so nothing needs to reach this machine. ntfy and Telegram receive titles, summaries and questions (with their context), never code or diffs.</p>
      <div class="ph-body"></div>
      <div class="ph-rest" hidden>
        <section class="ph-sec ph-gh">
          <h4>GitHub <span class="muted xs"><span class="ph-dot">· </span>comment /wisp on an issue or PR</span><span class="ph-gh-st"></span><button class="switch" data-sw="github" role="switch" aria-checked="false" aria-label="GitHub"></button></h4>
          <p class="hint ph-gh-rules"></p>
          <div class="ph-gh-on" hidden>
            <div class="ph-gh-who"></div>
            <div class="ph-gh-err" hidden></div>
            <p class="hint">Say what you’d type in wisp: <code>/wisp in api with opus plan: fix the flaky test</code></p>
            <div class="ph-start">
              <div class="ph-row"><span class="grow">Full reports on public repos</span><button class="switch" data-sw="ghPublic" role="switch" aria-checked="false" aria-label="Full reports on public repos"></button></div>
              <p class="hint">Off, a public repo gets one fixed line. Anyone can write in an issue there and steer the agent, and a report goes out under your name.</p>
            </div>
          </div>
        </section>
        <div class="ship-foot"><span class="grow"></span><button class="ghost sm" data-act="test">${icon('send')}Send a test</button></div>
      </div>
    </div>`);
  const close = present(node, host);
  let r;
  let saving = 0; // GitHub switches on their way: what comes back meanwhile is older than the page
  const shown = new WeakMap();
  const fill = (box, html) => {
    if (shown.get(box) === html) return; // a refresh that changes nothing leaves the nodes alone
    shown.set(box, html);
    box.innerHTML = html;
  };
  const put = async (patch) => {
    try {
      r = await api('/remote', { method: 'PUT', body: patch });
      paint();
    } catch (err) {
      toastError(err);
    }
  };
  const status = (st) => (!st ? '' : st.ok ? `<span class="ph-ok">${icon('check')}Working</span>` : `<span class="ph-bad">${icon('warn')}${esc(st.error || 'Failed')}</span>`);
  // In place, nodes kept: a switch slides, keeps its focus, and stays under the pointer.
  const paintGithub = () => {
    const g = r.github;
    const st = r.status.github;
    const sec = $('.ph-gh', node);
    sec.style.minHeight = `${sec.getBoundingClientRect().height}px`; // as .ph-body: never shrinks while open
    $('[data-sw="github"]', node).setAttribute('aria-checked', g.enabled);
    $('[data-sw="ghPublic"]', node).setAttribute('aria-checked', g.publicReports);
    const error = g.enabled ? g.error || st?.error || '' : '';
    const n = g.repos.length;
    const repos = n ? `watching ${n} repo${n === 1 ? '' : 's'}` : 'no repos yet: add a project with its origin on GitHub';
    fill($('.ph-gh-st', node), !g.enabled ? '' : error ? `<span class="ph-bad">${icon('warn')}Not working</span>` : st ? status(st) : '<span class="ph-wait">Checking…</span>');
    fill($('.ph-gh-rules', node), `wisp reads comments through your <code>gh</code> sign-in, in the repos of your projects on ${esc(here)}. It runs only while ${esc(here)} is awake. Only your own comments count, and Full auto can’t be asked for from there.`);
    $('.ph-gh-on', node).hidden = !g.enabled;
    const who = $('.ph-gh-who', node);
    who.hidden = !g.login && !!error;
    who.title = g.repos.join('\n');
    fill(who, g.login ? `Signed in as <b>@${esc(g.login)}</b>, ${esc(repos)}` : 'Checking your <code>gh</code> sign-in…');
    const box = $('.ph-gh-err', node);
    box.hidden = !error;
    const t = error ? ghTrouble(error) : null;
    fill(box, t ? `<p class="hint">${icon('warn')}<span>${t.html}</span></p>${t.fix ? `<button class="primary sm" data-act="ghFix">${t.fix}</button>` : ''}` : '');
  };
  const flipGithub = async (key) => {
    const was = r.github[key];
    r.github[key] = !was;
    paintGithub();
    saving++;
    const next = await tryApi(() => api('/remote', { method: 'PUT', body: { github: { [key]: !was } } }));
    saving--;
    if (!next) r.github[key] = was;
    else if (!saving) r = next;
    paintGithub();
  };
  const paint = () => {
    const tg = r.telegram;
    const projects = S.config.projects || [];
    const lastUsed = [...projects].sort(recentFirst)[0];
    const held = node.contains(document.activeElement) ? document.activeElement.dataset.sw : ''; // the repaint replaces it
    const body = $('.ph-body', node);
    body.style.minHeight = `${body.getBoundingClientRect().height}px`; // it never shrinks while open: a switch stays under the pointer, and a scrolled dialog stays scrolled
    fill(body, `
      <div class="settings-modal ph-sec">
        <div class="setting"><span>Send me</span>
          <label class="check"><input type="checkbox" data-ev="waiting" ${r.events.includes('waiting') ? 'checked' : ''}> Questions</label>
          <label class="check"><input type="checkbox" data-ev="finished" ${r.events.includes('finished') ? 'checked' : ''}> Finished tasks</label></div>
      </div>
      <section class="ph-sec">
        <h4>ntfy <span class="muted xs">· tap a button on the notification to answer</span>${status(r.status.ntfy)}<button class="switch" data-sw="ntfy" role="switch" aria-checked="${r.ntfy.enabled}" aria-label="ntfy"></button></h4>
        <div class="settings-modal">
          <label><span>Topic</span><input class="input mono" data-ntfy="topic" value="${esc(r.ntfy.topic)}" placeholder="wisp-…" spellcheck="false"></label>
          <label><span>Server</span><input class="input mono" data-ntfy="server" value="${esc(r.ntfy.server)}" spellcheck="false"></label>
          <label><span>Access token</span><input class="input mono" data-ntfy="token" value="${esc(r.ntfy.token)}" placeholder="Only for protected topics" spellcheck="false" type="password"></label>
        </div>
        <p class="hint">Install the ntfy app and subscribe to the topic. Anyone who knows the topic name can read it, so keep it long and random; answers are signed, so nobody else can send them.</p>
      </section>
      <section class="ph-sec">
        <h4>Telegram <span class="muted xs">· buttons, or reply to a message in your own words</span>${status(r.status.telegram)}<button class="switch" data-sw="telegram" role="switch" aria-checked="${tg.enabled}" aria-label="Telegram"></button></h4>
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
          <div class="ph-row"><span class="grow">Start tasks from Telegram</span><button class="switch" data-sw="tgStart" role="switch" aria-checked="${tg.allowStart}" aria-label="Start tasks from Telegram"></button></div>
          ${
            tg.allowStart
              ? `<div class="ph-options">
            <div class="ph-row"><span class="grow">Say what you’d type in wisp</span><button class="switch" data-sw="tgOptions" role="switch" aria-checked="${tg.options}" aria-label="Say what you’d type in wisp"></button></div>
            <p class="hint">Plain messages start tasks, and you pick crew, project, machine, model and mode right in them: <code>@ada in api with opus plan: fix the login test</code>. A group chat stops at Edits. Off, tasks start with <code>/new</code> as before.</p>
          </div>
          <div class="settings-modal"><label><span>Default project</span><select class="input" data-tg="project">
              <option value="">Last used${lastUsed ? ` (${esc(lastUsed.name)})` : ''}</option>
              ${projects.map((p) => `<option value="${esc(p.id)}" ${p.id === tg.project ? 'selected' : ''}>${esc(p.name)}${p.machine ? ` · ${esc(placeName(p.machine))}` : ''}</option>`).join('')}
            </select></label></div>
          <div class="ph-how">
            <p class="hint ${tg.options ? 'ph-off' : ''}">Send <code>/new fix the flaky login test</code> to start a task in the default project, or <code>/new @${esc(projects[0]?.name || 'project')} …</code> to pick one; <code>/projects</code> lists them. Tasks use the launcher's harness, model and mode. Only your linked chat can start them.</p>
            <p class="hint ${tg.options ? '' : 'ph-off'}">Anything you leave out comes from the launcher, and the task runs in the default project. Send <code>help</code> to see what you can say, or start with <code>:</code> to send a message as written. Only your linked chat can start them.</p>
          </div>`
              : '<p class="hint">Off: the bot only answers and follows up on tasks you started here.</p>'
          }
        </div>`
            : ''
        }
      </section>`);
    paintGithub();
    $('.ph-rest', node).hidden = false;
    if (held) $(`[data-sw="${held}"]`, node)?.focus({ preventScroll: true });
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
    if (sw === 'tgOptions') return put({ telegram: { options: !r.telegram.options } });
    if (sw === 'github') return flipGithub('enabled');
    if (sw === 'ghPublic') return flipGithub('publicReports');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'unlink') return put({ telegram: { enabled: r.telegram.enabled, token: r.telegram.token, unlink: true } });
    if (act === 'ghFix') {
      close();
      return openToolsRow();
    }
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
      if (saving || (node.contains(document.activeElement) && document.activeElement.matches('input'))) return; // don't clobber typing
      const next = await api('/remote').catch(() => r);
      if (saving || !next || !node.isConnected) return;
      r = next;
      paint();
    },
    { node },
  );
  r = await api('/remote').catch((err) => (toastError(err), null));
  if (r) paint();
}
