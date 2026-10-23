// The `app` block: a small page the agent (or a spell) wrote, run in a sandboxed iframe inside the
// answer. What it may do is in web/js/app-doc.js. It reaches wisp only through `wisp.send(text)`,
// which fills a strip drawn here, outside the frame: nothing is sent until the user clicks Send.

import { esc } from './md.js';
import * as bus from './core/bus.js';
import { el, icon } from './core/dom.js';
import { APP_HEIGHT, APP_MAX_STATE, APP_TOKENS, appDoc, appKey, appProblem, themeCss } from './app-doc.js';

const live = new Set(); // { frame, on(message) } for frames on the page
const heights = new Map(); // key -> last height, so a re-render doesn't jump
const memory = new Map(); // key -> state, for apps with no turn to keep it on (spell panels)


function theme() {
  const cs = getComputedStyle(document.documentElement);
  const vars = Object.fromEntries(APP_TOKENS.map((t) => [t, cs.getPropertyValue(t).trim()]).filter(([, v]) => v));
  return { vars, scheme: cs.colorScheme === 'dark' ? 'dark' : 'light' };
}
// Frames load once they're near the screen: a long feed of answers shouldn't start them all.
let io = null;

// Set up on the first app, so importing this (blocks.js does, in the Node tests too) touches no DOM.
let ready = false;
function setup() {
  if (ready) return;
  ready = true;
  addEventListener('message', (e) => {
    if (!e.data?.wispApp) return;
    for (const f of live) {
      if (!f.frame.isConnected) live.delete(f);
      else if (e.source === f.frame.contentWindow) return f.on(e.data);
    }
  });
  bus.on('theme', () => {
    // Wait for the new theme's styles to apply before reading them.
    requestAnimationFrame(() => {
      const { vars, scheme } = theme();
      for (const f of live) {
        if (!f.frame.isConnected) live.delete(f);
        else f.frame.contentWindow?.postMessage({ type: 'theme', css: themeCss(vars, scheme), scheme }, '*');
      }
    });
  });
  if ('IntersectionObserver' in window) {
    io = new IntersectionObserver((entries) => entries.forEach((en) => en.isIntersecting && (io.unobserve(en.target), en.target._mount?.())), { rootMargin: '600px 0px' });
  }
}

// ctx: the presentation's ({ session, turn, reply, draft, saveApp }). opts.spell: drawn by a spell.
export function appBlock(b, ctx = {}, { spell } = {}) {
  setup();
  const problem = appProblem(b);
  if (problem) return el(`<div class="b-app card app-bad">${icon('warn')}<span><b>${esc(b.title || 'Interactive block')}</b> can't be shown. ${esc(problem)}</span></div>`);
  const key = appKey(b, ctx.turn?.presentation?.blocks);
  const memKey = `${ctx.session?.id || ''}:${ctx.turn?.id || ''}:${key}`;
  const h = heights.get(memKey) || Math.min(Math.max(Number(b.height) || 320, APP_HEIGHT[0]), APP_HEIGHT[1]);
  const node = el(`
    <div class="b-app card">
      <div class="app-head">
        ${icon('spark')}<span class="app-title">${esc(b.title || 'Interactive')}</span>
        <span class="app-tag" title="Runs in a sandbox: no network, and no access to wisp or your files">${icon('lock')}<span>${spell ? `spell · ${esc(spell)}` : 'sandboxed'}</span></span>
        <button class="app-btn" data-a="reset" title="Start over">${icon('rerun')}</button>
      </div>
      <div class="app-box" style="height:${h}px"><div class="app-wait"></div></div>
      <div class="app-send" hidden>
        <span class="app-lbl">${icon('send')}Send to ${esc(ctx.reply ? 'the agent' : 'the task')}</span>
        <div class="app-txt"></div>
        <div class="app-btns">
          ${ctx.reply ? '<button class="primary sm" data-a="send">Send</button>' : ''}
          ${ctx.draft ? `<button class="${ctx.reply ? 'ghost' : 'primary'} sm" data-a="edit">Edit first</button>` : ''}
          ${!ctx.reply && !ctx.draft ? '<button class="primary sm" data-a="copy">Copy</button>' : ''}
          <button class="ghost sm" data-a="x">Dismiss</button>
        </div>
      </div>
    </div>`);
  const box = node.querySelector('.app-box');
  const strip = node.querySelector('.app-send');
  let pending = '';
  let saveTimer = 0;

  const stateNow = () => (memory.has(memKey) ? memory.get(memKey) : (ctx.turn?.appState?.[key] ?? b.state ?? null));
  const save = (state) => {
    if (JSON.stringify(state ?? null).length > APP_MAX_STATE) return;
    memory.set(memKey, state);
    if (!ctx.turn?.id || !ctx.saveApp) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => ctx.saveApp(key, state), 400);
  };

  const mount = (state = stateNow()) => {
    const { vars, scheme } = theme();
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.setAttribute('title', b.title || 'Interactive block');
    frame.srcdoc = appDoc(b.html, { vars, scheme, state });
    live.add({
      frame,
      on: (m) => {
        if (m.type === 'height' && Number.isFinite(m.h)) {
          const px = Math.min(Math.max(Math.round(m.h), APP_HEIGHT[0]), APP_HEIGHT[1]);
          heights.set(memKey, px);
          box.style.height = `${px}px`;
          box.classList.toggle('scrolls', m.h > APP_HEIGHT[1]);
        } else if (m.type === 'save') save(m.state);
        else if (m.type === 'send' && m.text.trim()) {
          pending = m.text.slice(0, 20_000);
          node.querySelector('.app-txt').textContent = pending;
          strip.hidden = false;
        }
      },
    });
    box.replaceChildren(frame);
  };
  node._mount = () => mount();

  node.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (!a) return;
    if (a === 'reset') {
      save(null);
      strip.hidden = true;
      return mount(null);
    }
    if (a === 'send') ctx.reply(pending);
    if (a === 'edit') ctx.draft(pending);
    if (a === 'copy') navigator.clipboard?.writeText(pending).catch(() => {});
    strip.hidden = true;
  });

  if (io) io.observe(node);
  else queueMicrotask(() => mount());
  return node;
}
