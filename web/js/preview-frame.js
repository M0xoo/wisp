// The `preview` block: a live web page in the answer, framed as the phone, tablet or browser window
// the agent picked, scaled down to fit. The page runs in a sandboxed iframe (preview-spec.js) on its
// own origin: it can't reach wisp, navigate it or open dialogs over it.

import { esc, inlineMd } from './md.js';
import { el, icon } from './core/dom.js';
import { S } from './core/state.js';
import { DEVICES, boxUrl, isLoopback, previewProblem, previewSandbox, previewSize, previewUrl, shortUrl } from './preview-spec.js';

const picked = new Map(); // key -> { device, w, h }, so a re-render keeps the size the user switched to
const BEZEL = { mobile: [20, 20], tablet: [28, 28], desktop: [2, 33], custom: [2, 33] }; // px around the screen: [left + right, top + bottom]
const FALLBACK_MAX_H = 640;

// ctx: the presentation's ({ session, turn }).
export function previewBlock(b, ctx = {}) {
  const problem = previewProblem(b);
  if (problem) return el(`<div class="b-preview card pv-bad">${icon('warn')}<span><b>${esc(b.title || 'Preview')}</b> can't be shown. ${esc(problem)}</span></div>`);
  const url = previewUrl(b.url);
  const asked = previewSize(b);
  const key = `${ctx.session?.id || ''}:${ctx.turn?.id || ''}:${ctx.turn?.presentation?.blocks?.indexOf(b) ?? ''}:${url}`;
  let size = picked.get(key) || asked;
  // Read away from the computer it runs on (a grid box, or a computer added to the grid with Show
  // local pages in previews on), its localhost has an address of its own there. A task on another
  // machine (<id>@<machine>) isn't on this one.
  const boxed = !isLoopback(location.href) && !String(ctx.session?.id || '').includes('@') && boxUrl(url, S.config?.preview || S.config?.grid?.preview);
  const src = boxed || url;
  const local = !boxed && isLoopback(url) && !isLoopback(location.href);
  const seg = [
    ...Object.entries(DEVICES).map(([id, d]) => ({ id, label: d.label, icon: d.icon, w: d.w, h: d.h })),
    ...(asked.device === 'custom' ? [{ id: 'custom', label: `${asked.w}×${asked.h}`, icon: 'expand', w: asked.w, h: asked.h }] : []),
  ];
  const node = el(`
    <figure class="b-preview card">
      <div class="pv-head">
        <span class="pv-addr" title="${esc(boxed ? `${url}, shown through your grid` : url)}">${icon(src.startsWith('https:') ? 'lock' : 'web')}<span class="pv-host">${esc(shortUrl(url))}</span></span>
        <div class="pv-seg" role="group" aria-label="Screen size">${seg
          .map((d) => `<button data-d="${d.id}" title="${esc(d.label)} · ${d.w} × ${d.h}" aria-label="${esc(d.label)}">${icon(d.icon)}<span>${esc(d.label)}</span></button>`)
          .join('')}</div>
        <div class="pv-tools">
          <button class="pv-btn" data-a="rotate" title="Rotate" aria-label="Rotate">${icon('rotate')}</button>
          <button class="pv-btn" data-a="reload" title="Reload" aria-label="Reload">${icon('rerun')}</button>
          <a class="pv-btn" href="${esc(src)}" target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open in a new tab">${icon('external')}</a>
        </div>
      </div>
      <div class="pv-stage"><div class="pv-device"><div class="pv-screen"><div class="pv-wait"></div></div></div></div>
      <figcaption class="pv-foot">
        ${b.title || b.caption ? `<span class="pv-cap">${b.title ? `<b>${esc(b.title)}</b>` : ''}${b.caption ? `<span>${inlineMd(b.caption)}</span>` : ''}</span>` : ''}
        <span class="pv-meta"><span class="pv-dims"></span><span class="pv-tag" title="Runs in a sandbox: it can't reach wisp, your files or this page">${icon('lock')}sandboxed</span></span>
        ${local ? `<span class="pv-note">${icon('info')}This points at the agent's computer; it may not load here.</span>` : ''}
      </figcaption>
    </figure>`);
  const stage = node.querySelector('.pv-stage');
  const device = node.querySelector('.pv-device');
  const screen = node.querySelector('.pv-screen');
  const dims = node.querySelector('.pv-dims');
  let frame = null;

  // Scale the page down to the stage: as wide as the answer, no taller than the stage's max-height.
  const fit = () => {
    const [bx, by] = BEZEL[size.device] || BEZEL.custom;
    const cs = getComputedStyle(stage);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const availW = stage.clientWidth - padX - bx;
    if (availW <= 0) return; // folded or not on the page yet
    const maxH = Math.min(parseFloat(cs.maxHeight) || FALLBACK_MAX_H, innerHeight * 0.85);
    const s = Math.max(0.1, Math.min(1, availW / size.w, (maxH - padY - by) / size.h));
    screen.style.width = `${Math.floor(size.w * s)}px`;
    screen.style.height = `${Math.floor(size.h * s)}px`;
    if (frame) frame.style.transform = `scale(${s})`;
    dims.textContent = `${size.w} × ${size.h}${s < 0.995 ? ` · ${Math.round(s * 100)}%` : ''}`;
  };

  const paint = () => {
    device.className = `pv-device dev-${size.device}${size.w > size.h ? ' land' : ''}`;
    const on = seg.find((d) => d.w === size.w && d.h === size.h) || seg.find((d) => d.w === size.h && d.h === size.w);
    for (const btn of node.querySelectorAll('.pv-seg button')) btn.classList.toggle('on', btn.dataset.d === on?.id);
    if (frame) {
      frame.style.width = `${size.w}px`;
      frame.style.height = `${size.h}px`;
    }
    fit();
  };

  const mount = () => {
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', previewSandbox(src, location.origin));
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('title', b.title || shortUrl(url));
    frame.addEventListener('load', () => screen.classList.add('loaded'));
    screen.classList.remove('loaded');
    screen.querySelector('iframe')?.remove();
    screen.append(frame);
    frame.src = src;
    paint();
  };

  node.addEventListener('click', (e) => {
    const d = e.target.closest('.pv-seg button')?.dataset.d;
    const a = e.target.closest('button[data-a]')?.dataset.a;
    if (d) {
      const s = seg.find((x) => x.id === d);
      size = { device: d, w: s.w, h: s.h };
    } else if (a === 'rotate') size = { ...size, w: size.h, h: size.w };
    else if (a === 'reload') return mount();
    else return;
    picked.set(key, size);
    paint();
  });

  // Measured once it has a size: a folded turn renders before it's shown.
  new ResizeObserver(() => fit()).observe(stage);
  mount();
  return node;
}
