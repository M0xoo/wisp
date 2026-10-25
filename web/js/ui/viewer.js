import { el, icon } from '../core/dom.js';
import { esc } from '../md.js';
import { overlay } from './overlay.js';
import { imageButtons, bindImageButtons, copyImage } from './image.js';

// A picture from a reply or an attachment, full screen, to zoom into. Pinch, double-tap (a click
// with a mouse) or the wheel zoom at that point, a drag pans, a tap beside it, a swipe down,
// Escape or × closes. Copy (also ⌘C / Ctrl+C) and Download take it elsewhere. The phone app's
// WebView has no pinch zoom of its own, so this is the only way to read a screenshot there.
// Given the other pictures of the reply (`set`: { list: [{ src, alt }], index }), the arrows, ← / →
// and a sideways swipe go through them.

const MAX = 8;

export function viewImage(src, alt = '', set = null) {
  const list = set?.list?.length > 1 ? set.list : null;
  let at = list ? Math.max(0, Math.min(list.length - 1, set.index || 0)) : 0;
  const node = el(`
    <div class="lb${list ? ' lb-set' : ''}">
      <img class="lb-img" src="${esc(src)}" alt="${esc(alt)}" draggable="false">
      ${list ? `<button class="lb-nav lb-prev" title="Previous (←)" aria-label="Previous picture">${icon('back')}</button><button class="lb-nav lb-next" title="Next (→)" aria-label="Next picture">${icon('chevron')}</button>` : ''}
      <div class="lb-bar">
        ${list ? '<span class="lb-count" aria-live="polite"></span><span class="lb-sep"></span>' : ''}
        <button class="lb-out" title="Zoom out" aria-label="Zoom out">${icon('minus')}</button>
        <button class="lb-pct" title="Zoom to fit or in"></button>
        <button class="lb-in" title="Zoom in" aria-label="Zoom in">${icon('plus')}</button>
        <span class="lb-sep"></span>
        ${imageButtons()}
        <a class="lb-open" href="${esc(src)}" target="_blank" rel="noopener" title="Open the original" aria-label="Open the original">${icon('external')}</a>
        <button class="lb-close" title="Close" aria-label="Close">${icon('x')}</button>
      </div>
    </div>`);
  const img = node.querySelector('.lb-img');
  const pct = node.querySelector('.lb-pct');
  const open = node.querySelector('.lb-open');
  let s = 1;
  let x = 0;
  let y = 0;

  // How much bigger the picture's own pixels are than it fits on screen; a double tap goes about there.
  const ratio = () => (img.offsetWidth && img.naturalWidth ? img.naturalWidth / img.offsetWidth : 1);
  const step = () => Math.min(4, Math.max(2.5, ratio()));
  const paint = (glide) => {
    // Centred while it's smaller than the window, no gap at an edge once it's bigger.
    const b = node.getBoundingClientRect();
    const mx = Math.max(0, (img.offsetWidth * s - b.width) / 2);
    const my = Math.max(0, (img.offsetHeight * s - b.height) / 2);
    x = Math.min(mx, Math.max(-mx, x));
    y = Math.min(my, Math.max(-my, y));
    img.classList.toggle('glide', !!glide);
    img.style.transform = `translate(${x}px, ${y}px) scale(${s})`;
    node.classList.toggle('zoomed', s > 1.01);
    pct.textContent = `${Math.round((s * 100) / ratio())}%`;
  };
  // Scales to `ns` keeping the point under (cx, cy) where it is.
  const scaleAt = (ns, cx, cy) => {
    ns = Math.min(Math.max(MAX, ratio()), Math.max(1, ns));
    const b = node.getBoundingClientRect();
    const px = cx - b.left - b.width / 2;
    const py = cy - b.top - b.height / 2;
    x = px - (ns / s) * (px - x);
    y = py - (ns / s) * (py - y);
    s = ns;
  };
  const zoomAt = (ns, cx, cy) => {
    scaleAt(ns, cx, cy);
    paint(true);
  };
  const centre = () => {
    const b = node.getBoundingClientRect();
    return [b.left + b.width / 2, b.top + b.height / 2];
  };
  const toggle = (cx, cy) => (s > 1.01 ? zoomAt(1, cx, cy) : zoomAt(step(), cx, cy));

  // Pointers down, and where the gesture stood when the last one went down or up.
  const pts = new Map();
  let start = null;
  let moved = false;
  let lastTap = { t: 0, x: 0, y: 0 };
  const mid = () => {
    const [a, b = a] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const begin = (touch) => {
    const m = mid();
    start = { mx: m.x, my: m.y, d: m.d, s, x, y, touch };
  };
  node.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.lb-bar, .lb-nav') || (e.pointerType === 'mouse' && e.button !== 0)) return;
    node.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) moved = false;
    node.classList.add('held');
    begin(e.pointerType !== 'mouse');
  });
  node.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const m = mid();
    if (!moved && pts.size < 2 && Math.hypot(m.x - start.mx, m.y - start.my) < 6) return;
    moved = true;
    if (pts.size > 1 && start.d) {
      s = start.s;
      x = start.x;
      y = start.y;
      scaleAt(start.s * (m.d / start.d), start.mx, start.my);
      x += m.x - start.mx;
      y += m.y - start.my;
      paint();
    } else if (start.s > 1.01) {
      x = start.x + m.x - start.mx;
      y = start.y + m.y - start.my;
      paint();
    } else if (start.touch) {
      // At fit, a finger drags it away (the phone's way out of a picture); the backdrop fades with it.
      // In a set, a sideways drag pulls the next or previous one in instead.
      start.side ??= !!list && Math.abs(m.x - start.mx) > Math.abs(m.y - start.my);
      img.classList.remove('glide');
      if (start.side) {
        x = m.x - start.mx;
        img.style.transform = `translate(${x}px, 0)`;
        return;
      }
      y = m.y - start.my;
      img.style.transform = `translate(0, ${y}px)`;
      node.style.setProperty('--dim', String(Math.max(0.15, 1 - Math.abs(y) / 360)));
    }
  });
  const up = (e) => {
    if (!pts.delete(e.pointerId)) return;
    // One finger left of a pinch: it pans from here.
    if (pts.size) return begin(start.touch);
    node.classList.remove('held');
    if (moved && start.s <= 1.01 && start.touch && s <= 1.01) {
      if (start.side) {
        if (Math.abs(x) > 60 && go(x < 0 ? 1 : -1)) return;
        x = 0;
        return paint(true);
      }
      if (Math.abs(y) > 90) return close();
      node.style.removeProperty('--dim');
      y = 0;
      return paint(true);
    }
    if (moved || e.type === 'pointercancel') return;
    // The node holds the pointer, so the target is always it: ask what's under the finger.
    const onImg = document.elementFromPoint(e.clientX, e.clientY) === img;
    if (e.pointerType === 'mouse') return onImg ? toggle(e.clientX, e.clientY) : s > 1.01 ? zoomAt(1, ...centre()) : close();
    const dbl = e.timeStamp - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40;
    lastTap = dbl ? { t: 0, x: 0, y: 0 } : { t: e.timeStamp, x: e.clientX, y: e.clientY };
    if (dbl) return toggle(e.clientX, e.clientY);
    if (!onImg && s <= 1.01) close();
  };
  node.addEventListener('pointerup', up);
  node.addEventListener('pointercancel', up);
  node.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // A trackpad pinch arrives as a ctrl+wheel with small steps; a mouse notch is about 100px.
      const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      scaleAt(s * Math.exp(-d * (e.ctrlKey ? 0.01 : 0.002)), e.clientX, e.clientY);
      paint(Math.abs(d) >= 50);
    },
    { passive: false },
  );

  node.querySelector('.lb-in').onclick = () => {
    zoomAt(s * 1.6, ...centre());
  };
  node.querySelector('.lb-out').onclick = () => {
    zoomAt(s / 1.6, ...centre());
  };
  pct.onclick = () => {
    toggle(...centre());
  };
  // Shows the picture `d` steps along the set, at fit. False at either end.
  const go = (d) => {
    if (!list || !list[at + d]) return false;
    at += d;
    ({ src, alt } = list[at]);
    img.src = src;
    img.alt = alt;
    if (open) open.href = src;
    bindImageButtons(node, src, alt);
    s = 1;
    x = 0;
    y = 0;
    paint();
    shown();
    return true;
  };
  const shown = () => {
    if (!list) return;
    node.querySelector('.lb-count').textContent = `${at + 1} / ${list.length}`;
    node.querySelector('.lb-prev').disabled = at === 0;
    node.querySelector('.lb-next').disabled = at === list.length - 1;
  };
  if (list) {
    node.querySelector('.lb-prev').onclick = () => {
      go(-1);
    };
    node.querySelector('.lb-next').onclick = () => {
      go(1);
    };
    shown();
  }
  // The page's keys stand down while a dialog is open (Escape still closes it).
  const onKey = (e) => {
    if (!node.isConnected) return cleanup();
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      return copyImage(src, node.querySelector('.img-copy'));
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomAt(s * 1.6, ...centre());
    else if (e.key === '-') zoomAt(s / 1.6, ...centre());
    else if (e.key === '0') zoomAt(1, ...centre());
    else if (e.key === 'ArrowLeft' && list) go(-1);
    else if (e.key === 'ArrowRight' && list) go(1);
  };
  const onResize = () => {
    if (!node.isConnected) return cleanup();
    paint();
  };
  const cleanup = () => {
    removeEventListener('keydown', onKey);
    removeEventListener('resize', onResize);
  };
  addEventListener('keydown', onKey);
  addEventListener('resize', onResize);
  img.addEventListener('load', () => paint());
  bindImageButtons(node, src, alt);
  const close = overlay(node, { onClose: cleanup });
  node.querySelector('.lb-close').onclick = () => {
    close();
  };
  return close;
}
