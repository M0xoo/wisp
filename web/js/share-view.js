// A shared task on wisp Grid (grid/shares.js → <grid>/s/<id>): the task page as wisp shows it,
// read-only. The same stylesheets and the same block renderer (blocks.js) as the app, so a report
// looks the way it did for whoever shared it. Each delegated run opens as a page of its own
// (/s/<id>/r/<run>), with the way back to the turn that sent it. The grid embeds what to show
// (#shareData); nothing here talks to a wisp.

import { esc, inlineMd, md } from './md.js';
import { el, icon, registerBlock, renderPresentation } from './blocks.js';
import { previewBlock } from './preview-frame.js';
import { isLoopback, shortUrl } from './preview-spec.js';
import { DAY_TIME, fmtDate, fmtSize, STATUS_LABEL } from './core/format.js';
import { toast } from './ui/toast.js';
import { viewImage } from './ui/viewer.js';
import { closeOverlay } from './ui/overlay.js';

const data = JSON.parse(document.getElementById('shareData').textContent);
const { share, task, run, base } = data;
const r = run ? task.runs?.[run] : null;

const LOGO = { claude: 'claudecode-color', codex: 'codex-color', opencode: 'opencode', cursor: 'cursor', antigravity: 'antigravity-color', grok: 'grok', copilot: 'githubcopilot' };
const MONO = new Set(['opencode', 'cursor', 'grok', 'copilot']);
const NAME = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', cursor: 'Cursor', antigravity: 'Antigravity', grok: 'Grok', copilot: 'Copilot', auto: 'Auto' };
const agentName = (a) => NAME[a] || a || 'An agent';
const logo = (a) => (!LOGO[a] ? icon('spark') : MONO.has(a) ? `<i class="mono" style="--logo:url(/logos/${LOGO[a]}.svg)"></i>` : `<img src="/logos/${LOGO[a]}.svg" alt="">`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const heroOf = (t) => (t?.presentation?.blocks || []).find((b) => b?.type === 'hero');
const statusOf = (t) => (t?.status === 'error' ? 'blocked' : t?.status === 'stopped' ? 'partial' : heroOf(t)?.status || 'done');

// Buttons in a report (Next, actions) act on the task in wisp: here a toast, wisp's own, says how
// to get it there, with the link to copy.
const hint = () => toast('Import the task into wisp to carry it on: copy the link and paste it in New task.', { action: { label: 'Copy link', run: copyLink } });
// Its pictures and videos came with it (share.js packAttached → media/<n>.<ext>); the grid serves
// them beside the page. One that didn't come has nothing to load: it shows as missing.
const fileUrl = (p) => (/^media\/[\w.-]+$/.test(p || '') ? `${base.replace(/\/r\/[^/]*$/, '')}/m/${encodeURIComponent(p.slice(6))}` : 'data:,');
const ctxFor = (t) => ({ session: { id: `share-${share.id}`, turns: [] }, turn: t, isLatest: false, reply: hint, draft: hint, fileUrl, zoom: viewImage, stuffBlock });

// Something they saved in My Stuff: its card as it was shared (b.item). A published app opens at
// its public link; the rest comes into the importer's My Stuff with the task.
const KIND = { app: ['App', 'app'], image: ['Picture', 'image'], video: ['Video', 'play'], doc: ['Doc', 'file'], code: ['Code', 'terminal'], file: ['File', 'clip'], link: ['Link', 'web'] };
function stuffBlock(b) {
  const it = b.item && typeof b.item === 'object' ? b.item : null;
  const [one, ic] = KIND[it?.kind || b.kind] || KIND.file;
  const title = it?.title || b.title || 'Something in My Stuff';
  const meta = it ? [one, it.files ? plural(it.files, 'file') : '', it.size ? fmtSize(it.size) : ''].filter(Boolean) : ['In their My Stuff'];
  const pic = it?.cover ? `<img src="${esc(fileUrl(it.cover))}" alt="" loading="lazy">` : it?.kind === 'app' ? `<b class="sb-initial">${esc(title.trim()[0]?.toUpperCase() || '?')}</b>` : icon(ic);
  const go = it?.published ? `<a class="sb-go primary sm" href="${esc(it.published)}" target="_blank" rel="noopener">${icon('external')}<span>Open</span></a>` : it?.kind === 'link' && it.url ? `<a class="sb-go ghost sm" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${icon('external')}<span>Open</span></a>` : it?.kind === 'app' ? `<button class="sb-go ghost sm" type="button">${icon('play')}<span>Run in wisp</span></button>` : '';
  const node = el(`<div class="b-stuff card${it ? '' : ' missing'}${it?.kind === 'app' ? ' k-app' : ''}">
    <span class="sb-pic k-${esc(it?.kind || 'file')}">${pic}${it?.kind === 'app' ? '<span class="sb-bar"><i></i><i></i><i></i></span>' : ''}</span>
    <span class="sb-main"><b>${esc(title)}</b><span class="sb-meta">${icon(ic)}${meta.map((m) => `<i>${esc(m)}</i>`).join('')}</span>${b.note || it?.excerpt ? `<span class="sb-note">${esc(b.note || it.excerpt)}</span>` : ''}</span>
    ${go}</div>`);
  node.querySelector('button.sb-go')?.addEventListener('click', () => toast(`Import the task into wisp to run ${title}: it comes into your My Stuff with it.`, { action: { label: 'Copy link', run: copyLink } }));
  return node;
}

// A page the agent pointed at on its own computer (localhost) can't load here: what it was, and
// how to run it. A public page shows live, as in wisp.
registerBlock('preview', (b, ctx) => {
  if (!isLoopback(String(b.url || ''))) return previewBlock(b, ctx);
  return el(`<figure class="b-preview card sv-pv-off">
    <div class="pv-head"><span class="pv-addr" title="${esc(b.url)}">${icon('web')}<span class="pv-host">${esc(shortUrl(String(b.url)))}</span></span></div>
    <div class="sv-pv-body">${icon('web')}<span>It ran on ${esc(share.from?.name || 'their')}${share.from?.name ? '’s' : ''} computer while the agent worked. Import the task to run it in your wisp.</span></div>
    ${b.title || b.caption ? `<figcaption class="pv-foot"><span class="pv-cap">${b.title ? `<b>${esc(b.title)}</b>` : ''}${b.caption ? `<span>${inlineMd(b.caption)}</span>` : ''}</span></figcaption>` : ''}
  </figure>`);
});

// A turn's delegated runs: the lead's "N delegated tasks" cards, each opening its run's page.
function subsHtml(t) {
  const list = (t.delegations || []).map((d) => ({ d, run: task.runs?.[d.run], ct: task.runs?.[d.run]?.turns?.[d.turn || 0] }));
  if (!list.length) return '';
  return `<section class="subs">
    <div class="subs-head"><b>${plural(list.length, 'delegated task')}</b><span class="subs-to">${esc([...new Set(list.map(({ d }) => `@${d.name}`))].join(', '))}</span></div>
    <div class="subs-list">${list
      .map(({ d, run: rr, ct }) => {
        const st = statusOf(ct);
        const files = ct?.changes?.length || 0;
        const head = `<span class="sub-logo${d.crew ? ' crew' : ''}">${d.crew ? `<span class="sv-face">${esc((d.member || d.name || '?')[0].toUpperCase())}</span>` : logo(d.agent)}</span>
          <span class="sub-main"><span class="sub-top"><b>@${esc(d.name)}</b><span class="sub-model">${d.crew ? 'Crew member · ' : ''}${esc(agentName(d.agent))}${d.model ? ` · ${esc(d.model)}` : ''}</span></span>
          <span class="sub-title">${esc(heroOf(ct)?.title || d.prompt)}</span></span>
          <span class="sub-side">${files ? `<span class="sub-files">${plural(files, 'file')}</span>` : ''}${ct?.endedAt && ct.startedAt ? `<span class="sub-dur">${Math.max(1, Math.round((ct.endedAt - ct.startedAt) / 1000))}s</span>` : ''}<span class="pill st-${st}"><i></i>${STATUS_LABEL[st] || 'Finished'}</span>${rr ? icon('arrow') : ''}</span>`;
        return `<article class="sub st-${st}">${rr ? `<a class="sub-head" href="${esc(base)}/r/${encodeURIComponent(d.run)}${d.turn ? `#t${d.turn + 1}` : ''}">${head}</a>` : `<div class="sub-head">${head}</div>`}</article>`;
      })
      .join('')}</div></section>`;
}

function turnNode(t, i, lead) {
  const node = el(`<article class="turn${t.rolledBackAt ? ' is-rolled-back' : ''}" id="t${i + 1}"></article>`);
  const agent = t.agent || lead.agent;
  node.append(
    el(`<div class="ask">
      <div class="ask-text">${esc(t.prompt)}</div>
      <div class="ask-foot">
        <span class="model-logo" role="img" title="${esc(`${agentName(agent)} · ${t.model || 'Default model'}`)}">${logo(agent)}</span>
        <span class="sv-model">${esc(agentName(agent))}${t.model ? ` · ${esc(t.model)}` : ''}</span>
        ${t.startedAt ? `<time>${fmtDate(t.startedAt, DAY_TIME)}</time>` : ''}
        ${t.status === 'stopped' ? '<span class="rev-tag">Stopped</span>' : t.status === 'error' ? '<span class="rev-tag">Failed</span>' : ''}
        ${t.rolledBackAt ? '<span class="rev-tag">Rolled back</span>' : ''}
      </div>
    </div>`),
  );
  // As in wisp: the report, then the team's delegated tasks under it.
  if (t.presentation?.blocks?.length) node.append(renderPresentation(t.presentation, ctxFor(t)));
  else if (t.raw) node.append(el(`<div class="presentation"><div class="blk blk-markdown"><div class="prose">${md(t.raw)}</div></div></div>`));
  const subs = subsHtml(t);
  if (subs) node.append(el(subs));
  const files = (t.changes || []).filter((c) => c?.file && !c.reverted);
  if (files.length) node.append(el(`<div class="sv-files">${icon('file')}<span>Edited ${files.slice(0, 12).map((c) => `<code>${esc(c.file)}</code>`).join(', ')}${files.length > 12 ? ` and ${files.length - 12} more` : ''}</span></div>`));
  return node;
}

function render() {
  const lead = r || task;
  const turns = (r ? r.turns : task.turns) || [];
  const last = turns.at(-1);
  const st = statusOf(last);
  const from = share.from || {};
  const backAt = r ? (task.turns || []).findIndex((t) => (t.delegations || []).some((d) => d.run === run)) : -1;
  const title = r ? `@${r.name}` : share.title;
  document.title = `${r ? `@${r.name} · ` : ''}${share.title} · shared on wisp`;

  // The head, as the open task's: its status dot and title; Copy link where its actions are.
  document.getElementById('svHead').innerHTML = `<div class="sh-row">${r ? `<a class="icon-btn sv-back" href="${esc(base)}${backAt >= 0 ? `#t${backAt + 1}` : ''}" title="Back to “${esc(share.title)}”" aria-label="Back">${icon('back')}</a>` : ''}<span class="q-dot st-${st}"></span><h2 class="sh-title">${esc(title)}</h2><span class="sh-acts"><button class="primary sm sv-copy" type="button">${icon('copy')}<span>Copy link</span></button></span></div>`;

  // What an import brings, as a list a person reads: "Its history, work, pictures and model".
  const carried = () => {
    const at = task.attached || {};
    const all = ['history', share.work && 'work', team.length && 'delegates', share.crew?.length && 'crew', 'model', at.media && 'pictures', at.stuff && 'what it saved in My Stuff', share.connectors?.length && 'connectors', share.skills?.length && 'skills'].filter(Boolean);
    return `Its ${all.slice(0, -1).join(', ')} and ${all.at(-1)}`;
  };
  // The details column: what ran it, its work, team and what comes with an import.
  const team = (task.subagents || []).filter(Boolean);
  const meta = [
    `<span class="m sv-run">${logo(lead.agent)}<span>${esc(agentName(lead.agent))}${lead.model ? ` · ${esc(lead.model)}` : ''}</span></span>`,
    !r && share.work?.branch ? `<span class="m branch">${icon('branch')}<span>${esc(share.work.branch)}</span></span>` : '',
    !r && share.work?.repo ? `<span class="m">${icon('github')}<span>${esc(share.work.repo.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, ''))}</span></span>` : '',
    !r && team.length ? `<span class="m">${icon('agent')}${plural(team.length, 'delegate')}</span>` : '',
    !r && share.crew?.length ? `<span class="m">${icon('crew')}${esc(share.crew.join(', '))}</span>` : '',
    !r && share.connectors?.length ? `<span class="m" title="${esc(share.connectors.join(', '))}">${icon('plug')}${plural(share.connectors.length, 'connector')}</span>` : '',
    !r && share.skills?.length ? `<span class="m" title="${esc(share.skills.join(', '))}">${icon('read')}${plural(share.skills.length, 'skill')}</span>` : '',
    r ? `<span class="m">${icon(r.crew ? 'crew' : 'agent')}${r.crew ? 'A crew member’s job' : 'A subagent'}</span>` : '',
  ].filter(Boolean);
  document.getElementById('svSide').innerHTML = `
    <div class="it-props"><span class="pill st-${st}"><i></i>${STATUS_LABEL[st] || 'Finished'}</span></div>
    <div class="sv-from">${from.avatar ? `<img class="sv-av" src="${esc(from.avatar)}" alt="">` : `<span class="sv-av">${esc((from.name || from.handle || '?')[0].toUpperCase())}</span>`}<span><small>Shared by</small><b>${esc(from.name || from.handle || 'someone')}</b>${from.handle && from.handle !== from.name ? `<small>@${esc(from.handle)}</small>` : ''}</span></div>
    <div class="it-meta">${meta.join('')}</div>
    <div class="sv-import"><b>Carry it on in wisp</b><p>Paste the link in wisp’s New task box. ${esc(carried())} come with it.</p><button class="ghost sm sv-copy" type="button">${icon('copy')}<span>Copy link</span></button></div>`;

  const box = document.getElementById('svTurns');
  box.removeAttribute('aria-busy');
  box.replaceChildren(...turns.map((t, i) => turnNode(t, i, lead)));
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView({ block: 'start' });
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(share.url);
  } catch {
    const t = el(`<textarea>${esc(share.url)}</textarea>`);
    document.body.append(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  for (const x of document.querySelectorAll('.sv-copy span')) x.textContent = 'Copied: paste it in wisp';
  setTimeout(() => document.querySelectorAll('.sv-copy span').forEach((x) => (x.textContent = 'Copy link')), 2200);
}

document.addEventListener('click', (e) => {
  if (e.target.closest('.sv-copy')) copyLink();
});
// Escape closes a picture opened full screen, as in wisp (whose page-wide keys do it there).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeOverlay();
});

render();
