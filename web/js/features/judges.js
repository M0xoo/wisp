// Judges (server/goal.js): who checks a goal. Each one reads the work on its own (any harness,
// model and thinking level, or a crew member on theirs) and votes; the goal is met only when the
// votes agree by the rule: All, Majority or Any. Picked like Delegate: in the launcher's Done when
// line and in Set goal… / Edit goal…; their votes show in the goal band (design/goals.md).

import { esc } from '../md.js';
import { $, $$, el, icon } from '../core/dom.js';
import { popover } from '../ui/popover.js';
import { toast } from '../ui/toast.js';
import { runnerPicker } from './runner-picker.js';
import { agentById, agentName, effortLabel, harnessLogo, paintRunnerBtn, savedEffort, savedModel } from './runners.js';
import { avatarHtml, crewList, memberById } from './crew.js';
import { S } from '../core/state.js';

export const MAX_JUDGES = 5; // as the server allows
export const VOTES = [
  { id: 'all', label: 'All', hint: 'Every judge must say it’s met' },
  { id: 'majority', label: 'Majority', hint: 'More than half must say it’s met' },
  { id: 'any', label: 'Any', hint: 'One judge saying it’s met is enough' },
];
const voteLabel = (v) => VOTES.find((x) => x.id === v)?.label || 'Majority';
const needed = (vote, n) => (vote === 'all' ? n : vote === 'any' ? 1 : Math.floor(n / 2) + 1);
// "2 of 3 must say met": the rule in words, for the editor and the tooltips.
export const ruleLine = (vote, n) => (!n ? '' : n === 1 ? 'The judge decides' : vote === 'all' ? `All ${n} must say it’s met` : `${needed(vote, n)} of ${n} must say it’s met`);

// What a judge is called: a crew member's name, else the harness and model.
export function judgeLabel(j) {
  if (j.crew) return memberById(j.crew)?.name || j.name || 'Crew member';
  const a = agentById(j.agent);
  const model = (j.model && a?.models?.find((x) => x.id === j.model)?.label) || j.model;
  return [a?.name || agentName(j.agent), model, j.effort && effortLabel(j.effort)].filter(Boolean).join(' · ');
}
const faceOf = (j, size) => {
  const c = j.crew && memberById(j.crew);
  return c ? avatarHtml(c, { size, dot: false, small: true }) : harnessLogo(j.agent);
};
// Names as the server keeps them (and the band shows): repeats get 2, 3…
function named(judges) {
  const seen = new Map();
  return judges.map((j) => {
    const base = judgeLabel(j).slice(0, 36);
    const k = (seen.get(base) || 0) + 1;
    seen.set(base, k);
    const { label, role, ...rest } = j;
    return { ...rest, name: k > 1 ? `${base} ${k}` : base };
  });
}
// Judges that still exist here: a harness wisp has, a crew member still on the crew.
export const liveJudges = (list) => (list || []).filter((j) => (j.crew ? !!memberById(j.crew) : S.agents.some((a) => a.id === j.agent)));

// The button: the judges' faces and the rule, or just "Judges".
export function paintJudgesBtn(btn, judges, vote) {
  const n = judges.length;
  btn.classList.toggle('on', n > 0);
  btn.innerHTML = n
    ? `<span class="tb-stack">${judges.map((j, i) => `<span class="ts-m${j.crew ? ' crew' : ''}" style="--i:${i}">${faceOf(j, 18)}</span>`).join('')}</span><span class="tb-label">${n === 1 ? '1 judge' : `${n} judges · ${voteLabel(vote)}`}</span>`
    : `${icon('judge')}<span class="tb-label">Judges</span>`;
  btn.setAttribute('aria-label', n ? `Judges: ${n === 1 ? '1 judge' : `${n} judges, ${voteLabel(vote)}`}` : 'Judges');
  btn.title = n ? `Judges: each checks the goal on its own.\n${judges.map((j) => `• ${judgeLabel(j)}`).join('\n')}\n${ruleLine(vote, n)}. Click to change` : 'Judges: have agents on other harnesses (or your crew) check the goal, and decide by All, Majority or Any';
}

