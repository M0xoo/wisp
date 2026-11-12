// v1 server/runs.js PICK_JS, verbatim: in the app's pages through Preview's proxy only. The panel turns picking on, the
// pointer outlines what's under it, a click tells the panel which element (tag, text, selector, trimmed HTML, key
// styles) and ends it; Escape ends it too. It talks to the frame's parent only, never holds what's typed in a password
// or hidden field, and its cursor is a constructed sheet a page's CSP can't refuse.
(() => {
  if (window.parent === window || window.__wispPick) return;
  window.__wispPick = true;
  const say = (m) => window.parent.postMessage({ wisp: 'pick', ...m }, '*');
  let on = false, box = null, tip = null, cur = null, color = '#3b82f6';
  const aim = new CSSStyleSheet();
  aim.replaceSync('*{cursor:crosshair!important}');
  const aiming = (yes) => { document.adoptedStyleSheets = [...document.adoptedStyleSheets].filter((s) => s !== aim).concat(yes ? [aim] : []); };
  const make = () => {
    box = document.createElement('div');
    tip = document.createElement('div');
    Object.assign(box.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', borderRadius: '3px', boxSizing: 'border-box', display: 'none' });
    Object.assign(tip.style, { position: 'fixed', zIndex: 2147483647, pointerEvents: 'none', font: '11.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace', padding: '2px 6px', borderRadius: '4px', color: '#fff', whiteSpace: 'nowrap', display: 'none' });
    document.documentElement.append(box, tip);
  };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
  const show = (el) => {
    if (!box) make();
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px', border: '2px solid ' + color, background: color + '1f' });
    tip.textContent = name(el);
    Object.assign(tip.style, { display: 'block', background: color, left: Math.max(2, r.left) + 'px', top: (r.top > 24 ? r.top - 22 : r.bottom + 4) + 'px' });
  };
  const hide = () => { if (box) box.style.display = tip.style.display = 'none'; };
  const ok = (c) => /^[A-Za-z_-][\w-]*$/.test(c) && c.length < 40;
  const seg = (n) => {
    if (n.id && /^[A-Za-z][\w-]*$/.test(n.id)) return { s: n.tagName.toLowerCase() + '#' + n.id, stop: true };
    let s = n.tagName.toLowerCase() + [...n.classList].filter(ok).slice(0, 2).map((c) => '.' + c).join('');
    const p = n.parentElement;
    if (p) {
      const like = [...p.children].filter((x) => x.tagName === n.tagName);
      if (like.length > 1 && p.querySelectorAll(':scope > ' + s).length > 1) s += ':nth-of-type(' + (like.indexOf(n) + 1) + ')';
    }
    return { s };
  };
  const selector = (el) => {
    const out = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.body && n !== document.documentElement && out.length < 5; n = n.parentElement) {
      const x = seg(n);
      out.unshift(x.s);
      if (x.stop) break;
    }
    return out.join(' > ') || el.tagName.toLowerCase();
  };
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
  const secret = (el) => /^(password|hidden)$/i.test(el.getAttribute('type') || '');
  const textOf = (el) => {
    const t = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.getAttribute('title') || (secret(el) ? '' : el.value) || '').replace(/\s+/g, ' ').trim();
    return cut(t, 60);
  };
  const EMPTY = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/;
  const attrsOf = (el) => [...el.attributes]
    .filter((a) => !(a.name === 'value' && secret(el)))
    .map((a) => ' ' + a.name + '="' + cut(a.value.replace(/\s+/g, ' ').trim(), a.name === 'class' ? 200 : 80).replace(/"/g, '&quot;') + '"')
    .join('');
  // The element as markup, three levels down and about 600 characters, the rest as …
  const htmlOf = (el) => {
    let room = 600;
    const walk = (n, depth) => {
      if (n.nodeType === 3) {
        const t = cut(n.nodeValue.replace(/\s+/g, ' ').trim(), 80);
        room -= t.length;
        return t;
      }
      if (n.nodeType !== 1 || /^(script|style|noscript|template)$/i.test(n.tagName)) return '';
      const tag = n.tagName.toLowerCase();
      const open = '<' + tag + attrsOf(n) + '>';
      room -= open.length;
      if (EMPTY.test(tag)) return open;
      let inner = '';
      const kids = [...n.childNodes];
      if (kids.length && (depth >= 3 || tag === 'svg')) inner = '…';
      else for (const k of kids) {
        if (room <= 0) { inner += '…'; break; }
        inner += walk(k, depth + 1);
      }
      return open + inner + '</' + tag + '>';
    };
    return cut(walk(el, 0), 800);
  };
  // The four sides of a box in the fewest words; nothing when they're all 0.
  const sides = (c, name) => {
    const [t, r, b, l] = ['top', 'right', 'bottom', 'left'].map((s) => c.getPropertyValue(name + '-' + s + (name === 'border' ? '-width' : '')));
    if (t === '0px' && r === '0px' && b === '0px' && l === '0px') return '';
    return t === b && l === r ? (t === l ? t : t + ' ' + r) : [t, r, b, l].join(' ');
  };
  // What decides how it looks: size, spacing, colour, font. Defaults say nothing.
  const stylesOf = (el) => {
    const c = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const v = (k) => c.getPropertyValue(k);
    const clear = (x) => !x || x === 'transparent' || /^rgba\(.*, 0\)$/.test(x);
    const family = v('font-family').split(',')[0].replace(/["']/g, '').trim();
    const width = sides(c, 'border');
    const out = [
      ['size', Math.round(r.width) + ' × ' + Math.round(r.height) + 'px'],
      ['display', v('display')],
      ['margin', sides(c, 'margin')],
      ['padding', sides(c, 'padding')],
      ['gap', /^(normal|0px)$/.test(v('gap')) ? '' : v('gap')],
      ['color', v('color')],
      ['background', clear(v('background-color')) ? '' : v('background-color')],
      ['font', v('font-weight') + ' ' + v('font-size') + '/' + v('line-height') + ' ' + family],
      ['border', width && v('border-top-style') !== 'none' ? width + ' ' + v('border-top-style') + ' ' + v('border-top-color') : ''],
      ['radius', v('border-radius') === '0px' ? '' : v('border-radius')],
    ];
    return cut(out.filter((x) => x[1]).map((x) => x[0] + ': ' + x[1]).join('; '), 400);
  };
  const tagOf = (el) => {
    const a = [];
    if (el.id) a.push('id="' + el.id + '"');
    const c = el.getAttribute('class');
    if (c && c.trim()) a.push('class="' + (c.trim().length > 60 ? c.trim().slice(0, 59) + '…' : c.trim()) + '"');
    return '<' + el.tagName.toLowerCase() + (a.length ? ' ' + a.join(' ') : '') + '>';
  };
  const stop = () => { on = false; cur = null; hide(); aiming(false); };
  const block = (e) => { if (!on) return; e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); };
  addEventListener('pointermove', (e) => {
    if (!on) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && el !== box && el !== tip && el !== cur) show((cur = el));
  }, true);
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'touchstart', 'touchend', 'submit']) addEventListener(t, block, true);
  addEventListener('click', (e) => {
    if (!on) return;
    block(e);
    const el = document.elementFromPoint(e.clientX, e.clientY) || cur;
    if (!el || el === document.documentElement) return;
    say({ type: 'picked', tag: tagOf(el), text: textOf(el), selector: selector(el), path: location.pathname + location.hash, html: htmlOf(el), styles: stylesOf(el) });
    stop();
  }, true);
  addEventListener('keydown', (e) => { if (on && e.key === 'Escape') { block(e); stop(); say({ type: 'off' }); } }, true);
  addEventListener('scroll', () => on && cur && show(cur), true);
  addEventListener('message', (e) => {
    const d = e.data;
    if (e.source !== window.parent || !d || d.wisp !== 'pick') return;
    if (d.type === 'hello') say({ type: 'ready' });
    if (d.type === 'on') { on = true; if (/^#[0-9a-f]{6}$/i.test(d.color || '')) color = d.color; aiming(true); }
    if (d.type === 'off') stop();
  });
  say({ type: 'ready' });
})();
