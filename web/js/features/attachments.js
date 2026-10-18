// Files attached to a prompt: pasted, dropped or picked, uploaded at once, sent as ids.

import { esc } from '../md.js';
import { upload } from '../core/api.js';
import { el, icon } from '../core/dom.js';
import { fmtSize } from '../core/format.js';
import { toast } from '../ui/toast.js';

// One file picker for every tray: the tray that opened it gets the files.
const fileInput = el(`<input type="file" multiple hidden>`);
document.body.append(fileInput);

export function attachTray() {
  const items = [];
  const node = el(`<div class="tray" hidden></div>`);
  const render = () => {
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
    get busy() {
      return items.some((i) => i.status === 'uploading');
    },
  };
}

// Wire paste + drag/drop of files onto a container.
export function acceptFiles(container, textarea, tray) {
  textarea.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      tray.add(files);
    }
  });
  container.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      e.stopPropagation();
      container.classList.add('drop');
    }
  });
  container.addEventListener('dragleave', (e) => !container.contains(e.relatedTarget) && container.classList.remove('drop'));
  container.addEventListener('drop', (e) => {
    container.classList.remove('drop');
    if (e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      tray.add(e.dataTransfer.files);
    }
  });
}

export function autosize(ta, max = 340) {
  const fit = () => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(max, ta.scrollHeight)}px`;
  };
  ta.addEventListener('input', fit);
  requestAnimationFrame(fit);
  return fit;
}