// The editor: a row per judge (its harness, model and thinking level, or a crew member), Add
// judge, and how their votes add up. onChange(judges, vote) on every change.
// over: a popover it stands in for while open (Edit goal…): it lines up with it, and on a phone
// takes its place, with Done to go back to it.
export function judgesEditor(anchor, { judges, vote = 'majority', over = null }, onChange) {
  const open = $('.judges-pop');
  if (open) return open.close();
  let list = judges.map((j) => ({ ...j }));
  let rule = vote || 'majority';
  const r = anchor.getBoundingClientRect();
  const o = over?.isConnected ? over.getBoundingClientRect() : null;
  const sheet = !!o && innerWidth <= 520; // a phone: in place of the popover it came from
  const width = sheet ? o.width : Math.min(480, innerWidth - 24);
  const left = sheet ? o.left : Math.max(12, Math.min(o ? o.left : r.left, innerWidth - 12 - width));
  const below = r.bottom + 420 < innerHeight;
  const node = el(`
    <div class="team-pop judges-pop${sheet ? ' sheet' : ''}" role="dialog" aria-label="Judges" style="left:${left}px;width:${width}px;${sheet ? `top:${Math.max(8, o.top)}px` : below ? `top:${r.bottom + 6}px` : `bottom:${innerHeight - r.top + 6}px`}">
      <header class="tp-head">
        <div class="tp-title"><b>Judges</b><small>Each one checks the goal on its own, reading the code, and votes. The goal is met only when enough of them agree.</small></div>
        ${sheet ? '<button class="ghost sm jp-done">Done</button>' : ''}
      </header>
      <div class="jp-vote">
        <span class="jp-k">Met when</span>
        <div class="pk-seg" role="radiogroup" aria-label="Met when">${VOTES.map((v) => `<button role="radio" data-v="${v.id}" title="${esc(v.hint)}">${v.label}</button>`).join('')}</div>
        <small class="jp-rule"></small>
      </div>
      <div class="tp-list"></div>
      <footer class="tp-foot"></footer>
    </div>`);
  const listEl = $('.tp-list', node);
  const foot = $('.tp-foot', node);
  const crewFree = () => crewList().filter((c) => !list.some((j) => j.crew === c.id));
  const commit = () => onChange(named(list), rule);

  // The rule only means something with two judges or more; one judge simply decides.
  const paintVote = () => {
    const few = list.length < 2;
    $('.jp-vote', node).classList.toggle('off', few);
    for (const b of $$('.jp-vote [data-v]', node)) {
      const on = b.dataset.v === rule;
      b.classList.toggle('on', on);
      b.setAttribute('aria-checked', on);
      b.disabled = few;
      b.tabIndex = on ? 0 : -1; // one Tab stop; arrows move between them
    }
    $('.jp-rule', node).textContent = few ? (list.length ? 'One judge decides. Add another to vote.' : 'Add two or more to vote.') : ruleLine(rule, list.length);
  };
  const paintFoot = () => {
    const full = list.length >= MAX_JUDGES;
    foot.innerHTML = `
      <button class="ghost sm tp-add" ${full ? 'disabled' : ''} ${crewFree().length ? 'aria-haspopup="menu"' : ''}>${icon('plus')}Add judge${crewFree().length ? icon('chevron', 'chev') : ''}</button>
      <span class="tp-count">${list.length} of ${MAX_JUDGES}</span>
      <span class="grow"></span>
      ${list.length ? '<button class="link xs tp-clear">Clear</button>' : ''}`;
  };
  let fresh = -1; // the row just added: the only one that rises in
  const paintList = () => {
    listEl.innerHTML = list.length
      ? list
          .map((j, i) => {
            const rise = i === fresh ? ' fresh' : '';
            if (!j.crew) return `<div class="tp-row jp-row${rise}" data-i="${i}"><div class="tp-top"><button class="runner-btn tp-runner" title="Harness, model and thinking level" aria-haspopup="dialog"></button><span class="grow"></span><button class="icon-btn tp-del" title="Remove" aria-label="Remove judge">${icon('x')}</button></div></div>`;
            const c = memberById(j.crew);
            return `<div class="tp-row jp-row crew${rise}" data-i="${i}"><div class="tp-top">${c ? avatarHtml(c, { size: 26, dot: false }) : `<span class="cr-av">${icon('crew')}</span>`}<span class="tp-crew"><b>${esc(c?.name || j.name || 'Crew member')}</b><small>${esc(c ? [c.role, 'on their own harness'].filter(Boolean).join(' · ') : 'no longer on your crew')}</small></span><span class="grow"></span><button class="icon-btn tp-del" title="Remove" aria-label="Remove judge">${icon('x')}</button></div></div>`;
          })
          .join('')
      : `<div class="tp-empty">${icon('judge')}<p>No judges: wisp’s own quick check decides. Add two or three on different harnesses for a second opinion that doesn’t share the agent’s blind spots.</p></div>`;
    $$('.jp-row', listEl).forEach((row, i) => !list[i].crew && paintRunnerBtn($('.tp-runner', row), list[i].agent, list[i].model, list[i].effort));
    fresh = -1;
    paintFoot();
    paintVote();
  };

  // The next harness nobody judges with yet, else another copy of the first one installed.
  const add = () => {
    if (list.length >= MAX_JUDGES) return;
    const ready = S.agents.filter((a) => a.available);
    const used = new Set(list.map((j) => j.agent));
    const a = ready.find((x) => !used.has(x.id)) || ready[0];
    if (!a) return toast('No harness is installed.', { tone: 'bad' });
    const model = savedModel(a.id);
    list.push({ agent: a.id, model, effort: savedEffort(a.id, model) });
    fresh = list.length - 1;
    paintList();
    commit();
  };
  const addCrew = (id) => {
    const c = memberById(id);
    if (!c || list.length >= MAX_JUDGES || list.some((j) => j.crew === id)) return;
    list.push({ crew: c.id });
    fresh = list.length - 1;
    paintList();
    commit();
  };
  const addMenu = (btn) => {
    const prev = $('.menu.jp-add-menu');
    if (prev) return prev.close();
    const menu = el(`<div class="menu where-menu jp-add-menu" role="menu">
      <button class="wm-row" data-a="harness"><span class="wm-icon">${icon('agent')}</span><span class="wm-name"><b>A harness</b><small>Pick its model and thinking level</small></span></button>
      <div class="wm-sep"></div><div class="wm-h">Your crew <small>they judge on their own harness</small></div>
      ${crewFree().map((c) => `<button class="wm-row" data-crew="${c.id}">${avatarHtml(c, { size: 24, dot: false })}<span class="wm-name"><b>${esc(c.name)}</b><small>${esc(c.role || 'Crew member')}</small></span></button>`).join('')}
    </div>`);
    menu.onclick = (ev) => {
      const b = ev.target.closest('.wm-row');
      if (!b) return;
      shut();
      if (b.dataset.crew) addCrew(b.dataset.crew);
      else add();
    };
    const shut = popover(menu, { anchor: btn, capture: true });
    const br = btn.getBoundingClientRect();
    const h = menu.offsetHeight;
    menu.style.left = `${Math.max(8, Math.min(br.left, innerWidth - menu.offsetWidth - 8))}px`;
    menu.style.top = `${br.bottom + 6 + h > innerHeight - 8 ? Math.max(8, br.top - h - 6) : br.bottom + 6}px`;
  };

  const pickRule = (v) => {
    if (v === rule) return;
    rule = v;
    paintVote();
    commit();
  };
  $('.jp-vote', node).addEventListener('click', (e) => {
    const b = e.target.closest('[data-v]');
    if (b && !b.disabled) pickRule(b.dataset.v);
  });
  $('.jp-vote', node).addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!step || list.length < 2) return;
    e.preventDefault();
    const i = (VOTES.findIndex((v) => v.id === rule) + step + VOTES.length) % VOTES.length;
    pickRule(VOTES[i].id);
    $(`.jp-vote [data-v="${rule}"]`, node).focus();
  });
  $('.jp-done', node)?.addEventListener('click', () => close());
  listEl.addEventListener('click', (e) => {
    const row = e.target.closest('.jp-row');
    if (!row) return;
    const i = Number(row.dataset.i);
    if (e.target.closest('.tp-del')) {
      list.splice(i, 1);
      paintList();
      return commit();
    }
    const rb = e.target.closest('.tp-runner');
    if (rb) {
      const j = list[i];
      runnerPicker(rb, { agent: j.agent, model: j.model, effort: j.effort, savedModel, savedEffort }, (agent, model, effort) => {
        Object.assign(j, { agent, model, effort });
        paintList();
        commit();
      });
    }
  });
  foot.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.tp-add');
    if (addBtn) crewFree().length ? addMenu(addBtn) : add();
    if (e.target.closest('.tp-clear')) {
      list = [];
      paintList();
      commit();
    }
  });

  paintList();
  const close = popover(node, {
    anchor,
    keep: '.picker, .jp-add-menu',
    onClose: () => {
      $('.menu.jp-add-menu')?.close();
      anchor.classList.remove('open');
    },
  });
  anchor.classList.add('open');
  if (!list.length) $('.tp-add', node)?.focus();
}

