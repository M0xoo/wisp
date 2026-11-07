// Phone: questions and finished tasks over ntfy or Telegram, answered from there, and tasks started
// from a GitHub comment or in Slack.

import { copy } from '../blocks.js';
import { esc } from '../md.js';
import { api } from '../core/api.js';
import * as bus from '../core/bus.js';
import { $, $$, el, icon } from '../core/dom.js';
import { S, here } from '../core/state.js';
import { present } from '../ui/overlay.js';
import { toast, toastError, tryApi } from '../ui/toast.js';
import { placeName, recentFirst } from './places.js';

export const PHONE_HINT = 'ntfy, Telegram, GitHub or Slack: reach wisp from your phone';

export function phoneSummary(r) {
  if (!r) return '';
  const on = [r.ntfy.enabled && r.ntfy.topic && 'ntfy', r.telegram.enabled && r.telegram.linked && 'Telegram'].filter(Boolean);
  const all = [...on, r.github?.enabled && 'GitHub', r.slack?.enabled && 'Slack'].filter(Boolean).join(' + ');
  if (!on.length) return all || 'Off'; // the events are what ntfy and Telegram send; GitHub and Slack answer where they were asked
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

// What's wrong with the Slack channel, in words, and what to do. Slack's own code stays in the text:
// it's what its docs and a search go by.
function slackTrouble(error, box) {
  if (/^Slack’s signature/.test(error)) return `${esc(error)} Copy it again from Basic Information → App Credentials and paste it here.`;
  const code = /\b(invalid_auth|not_authed|account_inactive|token_revoked|token_expired|org_login_required|team_access_not_granted|link_disabled|missing_scope|no_permission|not_allowed_token_type)\b/.exec(error)?.[1];
  if (box && (code === 'missing_scope' || code === 'no_permission')) return `Slack says the app is missing a permission (<code>${code}</code>). The bot needs the manifest’s scopes: paste the manifest again under App Manifest, reinstall the app, then paste the bot token here.`;
  if (code === 'missing_scope' || code === 'no_permission') return `Slack says the app is missing a permission (<code>${code}</code>). The app token needs <code>connections:write</code>, and the bot the manifest’s scopes: paste the manifest again under App Manifest, reinstall the app, then paste both tokens here.`;
  if (box && code === 'not_allowed_token_type') return 'Slack got the wrong kind of token. The bot token starts with <code>xoxb-</code>, from OAuth &amp; Permissions.';
  if (code === 'not_allowed_token_type') return 'Slack got the wrong kind of token. The app token starts with <code>xapp-</code>, from Basic Information; the bot token with <code>xoxb-</code>, from OAuth &amp; Permissions.';
  if (box && code) return `Slack refused the bot token (<code>${code}</code>). Copy it again from <a href="https://api.slack.com/apps" target="_blank" rel="noopener">api.slack.com/apps</a> and paste it here. A reinstalled app has a new one.`;
  if (code) return `Slack refused a token (<code>${code}</code>). Copy both again from <a href="https://api.slack.com/apps" target="_blank" rel="noopener">api.slack.com/apps</a> and paste them here. A reinstalled app has new ones.`;
  return `${esc(error)} wisp keeps trying.`;
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
      <p class="mem-lede">Get questions and finished tasks on your phone, and answer from there. wisp reaches out to these services, so nothing needs to reach this machine. ntfy and Telegram receive titles, summaries and questions (with their context), never code or diffs.</p>
      <div class="ph-body"></div>
      <div class="ph-rest" hidden>
        <section class="ph-sec ph-chan ph-gh">
          <h4>GitHub <span class="muted xs"><span class="ph-dot">· </span>comment /wisp on an issue or PR</span><span class="ph-st"></span><button class="switch" data-sw="github" role="switch" aria-checked="false" aria-label="GitHub"></button></h4>
          <p class="hint ph-rules"></p>
          <div class="ph-on" hidden>
            <div class="ph-who"></div>
            <div class="ph-err" hidden></div>
            <p class="hint">Say what you’d type in wisp: <code>/wisp in api with opus plan: fix the flaky test</code></p>
            <div class="ph-start">
              <div class="ph-row"><span class="grow">Full reports on public repos</span><button class="switch" data-sw="ghPublic" role="switch" aria-checked="false" aria-label="Full reports on public repos"></button></div>
              <p class="hint">Off, a public repo gets one fixed line. Anyone can write in an issue there and steer the agent, and a report goes out under your name.</p>
            </div>
          </div>
        </section>
        <section class="ph-sec ph-chan ph-sk">
          <h4>Slack <span class="muted xs"><span class="ph-dot">· </span>mention wisp, or send the bot a DM</span><span class="ph-st"></span><button class="switch" data-sw="slack" role="switch" aria-checked="false" aria-label="Slack"></button></h4>
          <p class="hint ph-rules"></p>
          <div class="ph-err" hidden></div>
          <div class="ph-on" hidden>
            <div class="ph-who" hidden></div>
            <ol class="ph-steps">
              <li>
                <span class="ph-num" data-step="1"></span>
                <div class="ph-step">
                  <b>Create the app</b>
                  <p class="hint ph-create"></p>
                  <div class="ph-acts"><button class="primary sm" data-act="skManifest">${icon('copy')}Copy manifest</button><a class="ghost sm" href="https://api.slack.com/apps" target="_blank" rel="noopener">${icon('external')}api.slack.com/apps</a></div>
                </div>
              </li>
              <li>
                <span class="ph-num" data-step="2"></span>
                <div class="ph-step">
                  <b class="ph-paste"></b>
                  <div class="settings-modal">
                    <label class="ph-computer"><span>App token</span><input class="input mono" data-sk="appToken" placeholder="xapp-…" spellcheck="false" autocomplete="off" type="password"></label>
                    <label class="ph-cloud"><span>Signing secret</span><input class="input mono" data-sk="signingSecret" placeholder="From Slack" spellcheck="false" autocomplete="off" type="password"></label>
                    <label><span>Bot token</span><input class="input mono" data-sk="botToken" placeholder="xoxb-…" spellcheck="false" autocomplete="off" type="password"></label>
                  </div>
                  <p class="hint ph-where"></p>
                </div>
              </li>
              <li>
                <span class="ph-num" data-step="3"></span>
                <div class="ph-step">
                  <b>Link yourself</b>
                  <div class="ph-code"></div>
                </div>
              </li>
            </ol>
            <div class="ph-more" hidden></div>
          </div>
        </section>
        <div class="ship-foot"><span class="grow"></span><button class="ghost sm" data-act="test">${icon('send')}Send a test</button></div>
      </div>
    </div>`);
  const close = present(node, host);
  let r;
  let saving = 0; // GitHub and Slack saves on their way: what comes back meanwhile is older than the page
  let missed = false; // a remote event came during a save
  let changeTokens = false; // Slack: asked to see the steps again once it's all set up
  let noHub = ''; // a cloud computer Slack has no way to reach: the server's words
  const manifest = api('/remote/slack/manifest').catch((err) => {
    if (err.status === 409) noHub = err.message;
    return null;
  });
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
  const hold = (sec) => (sec.style.minHeight = `${sec.getBoundingClientRect().height}px`); // as .ph-body: never shrinks while open
  // In place, nodes kept: a switch slides, keeps its focus, and stays under the pointer.
  const paintGithub = () => {
    const g = r.github;
    const st = r.status.github;
    const sec = $('.ph-gh', node);
    hold(sec);
    $('[data-sw="github"]', node).setAttribute('aria-checked', g.enabled);
    $('[data-sw="ghPublic"]', node).setAttribute('aria-checked', g.publicReports);
    const error = g.enabled ? g.error || st?.error || '' : '';
    const n = g.repos.length;
    const repos = n ? `watching ${n} repo${n === 1 ? '' : 's'}` : 'no repos yet: add a project with its origin on GitHub';
    fill($('.ph-st', sec), !g.enabled ? '' : error ? `<span class="ph-bad">${icon('warn')}Not working</span>` : st ? status(st) : '<span class="ph-wait">Checking…</span>');
    fill($('.ph-rules', sec), `wisp reads comments through your <code>gh</code> sign-in, in the repos of your projects on ${esc(here)}. It runs only while ${esc(here)} is awake. Only your own comments count, and Full auto can’t be asked for from there.`);
    $('.ph-on', sec).hidden = !g.enabled;
    const who = $('.ph-who', sec);
    who.hidden = !g.login && !!error;
    who.title = g.repos.join('\n');
    fill(who, g.login ? `Signed in as <b>@${esc(g.login)}</b>, ${esc(repos)}` : 'Checking your <code>gh</code> sign-in…');
    const t = error ? ghTrouble(error) : null;
    trouble(sec, t?.html, t?.fix && `<button class="primary sm" data-act="ghFix">${t.fix}</button>`);
  };
  const trouble = (sec, html, button = '') => {
    const box = $('.ph-err', sec);
    box.hidden = !html;
    fill(box, html ? `<p class="hint">${icon('warn')}<span>${html}</span></p>${button}` : '');
  };
  const paintSlack = () => {
    const s = r.slack;
    const st = r.status.slack;
    const sec = $('.ph-sk', node);
    hold(sec);
    const sw = $('[data-sw="slack"]', node);
    sw.setAttribute('aria-checked', s.enabled && !noHub);
    sw.disabled = !!noHub;
    const on = s.enabled && !noHub;
    const key = s.box ? 'signingSecret' : 'appToken'; // on a cloud computer Slack calls in, so it's what proves it's Slack
    const tokens = !!(s[key] && s.botToken);
    const error = on && tokens ? s.error || st?.error || '' : '';
    fill($('.ph-st', sec), !on ? '' : !tokens ? '<span class="ph-wait">Not set up</span>' : error ? `<span class="ph-bad">${icon('warn')}Not working</span>` : s.connected ? status({ ok: true }) : '<span class="ph-wait">Checking…</span>');
    $('.ph-rules', sec).hidden = !!noHub;
    fill($('.ph-rules', sec), `${s.box ? `A message wakes ${esc(here)} when it’s asleep, and waits up to an hour for it.` : `It runs only while ${esc(here)} is awake, and Slack doesn’t keep messages for it: what’s sent meanwhile is gone.`} Only people you link count. In a channel, mention wisp in the thread to follow up. Full auto can’t be asked for from Slack.`);
    trouble(sec, noHub ? esc(noHub) : error ? slackTrouble(error, s.box) : '');
    $('.ph-on', sec).hidden = !on;
    const steps = !(s.connected && s.senders) || changeTokens;
    const n = s.senders;
    const who = $('.ph-who', sec);
    who.hidden = !s.connected;
    fill(who, `<span>Connected to <b>${esc(s.team || 'your workspace')}</b> as <b>${esc(s.bot || 'wisp')}</b>, ${n ? `${n} ${n === 1 ? 'person' : 'people'} linked` : 'nobody linked yet'}</span>${n ? '<button class="link xs" data-act="skUnlink">Unlink</button>' : ''}${n && !steps ? '<button class="link xs" data-act="skTokens">Change tokens</button>' : ''}`);
    $('.ph-steps', sec).hidden = !steps;
    fill($('.ph-create', sec), `Copy the manifest${s.box ? ': it holds this wisp’s private URL for Slack to call, so keep it to yourself' : ''}. At api.slack.com/apps pick <i>Create New App → From a manifest</i>, choose your workspace, paste it as JSON and install the app.`);
    fill($('.ph-paste', sec), s.box ? 'Paste the signing secret and bot token' : 'Paste the two tokens');
    $('.ph-computer', sec).hidden = s.box;
    $('.ph-cloud', sec).hidden = !s.box;
    fill($('.ph-where', sec), s.box ? 'Signing secret: Basic Information → App Credentials. Bot token: OAuth &amp; Permissions. If Slack says the URL isn’t verified, keep this open and retry it under Event Subscriptions.' : 'App token: Basic Information → App-Level Tokens → Generate, with the <code>connections:write</code> scope. Bot token: OAuth &amp; Permissions.');
    const done = [!!(s[key] || s.botToken), tokens, n > 0];
    for (const [i, ok] of done.entries()) {
      const num = $(`[data-step="${i + 1}"]`, sec);
      num.classList.toggle('ok', ok);
      fill(num, ok ? icon('check') : String(i + 1));
    }
    for (const k of [key, 'botToken']) {
      const input = $(`[data-sk="${k}"]`, sec);
      if (input !== document.activeElement && input.value !== s[k]) input.value = s[k]; // never under someone's typing
    }
    const code = (lead) => `<p class="hint">${lead} <code>link ${esc(s.linkCode)}</code> <button class="ghost xs" data-act="skCode">${icon('copy')}Copy</button></p>`;
    fill($('.ph-code', sec), s.linkCode ? `${code('In a DM to the bot, send')}<p class="hint">Each code links one person, and the next shows here.</p>` : '<p class="hint">Your code shows here once the bot token is in.</p>');
    const more = $('.ph-more', sec);
    more.hidden = steps;
    fill(more, !steps && s.linkCode ? code('To link someone else, they send the bot') : '');
  };
  const paintChannels = () => {
    paintGithub();
    paintSlack();
  };
  // A change while a save is on its way can be newer than what the save answers: looked at after it.
  const refresh = async () => {
    missed = !!saving;
    if (saving) return;
    const next = await api('/remote').catch(() => r);
    if (saving) missed = true;
    if (saving || !next || !node.isConnected) return;
    r = next;
    // GitHub and Slack paint in place, so a status can show while a token is being typed; .ph-body can't
    if (node.contains(document.activeElement) && document.activeElement.matches('.ph-body input')) paintChannels();
    else paint();
  };
  // Saves a channel's change, shown already: undo() puts it back if the server refuses.
  const saveChannel = async (body, undo) => {
    paintChannels();
    saving++;
    const next = await tryApi(() => api('/remote', { method: 'PUT', body }));
    saving--;
    if (!next) undo();
    else if (!saving) r = next;
    paintChannels();
    if (missed) refresh();
    return !!next;
  };
  const flip = (channel, key) => {
    const was = r[channel][key];
    r[channel][key] = !was;
    if (channel === 'slack') r.slack.connected = false; // a new connection: Working again once it says so
    return saveChannel({ [channel]: { [key]: !was } }, () => (r[channel][key] = was));
  };
  // A token arrives whole, so a paste saves at once; on change for one typed by hand.
  const saveToken = async (input) => {
    const k = input.dataset.sk;
    const v = input.value.trim();
    const was = r.slack[k];
    if (v === was) return;
    r.slack[k] = v ? '••••' : '';
    const ok = await saveChannel({ slack: { [k]: v } }, () => (r.slack[k] = was));
    input.value = r.slack[k];
    if (ok) changeTokens = false;
    if (ok) paintSlack();
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
    paintChannels();
    $('.ph-rest', node).hidden = false;
    if (held) $(`[data-sw="${held}"]`, node)?.focus({ preventScroll: true });
  };
  node.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.ev) put({ events: $$('[data-ev]', node).filter((x) => x.checked).map((x) => x.dataset.ev) });
    if (t.dataset.ntfy) put({ ntfy: { ...r.ntfy, [t.dataset.ntfy]: t.value.trim() } });
    if (t.dataset.tg === 'token') put({ telegram: { enabled: r.telegram.enabled, token: t.value.trim() } });
    if (t.dataset.tg === 'project') put({ telegram: { project: t.value } });
    if (t.dataset.sk) saveToken(t);
  });
  node.addEventListener('paste', (e) => {
    if (e.target.dataset?.sk) setTimeout(() => saveToken(e.target)); // once the text is in the box
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
    if (sw === 'github') return flip('github', 'enabled');
    if (sw === 'ghPublic') return flip('github', 'publicReports');
    if (sw === 'slack') return flip('slack', 'enabled');
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'unlink') return put({ telegram: { enabled: r.telegram.enabled, token: r.telegram.token, unlink: true } });
    if (act === 'ghFix') {
      close();
      return openToolsRow();
    }
    if (act === 'skManifest') {
      const m = await manifest;
      if (!m) return toastError(new Error('Couldn’t load the manifest. Check the connection and try again.'));
      await copy(JSON.stringify(m, null, 2));
      return toast('Manifest copied');
    }
    if (act === 'skCode') {
      await copy(`link ${r.slack.linkCode}`);
      return toast('Copied');
    }
    if (act === 'skTokens') {
      changeTokens = true;
      return paintSlack();
    }
    if (act === 'skUnlink') {
      const was = r.slack.senders;
      r.slack.senders = 0;
      changeTokens = false;
      return saveChannel({ slack: { unlink: true } }, () => (r.slack.senders = was));
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
  bus.on('remote', refresh, { node });
  r = await api('/remote').catch((err) => (toastError(err), null));
  if (r?.slack.box) await manifest; // what it says decides the section: painted once, not twice
  if (r) paint();
}
