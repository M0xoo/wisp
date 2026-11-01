import { MOBILE } from '../core/state.js';
import { icon } from '../core/dom.js';
import { toast } from './toast.js';
import { esc } from '../md.js';

// Copy or save a picture from a reply, the way Slack, ChatGPT or Linear do: a small bar on the
// picture (on hover) and in the viewer. Clipboards only reliably take PNG, so anything else is
// drawn onto a canvas first.

async function pngBlob(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (blob.type === 'image/png') return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    // An SVG without a size decodes at 0×0 in some browsers.
    c.width = img.naturalWidth || 1200;
    c.height = img.naturalHeight || 800;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return await new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error('no PNG'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

// The file name it saves under: the path it came from, or its alt text.
export function imageName(src, alt = '') {
  let p = '';
  try {
    const u = new URL(src, location.href);
    p = u.searchParams.get('path') || u.pathname;
  } catch {}
  const base = (p.split(/[\\/]/).pop() || '').trim();
  if (/\.\w{2,5}$/.test(base)) return base;
  return `${(alt || base || 'image').replace(/[^\w.-]+/g, '-').slice(0, 60)}.png`;
}

// `btn` turns into a check for a moment, the way a copy button says it worked; a toast would sit
// on the viewer's bar.
export async function copyImage(src, btn) {
  try {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('no clipboard');
    // Handing the clipboard a promise keeps Safari's click permission while the picture loads.
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob(src) })]);
    if (btn) {
      btn.innerHTML = icon('check');
      btn.classList.add('copied');
      clearTimeout(btn._t);
      btn._t = setTimeout(() => {
        btn.innerHTML = icon('copy');
        btn.classList.remove('copied');
      }, 1400);
    } else toast('Copied the image');
  } catch {
    // A picture from another site that won't let itself be read: its link is the next best thing.
    if (/^https?:/.test(src) && new URL(src).origin !== location.origin && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(src).then(
        () => toast('Copied the image’s link (that site won’t let it be copied)'),
        () => toast('Couldn’t copy the image', { tone: 'bad' }),
      );
    } else toast('Couldn’t copy the image', { tone: 'bad' });
  }
}

// The phone app's WebView ignores `<a download>`: an app new enough saves it natively
// (MainActivity's wispAndroid.save, to Pictures, Movies or Download/wisp) and answers with a
// `wisp-saved` event. An older app has no Download at all.
const app = typeof window !== 'undefined' ? window.wispAndroid : null;
export const CAN_SAVE = !MOBILE || typeof app?.save === 'function';
const saving = new Map();
let saves = 0;
if (MOBILE && CAN_SAVE) {
  addEventListener('wisp-saved', (e) => {
    const { id, where, error } = e.detail || {};
    const name = saving.get(id);
    if (name === undefined) return;
    saving.delete(id);
    if (error) toast(`Couldn’t save ${esc(name)}: ${esc(error)}`, { tone: 'bad' });
    else if (where) toast(`Saved to ${esc(where)}`);
  });
}

export async function saveImage(src, name) {
  if (MOBILE) {
    const id = `s${++saves}`;
    saving.set(id, name);
    app.save(id, new URL(src, location.href).href, name);
    return;
  }
  const a = document.createElement('a');
  a.download = name;
  try {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    a.href = URL.createObjectURL(await res.blob());
  } catch {
    // Cross-origin: the browser ignores `download`, so it opens in a tab to save from there.
    a.href = src;
    a.target = '_blank';
    a.rel = 'noopener';
  }
  document.body.append(a);
  a.click();
  a.remove();
  if (a.href.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// The buttons, for the picture's own bar and the viewer's.
export const imageButtons = () => `
  <button class="img-copy" title="Copy image" aria-label="Copy image">${icon('copy')}</button>
  ${CAN_SAVE ? `<button class="img-save" title="Download" aria-label="Download">${icon('download')}</button>` : ''}`;

// Wires those buttons inside `root` to the picture at `src`.
export function bindImageButtons(root, src, alt) {
  root.querySelector('.img-copy').onclick = (e) => {
    e.stopPropagation();
    copyImage(src, e.currentTarget);
  };
  const save = root.querySelector('.img-save');
  if (save) {
    save.onclick = (e) => {
      e.stopPropagation();
      saveImage(src, imageName(src, alt));
    };
  }
}