const SAID = { met: 'Met', not_yet: 'Not yet', impossible: 'Can’t be done', unchecked: 'No answer' };
const VOTE_ICON = { met: 'check', not_yet: 'minus', impossible: 'x', unchecked: 'minus' };

// The band's votes: each judge's face with a dot for how it voted at the last check, and the
// count (–/3 until they first vote). A button: it opens each judge's vote and why.
export function votesHtml(g) {
  if (!g?.judges?.length) return '';
  const n = g.judges.length;
  const votes = g.last?.votes?.length === n ? g.last.votes : null;
  const met = votes ? votes.filter((v) => v.verdict === 'met').length : null;
  const tip = `Judges: ${votes ? `${met} of ${n} said met` : 'no votes yet'} · ${ruleLine(g.vote, n)}`;
  return `<button class="gb-judges" data-g="judges" aria-haspopup="dialog" title="${esc(tip)}" aria-label="${esc(tip)}"><span class="tb-stack">${g.judges.map((j, i) => `<span class="ts-m v-${votes?.[i]?.verdict || 'none'}${j.crew ? ' crew' : ''}" style="--i:${i}">${faceOf(j, 18)}</span>`).join('')}</span><span class="gbj-n">${met == null ? '–' : met}/${n}</span></button>`;
}

// Each judge's vote at the last check, and why: from the band's faces.
export function votesPopover(g, anchor) {
  if ($('.menu.jv-pop')) return $('.menu.jv-pop').close();
  const n = g.judges.length;
  const votes = g.last?.votes?.length === n ? g.last.votes : null;
  const menu = el(`<div class="menu jv-pop" role="dialog" aria-label="Judges’ votes">
    <div class="jv-h"><b>Judges</b><small>${esc(ruleLine(g.vote, n))}</small></div>
    ${g.judges
      .map((j, i) => {
        const v = votes?.[i];
        return `<div class="jv-row v-${v?.verdict || 'none'}"><span class="jv-face">${faceOf(j, 24)}</span><span class="jv-text"><b>${esc(j.name || judgeLabel(j))}</b><small>${esc(v?.why || 'Votes after the next round')}</small></span><span class="jv-vote">${v ? `${icon(VOTE_ICON[v.verdict] || 'minus')}${SAID[v.verdict] || v.verdict}` : '–'}</span></div>`;
      })
      .join('')}
  </div>`);
  const close = popover(menu, { anchor, capture: true });
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + 6 + h < innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - h - 6)}px`;
}
