import { el, icon } from '../core/dom.js';
import { MOBILE } from '../core/state.js';
import { esc, md } from '../md.js';
import { overlay } from './overlay.js';

// A markdown file from a reply (the doc block), full screen to read: the file's name and path on
// top, a bar that fills as you read, and its headings down the side on a wide window. Escape, ×
// or a click beside the page closes it.

// YAML front matter is for tools, not readers.
export const docBody = (text = '') => String(text).replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---\n+/, '');

// The doc's own title: what the agent called it, its first heading, else the file's name.
export function docTitle(b) {
  return b.title || docBody(b.text).match(/^#\s+(.+)/m)?.[1]?.trim() || String(b.path || 'Document').split(/[\\/]/).pop();
}

export function docStats(text) {
  const body = docBody(text);
  const words = (body.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  return { lines: body.replace(/\n+$/, '').split('\n').length, words, minutes: Math.max(1, Math.round(words / 220)) };
}

// actions: { copy(btn), reveal() } — reveal is left out where there's no folder to open.
export function readDoc(b, { copy, reveal } = {}) {
  const title = docTitle(b);
  const st = docStats(b.text);
  const node = el(`
    <div class="dr" role="dialog" aria-label="${esc(title)}">
      <header class="dr-top">
        <span class="dr-ic">${icon('file')}</span>
        <div class="dr-name"><b>${esc(title)}</b><span>${b.path ? `<code>${esc(b.path)}</code>` : ''}<i>${st.minutes} min read</i></span></div>
        <div class="dr-tools">
          <button class="ghost xs dr-copy" title="Copy the markdown">${icon('copy')}<span>Copy</span></button>
          ${reveal && !MOBILE ? `<button class="ghost xs dr-reveal" title="Show the file in its folder">${icon('folder')}<span>Show in folder</span></button>` : ''}
          <button class="ghost xs dr-close" title="Close (Esc)" aria-label="Close">${icon('x')}</button>
        </div>
        <span class="dr-progress"><i></i></span>
      </header>
      <div class="dr-scroll">
        <div class="dr-layout">
          <nav class="dr-toc" hidden></nav>
          <article class="dr-page prose">${md(docBody(b.text))}</article>
        </div>
        ${b.truncated ? `<p class="dr-cut">${icon('info')}The file is longer than this: wisp kept its first 512 KB.</p>` : ''}
      </div>
    </div>`);
  const scroller = node.querySelector('.dr-scroll');
  const bar = node.querySelector('.dr-progress i');
  const page = node.querySelector('.dr-page');

  // Contents: the headings, once there are enough of them to find your way by.
  const heads = [...page.querySelectorAll('h3, h4')];
  const toc = node.querySelector('.dr-toc');
  if (heads.length >= 3) {
    heads.forEach((h, i) => (h.id = `dr-h${i}`));
    toc.innerHTML = `<span class="dr-toc-label">Contents</span>${heads.map((h, i) => `<a href="#dr-h${i}" class="lv-${h.tagName.toLowerCase()}" data-i="${i}">${esc(h.textContent)}</a>`).join('')}`;
    toc.hidden = false;
    toc.onclick = (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      heads[a.dataset.i].scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
  }
  const links = [...toc.querySelectorAll('a')];
  const onScroll = () => {
    const max = scroller.scrollHeight - scroller.clientHeight;
    bar.style.transform = `scaleX(${max > 0 ? Math.min(1, scroller.scrollTop / max) : 1})`;
    if (!links.length) return;
    const top = scroller.getBoundingClientRect().top + 80;
    let at = 0;
    heads.forEach((h, i) => {
      if (h.getBoundingClientRect().top <= top) at = i;
    });
    links.forEach((a, i) => a.classList.toggle('on', i === at));
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  requestAnimationFrame(onScroll);

  // A click on the backdrop around the page closes it, like the overlay's own.
  scroller.addEventListener('click', (e) => {
    if (e.target === scroller || e.target.classList.contains('dr-layout')) close();
  });
  node.querySelector('.dr-copy').onclick = (e) => {
    copy?.(e.currentTarget);
  };
  const rv = node.querySelector('.dr-reveal');
  if (rv) {
    rv.onclick = () => {
      reveal();
    };
  }
  const close = overlay(node);
  node.querySelector('.dr-close').onclick = () => {
    close();
  };
  scroller.tabIndex = -1;
  scroller.focus({ preventScroll: true });
  return close;
}
