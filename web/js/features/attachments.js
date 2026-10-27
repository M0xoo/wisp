// Files attached to a prompt: pasted, dropped or picked, uploaded at once, sent as ids.

import { esc } from '../md.js';
import { upload } from '../core/api.js';
import { $, el, icon } from '../core/dom.js';
import { fmtSize } from '../core/format.js';
import { S } from '../core/state.js';
import { toast } from '../ui/toast.js';

// One file picker for every tray: the tray that opened it gets the files.
const fileInput = el(`<input type="file" multiple hidden>`);
document.body.append(fileInput);

// onChange: runs after files come or go (the launcher's Auto preview counts them).
export function attachTray({ onChange } = {}) {
  const items = [];
  const node = el(`<div class="tray" hidden></div>`);
  const render = () => {
    onChange?.();
    node.hidden = !items.length;
    node.innerHTML = items
      .map(
        (it, i) => `<div class="att ${it.status}" data-i="${i}" title="${esc(it.name)}">
          ${it.thumb ? `<img src="${it.thumb}" alt="">` : `<span class="att-ic">${icon(it.mime.startsWith('video') ? 'web' : 'file')}</span>`}
          <span class="att-name">${esc(it.name)}</span><span class="att-size">${fmtSize(it.size)}</span>
          <button class="att-x" title="Remove">${icon('x')}</button>
        </div>`,
      )
      .join('');
  };
  node.addEventListener('click', (e) => {
    const x = e.target.closest('.att-x');
    if (x) {
      items.splice(Number(x.closest('.att').dataset.i), 1);
      render();
    }
  });
  const add = (files) => {
    for (const f of files) {
      const it = { name: f.name || 'pasted', size: f.size, mime: f.type || '', status: 'uploading', thumb: f.type.startsWith('image/') ? URL.createObjectURL(f) : null };
      items.push(it);
      it.promise = upload(f, { name: it.name, type: it.mime })
        .then((j) => ((it.id = j.id), (it.status = 'ready'), render()))
        .catch((err) => ((it.status = 'failed'), render(), toast(`Upload failed: ${esc(err.message)}`, { tone: 'bad' })));
    }
    render();
  };
  return {
    node,
    add,
    pick: () => {
      fileInput.onchange = () => {
        add(fileInput.files);
        fileInput.value = '';
      };
      fileInput.click();
    },
    async ids() {
      await Promise.allSettled(items.map((i) => i.promise));
      return items.filter((i) => i.id).map((i) => i.id);
    },
    clear() {
      items.length = 0;
      render();
    },
    // Empty the tray for an optimistic send, and put the files back if the send fails.
    take() {
      const list = items.splice(0);
      render();
      return list;
    },
    restore(list) {
      if (!list?.length) return;
      items.unshift(...list);
      render();
    },
    get count() {
      return items.filter((i) => i.status !== 'failed').length;
    },
    get busy() {
      return items.some((i) => i.status === 'uploading');
    },
  };
}

// The box a dragged file would land in, lit up (one at a time).
let lit = null;
const light = (box) => {
  if (lit === box) return;
  lit?.classList.remove('drop');
  (lit = box)?.classList.add('drop');
};

// Wire paste + drag/drop of files onto a container. The launcher repaints into the same box: it's
// wired once, and the latest tray takes the files (each repaint used to upload them once more).
export function acceptFiles(container, textarea, tray) {
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      tray.add(files);
    }
  });
  const wired = !!container.takeFiles;
  container.takeFiles = (files) => {
    tray.add(files);
    textarea.focus();
  };
  if (wired) return;
  container.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      light(container);
    }
  });
  container.addEventListener('dragleave', (e) => {
    if (!container.contains(e.relatedTarget)) light(null);
  });
  container.addEventListener('drop', (e) => {
    light(null);
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      container.takeFiles(e.dataTransfer.files);
    }
  });
}

// A file dropped or pasted outside every prompt box: the browser would open a dropped one in wisp's
// place (the desktop app hands it to Preview) and a pasted one went nowhere. It goes to the box it
// was most likely meant for, which lights up while a file is dragged over the page: the follow-up
// box of the open task it's on (or that split view shows, or the open one focused for a paste),
// else the prompt box. Not with a dialog up; a .spell.json is spell-ui.js's to review.
const takes = (box) => (box?.takeFiles && !$('textarea:disabled', box) ? box : null);
const composerOf = (card) => takes(card && $(':scope > .it-body .composer', card));
function boxFor(target) {
  if (!$('#overlay').hidden) return null;
  return composerOf(target?.closest?.('.item.open')) || composerOf($('body.split #feed .item.open')) || takes($('#launcher'));
}
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e) || e.defaultPrevented) return; // a box (or Settings → Spells) has it
  e.preventDefault();
  light(boxFor(e.target));
});
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) light(null); // left the window
});
document.addEventListener('dragend', () => light(null));
// On window, after spell-ui.js's document listener has had its look at the files.
window.addEventListener('drop', (e) => {
  light(null);
  if (!hasFiles(e) || e.defaultPrevented) return;
  e.preventDefault();
  if (e.dataTransfer.files.length) boxFor(e.target)?.takeFiles(e.dataTransfer.files);
});
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (!files.length || e.defaultPrevented || e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
  const open = S.focus && S.open.has(S.focus) && S.nodes.get(S.focus)?.card;
  const box = boxFor(open?.isConnected ? open : null);
  if (!box) return;
  e.preventDefault();
  box.takeFiles(files);
});

export function autosize(ta, max = 340) {
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(max, ta.scrollHeight)}px`;
  };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return fit;
}
