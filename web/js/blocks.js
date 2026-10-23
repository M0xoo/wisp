// Presentation blocks. Each renderer gets (block, ctx) and returns an element.
// ctx: { session, turn, isLatest, reply(text), draft(text), openFile(path, line), fileUrl(path) }

import { md, esc, inlineMd, highlight, langOf } from './md.js';
import { diffLines, hunks, countChanges } from './diff.js';
import { load, save } from './core/state.js';

export const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
// Set while a presentation that was already shown renders: it appears as it is, without the reveal.
let still = false;
const quiet = () => still || reduced();

// Turns whose presentation has played its reveal once (session:turn), newest last.
const SEEN_MAX = 2000;
const seen = new Set(load('wisp.seen', []));
function firstShow(key) {
  if (seen.has(key)) return false;
  seen.add(key);
  save('wisp.seen', [...seen].slice(-SEEN_MAX));
  return true;
}

function countUp(node, to, delay = 0, decimals = null) {
  const n = Number(to);
  if (!Number.isFinite(n)) {
    node.textContent = to;
    return;
  }
  const dec = decimals ?? (String(to).split('.')[1]?.length || 0);
  // One formatter for the whole count: toLocaleString builds a new one on every frame.
  const nf = new Intl.NumberFormat(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  const fmt = (v) => nf.format(v);
  if (quiet()) {
    node.textContent = fmt(n);
    return;
  }
  node.textContent = fmt(0);
  setTimeout(() => {
    const dur = 900 + Math.min(700, Math.log10(Math.abs(n) + 1) * 220);
    const t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 4);
      node.textContent = fmt(n * e);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, delay);
}

function splitPath(p = '') {
  const i = p.lastIndexOf('/');
  return i < 0 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
}

function pathHtml(p) {
  const [dir, base] = splitPath(p);
  return `<span class="path"><span class="dir">${esc(dir)}</span><span class="base">${esc(base)}</span></span>`;
}

const CHANGE = {
  added: ['A', 'add'],
  create: ['A', 'add'],
  modified: ['M', 'mod'],
  edit: ['M', 'mod'],
  write: ['M', 'mod'],
  deleted: ['D', 'del'],
  renamed: ['R', 'ren'],
};

function findChange(turn, file) {
  if (!file || !turn?.changes) return null;
  return turn.changes.find((c) => c.file === file) || turn.changes.find((c) => c.file.endsWith('/' + file) || file.endsWith('/' + c.file));
}

// --- renderers --------------------------------------------------------------

const R = {};

R.hero = (b, ctx) => {
  const status = ['done', 'partial', 'blocked', 'info'].includes(b.status) ? b.status : 'done';
  const label = { done: 'Done', partial: 'Partly done', blocked: 'Blocked', info: 'Report' }[status];
  const st = ctx.turn?.stats || {};
  const meta = [
    ctx.turn?.endedAt && ctx.turn?.startedAt ? fmtDuration(ctx.turn.endedAt - ctx.turn.startedAt) : '',
    st.costUsd ? `$${st.costUsd.toFixed(2)}` : '',
    ctx.turn?.changes?.length ? `${ctx.turn.changes.length} file${ctx.turn.changes.length > 1 ? 's' : ''} touched` : '',
  ].filter(Boolean);
  return el(`
    <div class="b-hero st-${status}">
      <div class="aura"></div>
      <div class="hero-top"><span class="pill st-${status}"><i></i>${label}</span>${meta.map((m) => `<span class="meta">${esc(m)}</span>`).join('')}</div>
      <h2>${esc(b.title || 'Finished')}</h2>
      ${b.summary ? `<p>${inlineMd(b.summary)}</p>` : ''}
    </div>`);
};

R.markdown = (b) => el(`<div class="b-md prose">${md(b.text || '')}</div>`);

R.steps = (b) => {
  const items = b.items || [];
  const node = el(`
    <div class="b-steps card">
      ${b.title ? `<h3 class="b-title">${esc(b.title)}</h3>` : ''}
      <ol>${items
        .map((s, i) => {
          const st = s.status || 'done';
          const ic = st === 'failed' ? 'x' : st === 'skipped' ? 'skip' : 'check';
          return `<li class="st-${st}" style="--k:${i}"><span class="dot">${icon(ic)}</span><div><b>${inlineMd(s.title || '')}</b>${s.detail ? `<p>${inlineMd(s.detail)}</p>` : ''}</div></li>`;
        })
        .join('')}</ol>
    </div>`);
  return node;
};

R.stats = (b, ctx) => {
  const node = el(`<div class="b-stats">${(b.items || [])
    .map(
      (s, i) => `
      <div class="stat tone-${s.tone || 'neutral'}" style="--k:${i}">
        <div class="num"><span class="v" data-v="${esc(s.value)}"></span>${s.unit ? `<span class="u">${esc(s.unit)}</span>` : ''}</div>
        <div class="lbl">${esc(s.label || '')}</div>
        ${s.delta !== undefined && s.delta !== '' ? `<span class="delta">${esc(s.delta)}</span>` : ''}
      </div>`,
    )
    .join('')}</div>`);
  node.querySelectorAll('.v').forEach((v, i) => countUp(v, v.dataset.v, ctx.delay + 250 + i * 120));
  return node;
};

R.files = (b, ctx) => {
  const canRevert = !!(ctx.revertFile && ctx.session?.agent && ctx.session.agent !== 'wisp');
  const node = el(`
    <div class="b-files card">
      <h3 class="b-title">${esc(b.title || 'Files')}<span class="count">${(b.items || []).length}</span></h3>
      <ul>${(b.items || [])
        .map((f, i) => {
          const [ch, cls] = CHANGE[f.change] || CHANGE.modified;
          const c = findChange(ctx.turn, f.path);
          const n = c ? countChanges(c.edits) : null;
          const rev = !!c?.reverted;
          return `<li style="--k:${i}" data-path="${esc(f.path)}" class="${c ? 'has-diff' : ''} ${rev ? 'is-reverted' : ''}">
            <div class="row">
              <span class="badge ${cls}">${ch}</span>${pathHtml(f.path)}
              ${rev ? '<span class="rev-tag">Reverted</span>' : ''}
              ${n ? `<span class="nums"><span class="plus">+${n.add}</span><span class="minus">−${n.del}</span></span>` : ''}
              <span class="actions">${c && canRevert ? `<button class="ghost xs revert" title="${rev ? 'Re-apply changes to this file' : 'Revert file to before this turn'}">${icon(rev ? 'rerun' : 'replay')}<span>${rev ? 'Re-apply' : 'Revert'}</span></button>` : ''}${c ? `<button class="ghost xs toggle" title="Show diff">${icon('chevron')}</button>` : ''}<button class="ghost xs open" title="Open in editor">${icon('external')}</button></span>
            </div>
            ${f.note ? `<p class="note">${inlineMd(f.note)}</p>` : ''}
          </li>`;
        })
        .join('')}</ul>
    </div>`);
  node.addEventListener('click', (e) => {
    const li = e.target.closest('li');
    if (!li) return;
    if (e.target.closest('.open')) return ctx.openFile(li.dataset.path);
    const revBtn = e.target.closest('.revert');
    if (revBtn) {
      const c = findChange(ctx.turn, li.dataset.path);
      return ctx.revertFile?.(c?.file || li.dataset.path, !!c?.reverted);
    }
    if (!li.classList.contains('has-diff')) return;
    if (e.target.closest('a')) return;
    const existing = li.querySelector('.b-diff');
    if (existing) {
      existing.remove();
      li.classList.remove('open');
      return;
    }
    li.classList.add('open');
    li.append(R.diff({ file: li.dataset.path, bare: true }, ctx));
  });
  return node;
};

R.tree = (b, ctx) => {
  const root = { children: new Map() };
  for (const f of b.items || []) {
    const parts = f.path.split('/').filter(Boolean);
    let cur = root;
    parts.forEach((p, i) => {
      if (!cur.children.has(p)) cur.children.set(p, { name: p, children: new Map(), item: null, path: parts.slice(0, i + 1).join('/') });
      cur = cur.children.get(p);
    });
    cur.item = f;
  }
  let k = 0;
  const render = (node, depth) =>
    [...node.children.values()]
      .sort((a, b) => (b.children.size > 0) - (a.children.size > 0) || a.name.localeCompare(b.name))
      .map((n) => {
        // collapse single-child directory chains: src/lib/util
        let name = n.name;
        while (!n.item && n.children.size === 1 && [...n.children.values()][0].children.size > 0) {
          n = [...n.children.values()][0];
          name += '/' + n.name;
        }
        const isDir = n.children.size > 0 && !n.item;
        const [ch, cls] = n.item ? CHANGE[n.item.change] || CHANGE.added : ['', ''];
        return `<li style="--k:${k++};--depth:${depth}" class="${isDir ? 'dir' : 'file'}" ${isDir ? '' : `data-path="${esc(n.path)}"`}>
          <span class="row">${icon(isDir ? 'folder' : 'file')}<span class="name">${esc(name)}${isDir ? '/' : ''}</span>${ch ? `<span class="badge ${cls}">${ch}</span>` : ''}${n.item?.note ? `<span class="note">${inlineMd(n.item.note)}</span>` : ''}</span>
        </li>${isDir ? render(n, depth + 1) : ''}`;
      })
      .join('');
  const node = el(`<div class="b-tree card">${b.title ? `<h3 class="b-title">${esc(b.title)}</h3>` : ''}<ul>${render(root, 0)}</ul></div>`);
  node.addEventListener('click', (e) => {
    const li = e.target.closest('li.file');
    if (li) ctx.openFile(li.dataset.path);
  });
  return node;
};

R.diff = (b, ctx) => {
  let edits;
  let op = 'edit';
  let file = b.file || b.path || '';
  const c = findChange(ctx.turn, file);
  if (b.before !== undefined || b.after !== undefined) edits = [{ before: b.before || '', after: b.after || '' }];
  else if (c) {
    edits = c.edits;
    op = c.op;
    file = c.file;
  }
  if (!edits) {
    return el(`<div class="b-diff card missing"><div class="diff-head">${icon('file')}${pathHtml(file)}</div><p class="muted">No captured edits for this file.</p></div>`);
  }
  const { add, del } = countChanges(edits);
  const numbered = op === 'create' || op === 'write';
  const lang = langOf(file);
  const canRevert = !!(c && ctx.revertFile && ctx.session?.agent && ctx.session.agent !== 'wisp');
  const reverted = !!c?.reverted;
  const body = edits
    .map((e, ei) => {
      const rows = hunks(diffLines(e.before, e.after), 3)
        .map((o) =>
          o.op === '…'
            ? `<tr class="gap"><td colspan="3">${icon('dots')} ${o.count} unchanged line${o.count > 1 ? 's' : ''}</td></tr>`
            : `<tr class="ln ${o.op === '+' ? 'add' : o.op === '-' ? 'del' : ''}"><td class="no">${numbered ? (o.op === '+' ? o.b : o.op === '-' ? o.a : o.b) || '' : ''}</td><td class="sign">${o.op === ' ' ? '' : o.op === '-' ? '−' : '+'}</td><td class="src">${highlight(o.text, lang) || ' '}</td></tr>`,
        )
        .join('');
      return `${ei > 0 ? '<tr class="sep"><td colspan="3"></td></tr>' : ''}${rows}`;
    })
    .join('');
  const node = el(`
    <div class="b-diff ${b.bare ? 'bare' : 'card'} ${reverted ? 'is-reverted' : ''}">
      ${b.bare ? '' : `<div class="diff-head">${icon('file')}${pathHtml(file)}${reverted ? '<span class="rev-tag">Reverted</span>' : ''}<span class="nums"><span class="plus">+${add}</span><span class="minus">−${del}</span></span>${canRevert ? `<button class="ghost xs revert ${reverted ? 'reverted' : ''}" title="${reverted ? 'Re-apply changes to this file' : 'Revert this file to before this turn'}">${icon(reverted ? 'rerun' : 'replay')}<span>${reverted ? 'Re-apply' : 'Revert'}</span></button>` : ''}<button class="ghost xs open" title="Open in editor">${icon('external')}</button></div>`}
      <div class="diff-scroll"><table><tbody>${body}</tbody></table></div>
      ${b.caption ? `<p class="caption">${inlineMd(b.caption)}</p>` : ''}
    </div>`);
  node.querySelector('.open')?.addEventListener('click', () => ctx.openFile(file));
  node.querySelector('.revert')?.addEventListener('click', () => ctx.revertFile?.(file, reverted));
  return node;
};

R.code = (b, ctx) => {
  const lines = String(b.code || '').replace(/\n$/, '').split('\n');
  const hl = new Set(b.highlight || []);
  const start = Number(b.line) || 1;
  const lang = b.language || langOf(b.file || '');
  const node = el(`
    <div class="b-code card">
      <div class="code-head">${b.file ? `<button class="link file">${pathHtml(b.file)}${b.line ? `<span class="lineno">:${b.line}</span>` : ''}</button>` : `<span class="lang">${esc(lang)}</span>`}<button class="ghost xs copy" title="Copy">${icon('copy')}</button></div>
      <div class="code-scroll"><table><tbody>${lines
        .map((l, i) => `<tr class="${hl.has(i + 1) ? 'hl' : ''}"><td class="no">${start + i}</td><td class="src">${highlight(l, lang) || ' '}</td></tr>`)
        .join('')}</tbody></table></div>
      ${b.caption ? `<p class="caption">${inlineMd(b.caption)}</p>` : ''}
    </div>`);
  node.querySelector('.copy').addEventListener('click', (e) => copy(b.code, e.currentTarget));
  node.querySelector('.file')?.addEventListener('click', () => ctx.openFile(b.file, b.line));
  return node;
};

R.compare = (b) => {
  const side = (s = {}, kind) => `
    <div class="side ${kind}">
      <div class="side-label">${esc(s.label || (kind === 'before' ? 'Before' : 'After'))}</div>
      ${s.items ? `<ul>${s.items.map((t, i) => `<li style="--k:${i}">${icon(kind === 'before' ? 'minus' : 'plus')}<span>${inlineMd(t)}</span></li>`).join('')}</ul>` : ''}
      ${s.text ? `<div class="prose">${md(s.text)}</div>` : ''}
      ${s.code ? `<pre class="code"><code>${highlight(s.code, s.language || '')}</code></pre>` : ''}
    </div>`;
  return el(`<div class="b-compare">${side(b.before, 'before')}<div class="arrow">${icon('arrow')}</div>${side(b.after, 'after')}</div>`);
};

// Orthogonal polyline with rounded corners.
const orthPath = (pts, r = 10) =>
  pts
    .map(([x, y], i) => {
      if (i === 0) return `M${x},${y}`;
      if (i === pts.length - 1) return `L${x},${y}`;
      const [px, py] = pts[i - 1];
      const [nx, ny] = pts[i + 1];
      const k1 = Math.min(r, Math.hypot(x - px, y - py) / 2);
      const k2 = Math.min(r, Math.hypot(nx - x, ny - y) / 2);
      const ux = Math.sign(x - px), uy = Math.sign(y - py), vx = Math.sign(nx - x), vy = Math.sign(ny - y);
      return `L${x - ux * k1},${y - uy * k1} Q${x},${y} ${x + vx * k2},${y + vy * k2}`;
    })
    .join(' ');
const FLOW_MIN_COL = 150; // px a column needs before the row wraps
const FLOW_GAP = 46;

R.flow = (b) => {
  const nodes = (b.nodes || []).map((n, i) => (typeof n === 'string' ? { id: String(i), label: n } : { id: String(n.id ?? i), ...n }));
  const ids = nodes.map((n) => n.id);
  let edges = (b.edges || []).map((e) => (Array.isArray(e) ? { from: String(e[0]), to: String(e[1]), label: e[2] } : { from: String(e.from), to: String(e.to), label: e.label }));
  if (!b.edges) edges = nodes.slice(1).map((n, i) => ({ from: nodes[i].id, to: n.id }));
  edges = edges.filter((e) => ids.includes(e.from) && ids.includes(e.to));

  // Longest-path layering; edges pointing backwards in declaration order are "loops".
  const level = Object.fromEntries(ids.map((id) => [id, 0]));
  const order = Object.fromEntries(ids.map((id, i) => [id, i]));
  const forward = edges.filter((e) => order[e.to] > order[e.from]);
  for (const id of ids) for (const e of forward) if (e.from === id) level[e.to] = Math.max(level[e.to], level[id] + 1);
  const cols = [];
  for (const n of nodes) (cols[level[n.id]] ||= []).push(n);

  const node = el(`
    <div class="b-flow card">
      ${b.title ? `<h3 class="b-title">${esc(b.title)}</h3>` : ''}
      <div class="flow-stage">
        <svg class="wires"></svg>
        <div class="cols">${cols
          .map(
            (col, ci) => `<div class="col">${col
              .map((n) => `<div class="node" data-id="${esc(n.id)}" style="--k:${ci}"><b>${inlineMd(n.label || n.id)}</b>${n.note ? `<span>${inlineMd(n.note)}</span>` : ''}</div>`)
              .join('')}</div>`,
          )
          .join('')}</div>
      </div>
    </div>`);

  const draw = () => {
    const stage = node.querySelector('.flow-stage');
    const svg = node.querySelector('.wires');
    const box = stage.getBoundingClientRect();
    if (!box.width) return;
    svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
    const rect = (id) => {
      const r = stage.querySelector(`.node[data-id="${CSS.escape(id)}"]`).getBoundingClientRect();
      return { l: r.left - box.left, t: r.top - box.top, r: r.right - box.left, b: r.bottom - box.top, cx: r.left - box.left + r.width / 2, cy: r.top - box.top + r.height / 2 };
    };
    const colsEl = stage.querySelector('.cols');
    const vertical = getComputedStyle(colsEl).flexDirection === 'column';
    // Too many columns for the width: wrap into rows that snake (L→R, then R→L, …).
    const hasBack = edges.some((e) => order[e.to] <= order[e.from]);
    const room = box.width - 4 - (hasBack ? 70 : 0); // leave the loop gutter either way so the row count is stable
    const perRow = vertical ? cols.length : Math.max(1, Math.floor((room + FLOW_GAP) / (FLOW_MIN_COL + FLOW_GAP)));
    const snake = !vertical && cols.length > perRow;
    if (snake !== colsEl.classList.contains('snake') || (snake && colsEl.style.getPropertyValue('--per-row') !== String(perRow))) {
      colsEl.classList.toggle('snake', snake);
      colsEl.style.setProperty('--per-row', snake ? perRow : '');
      [...colsEl.children].forEach((c, i) => {
        const row = Math.floor(i / perRow);
        const pos = i % perRow;
        c.style.gridRow = snake ? row + 1 : '';
        c.style.gridColumn = snake ? (row % 2 ? perRow - pos : pos + 1) : '';
      });
      return requestAnimationFrame(draw);
    }
    let out = '';
    let loopTop = false;
    let loopBottom = false;
    edges.forEach((e, i) => {
      const a = rect(e.from);
      const z = rect(e.to);
      const back = order[e.to] <= order[e.from];
      let d;
      let lx;
      let ly;
      if (back) {
        if (snake && Math.abs(a.cy - z.cy) > 4) {
          // Out to the right gutter, up, then over the top of the target so it never crosses a card.
          const x = box.width - 44;
          const y = z.t - 16;
          d = orthPath([[a.r, a.cy], [x, a.cy], [x, y], [z.cx, y], [z.cx, z.t]]);
          lx = x + 6;
          ly = (a.cy + y) / 2;
          loopTop ||= y < 0;
        } else if (vertical) {
          const x = Math.max(a.r, z.r) + 26;
          d = `M${a.r},${a.cy} C${x},${a.cy} ${x},${z.cy} ${z.r},${z.cy}`;
          lx = x + 4;
          ly = (a.cy + z.cy) / 2;
        } else {
          const y = Math.max(a.b, z.b) + 34;
          loopBottom = true;
          d = `M${a.cx},${a.b} C${a.cx},${y} ${z.cx},${y} ${z.cx},${z.b}`;
          lx = (a.cx + z.cx) / 2;
          ly = y - 4;
        }
      } else if (vertical) {
        const m = (a.b + z.t) / 2;
        d = `M${a.cx},${a.b} C${a.cx},${m} ${z.cx},${m} ${z.cx},${z.t}`;
        lx = (a.cx + z.cx) / 2 + 8;
        ly = m;
      } else if (snake && z.t >= a.b) {
        // Row turn: drop from the end of one row into the start of the next.
        const m = (a.b + z.t) / 2;
        d = `M${a.cx},${a.b} C${a.cx},${m} ${z.cx},${m} ${z.cx},${z.t}`;
        lx = (a.cx + z.cx) / 2 + 8;
        ly = m;
      } else if (z.cx < a.cx) {
        // Right-to-left row.
        const m = (a.l + z.r) / 2;
        d = `M${a.l},${a.cy} C${m},${a.cy} ${m},${z.cy} ${z.r},${z.cy}`;
        lx = m;
        ly = (a.cy + z.cy) / 2 - 8;
      } else {
        const m = (a.r + z.l) / 2;
        d = `M${a.r},${a.cy} C${m},${a.cy} ${m},${z.cy} ${z.l},${z.cy}`;
        lx = m;
        ly = (a.cy + z.cy) / 2 - 8;
      }
      out += `<path class="wire ${back ? 'back' : ''}" d="${d}" pathLength="1" style="--k:${i}"/>`;
      // Hidden until its motion begins: before that the circle sits at 0,0, the stage's top-left corner.
      const begin = `${0.8 + i * 0.35}s`;
      if (!reduced()) out += `<circle r="3" class="spark ${back ? 'back' : ''}" visibility="hidden"><set attributeName="visibility" to="visible" begin="${begin}"/><animateMotion dur="${back ? 3.2 : 2.2}s" begin="${begin}" repeatCount="indefinite" path="${d}"/></circle>`;
      const side = vertical || (snake && (back ? Math.abs(a.cy - z.cy) > 4 : z.t >= a.b));
      if (e.label) out += `<text x="${lx}" y="${ly}" class="wire-label" text-anchor="${side ? 'start' : 'middle'}">${esc(e.label)}</text>`;
    });
    svg.innerHTML = out;
    stage.style.paddingBottom = loopBottom ? '46px' : '';
    stage.style.paddingRight = (vertical || snake) && hasBack ? '70px' : '';
    stage.style.paddingTop = loopTop || (snake && stage.style.paddingTop && hasBack) ? '22px' : '';
  };
  new ResizeObserver(() => requestAnimationFrame(draw)).observe(node);
  return node;
};

R.chart = (b, ctx) => {
  const items = b.items || [];
  const max = Math.max(...items.map((i) => Math.abs(Number(i.value) || 0)), 1);
  const node = el(`
    <div class="b-chart card">
      ${b.title ? `<h3 class="b-title">${esc(b.title)}</h3>` : ''}
      <div class="bars">${items
        .map(
          (it, i) => `<div class="bar-row" style="--k:${i}">
            <span class="bar-label">${esc(it.label)}</span>
            <span class="bar-track"><span class="bar" style="--w:${(Math.abs(Number(it.value) || 0) / max) * 100}%"></span></span>
            <span class="bar-val"><span class="v" data-v="${esc(it.value)}"></span>${b.unit ? `<span class="u">${esc(b.unit)}</span>` : ''}</span>
          </div>`,
        )
        .join('')}</div>
    </div>`);
  node.querySelectorAll('.v').forEach((v, i) => countUp(v, v.dataset.v, ctx.delay + 300 + i * 140));
  return node;
};

R.terminal = (b, ctx) => {
  const cmd = String(b.command || '');
  const key = `term:${cmd}`;
  const prev = cmd && ctx.turn?.actionRuns?.[key];
  const exitCode = prev ? prev.exitCode : b.exitCode;
  const ok = exitCode === undefined || Number(exitCode) === 0;
  const node = el(`
    <div class="b-term">
      <div class="term-head"><span class="lights"><i></i><i></i><i></i></span><span class="title">${esc(b.title || ctx.session?.cwd?.split('/').pop() || 'terminal')}</span>${exitCode !== undefined ? `<span class="exit ${ok ? 'ok' : 'bad'}">exit ${esc(exitCode)}</span>` : ''}${cmd && ctx.exec ? `<button class="term-run" title="Run command again">${icon('rerun')}<span>Run</span></button>` : ''}</div>
      <pre><span class="cmd"><span class="ps">$</span> <span class="typed"></span><span class="caret"></span></span>\n<span class="out"></span></pre>
    </div>`);
  const typed = node.querySelector('.typed');
  const out = node.querySelector('.out');
  out.textContent = String(prev ? prev.output : b.output || '').replace(/\s+$/, '');
  if (quiet() || prev) {
    typed.textContent = cmd;
    node.classList.add('ran');
  } else {
    let i = 0;
    setTimeout(function type() {
      typed.textContent = cmd.slice(0, ++i);
      if (i < cmd.length) setTimeout(type, 14 + Math.random() * 30);
      else setTimeout(() => node.classList.add('ran'), 220);
    }, ctx.delay + 300);
  }
  const runBtn = node.querySelector('.term-run');
  if (runBtn) {
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.querySelector('span').textContent = 'Running…';
      try {
        const res = await ctx.exec(cmd, key);
        if (res) {
          typed.textContent = cmd;
          node.classList.add('ran');
          out.textContent = String(res.output || '').replace(/\s+$/, '');
          let badge = node.querySelector('.exit');
          if (!badge) {
            badge = el('<span class="exit"></span>');
            runBtn.before(badge);
          }
          badge.className = `exit ${res.exitCode === 0 ? 'ok' : 'bad'}`;
          badge.textContent = `exit ${res.exitCode}`;
        }
      } finally {
        runBtn.disabled = false;
        runBtn.querySelector('span').textContent = 'Run';
      }
    });
  }
  return node;
};

R.tests = (b, ctx) => {
  const passed = Number(b.passed) || 0;
  const failed = Number(b.failed) || 0;
  const skipped = Number(b.skipped) || 0;
  const total = passed + failed + skipped || 1;
  const C = 2 * Math.PI * 34;
  const seg = (n, off) => `stroke-dasharray="${(n / total) * C} ${C}" stroke-dashoffset="${-off}"`;
  const ok = failed === 0;
  const cmd = String(b.command || '').trim();
  const runKey = `tests:${cmd}`;
  const prevRun = cmd && ctx.turn?.actionRuns?.[runKey];
  const node = el(`
    <div class="b-tests card ${ok ? 'ok' : 'bad'}">
      <div class="tests-main">
        <svg class="ring" viewBox="0 0 80 80">
          <circle cx="40" cy="40" r="34" class="track"/>
          <circle cx="40" cy="40" r="34" class="seg pass" ${seg(passed, 0)}/>
          <circle cx="40" cy="40" r="34" class="seg fail" ${seg(failed, (passed / total) * C)}/>
          <circle cx="40" cy="40" r="34" class="seg skip" ${seg(skipped, ((passed + failed) / total) * C)}/>
        </svg>
        <div class="ring-label">${icon(ok ? 'check' : 'x')}</div>
        <div class="tests-text">
          <div class="verdict">${ok ? 'All green' : `${failed} failing`}${b.by === 'wisp' ? `<span class="tests-by" title="wisp ran the project's tests itself after the agent finished${b.note ? `: ${esc(b.note)}` : ''}">Run by wisp</span>` : ''}</div>
          <div class="counts"><span class="pass"><b class="v" data-v="${passed}"></b> passed</span>${failed ? `<span class="fail"><b class="v" data-v="${failed}"></b> failed</span>` : ''}${skipped ? `<span class="skip"><b class="v" data-v="${skipped}"></b> skipped</span>` : ''}${b.durationMs ? `<span class="dur">${fmtDuration(b.durationMs)}</span>` : ''}</div>
          ${cmd ? `<div class="tests-cmd"><code class="cmdline">$ ${esc(cmd)}</code>${ctx.exec ? `<button class="ghost xs run-tests" title="Re-run ${esc(cmd)}">${icon('rerun')}<span>Re-run</span></button>` : ''}</div>` : ''}
        </div>
      </div>
      <div class="tests-rerun-out" ${prevRun ? '' : 'hidden'}></div>
      ${(b.failures || []).length ? `<ul class="failures">${b.failures
        .map((f) => `<li>${icon('x')}<div><b>${esc(f.name)}</b>${f.message ? `<pre>${esc(f.message)}</pre>` : ''}${f.file ? `<button class="link file" data-file="${esc(f.file)}">${esc(f.file)}</button>` : ''}</div></li>`)
        .join('')}</ul>` : ''}
    </div>`);
  node.querySelectorAll('.v').forEach((v, i) => countUp(v, v.dataset.v, ctx.delay + 300 + i * 100));
  node.querySelectorAll('.file').forEach((btn) =>
    btn.addEventListener('click', () => {
      const [p, line] = btn.dataset.file.split(':');
      ctx.openFile(p, line);
    }),
  );
  const outSlot = node.querySelector('.tests-rerun-out');
  const paintRun = (res) => {
    if (!res || !outSlot) return;
    outSlot.hidden = false;
    const pass = res.exitCode === 0;
    outSlot.innerHTML = `<div class="act-res ${pass ? 'ok' : 'bad'}"><div class="act-res-bar"><span class="exit ${pass ? 'ok' : 'bad'}">exit ${esc(res.exitCode)}</span><span class="muted xs">${fmtDuration(res.durationMs)}</span></div>${res.output ? `<pre class="act-out">${esc(res.output)}</pre>` : ''}</div>`;
  };
  if (prevRun) paintRun(prevRun);
  const runBtn = node.querySelector('.run-tests');
  if (runBtn) {
    runBtn.addEventListener('click', async () => {
      runBtn.disabled = true;
      runBtn.querySelector('span').textContent = 'Running…';
      try {
        const res = await ctx.exec(cmd, runKey);
        paintRun(res);
      } finally {
        runBtn.disabled = false;
        runBtn.querySelector('span').textContent = 'Re-run';
      }
    });
  }
  return node;
};

R.commits = (b) =>
  el(`
    <div class="b-commits card">
      <h3 class="b-title">${icon('branch')}${esc(b.branch || 'Commits')}<span class="count">${(b.items || []).length}</span></h3>
      <ol>${(b.items || [])
        .map(
          (c, i) => `<li style="--k:${i}"><span class="node"></span><div><div class="msg">${inlineMd(c.message || '')}</div><div class="sub"><code>${esc(String(c.hash || '').slice(0, 7))}</code>${c.files ? `<span>${c.files} file${c.files > 1 ? 's' : ''}</span>` : ''}${c.additions !== undefined ? `<span class="plus">+${c.additions}</span>` : ''}${c.deletions !== undefined ? `<span class="minus">−${c.deletions}</span>` : ''}</div></div></li>`,
        )
        .join('')}</ol>
    </div>`);

// A branch graph for a PR or merge: lanes per branch, the merge target on top, commits that
// conflict marked and numbered, and the conflicts themselves listed underneath.
const GRAPH_ROW = 30;
const GRAPH_LANE = 16;
const GRAPH_STATE = {
  conflict: { label: 'conflicts', icon: 'warn' },
  ready: { label: 'ready', icon: 'check' },
  merged: { label: 'merged', icon: 'branch' },
  blocked: { label: 'blocked', icon: 'x' },
  pending: { label: 'checking', icon: 'clock' },
};
const PR_STATE = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };

export function layoutGraph(b) {
  const commits = (Array.isArray(b.commits) ? b.commits : []).filter((c) => c && typeof c === 'object');
  const into = b.into ? String(b.into) : '';
  // Lane 0 is the base branch (what we merge into); the others in order of first appearance.
  const lanes = [];
  const laneOf = (name) => {
    let i = lanes.indexOf(name);
    if (i < 0) i = lanes.push(name) - 1;
    return i;
  };
  const base = into || String(commits.find((c) => c.branch)?.branch || '');
  laneOf(base);
  const off = into ? 1 : 0; // the merge target takes row 0
  const rows = commits.map((c, i) => ({ c, row: i + off, lane: laneOf(c.branch ? String(c.branch) : base) }));
  const head = b.head ? laneOf(String(b.head)) : lanes.length > 1 ? 1 : 0;
  const same = (a, z) => !!a && !!z && (a.startsWith(z) || z.startsWith(a));
  const find = (h) => rows.find((r) => same(String(r.c.hash || ''), String(h)));
  const edges = [];
  const tails = [];
  rows.forEach((r, i) => {
    const below = rows.slice(i + 1);
    let parents = Array.isArray(r.c.parents) ? r.c.parents.map(find).filter(Boolean) : [];
    if (!parents.length) {
      // Implied parent: the next older commit on this branch, else where the branch forked off base.
      const p = below.find((o) => o.lane === r.lane) || (r.lane !== 0 && below.find((o) => o.lane === 0));
      if (p) parents = [p];
    }
    parents.forEach((p, k) => edges.push({ from: r, to: p, lane: k === 0 ? r.lane : p.lane, bend: k === 0 ? 'late' : 'early' }));
    if (!parents.length) tails.push(r);
  });
  const conflictNo = new Map();
  rows.forEach((r) => {
    if (r.c.conflict) conflictNo.set(r, conflictNo.size + 1);
  });
  const tips = new Set(lanes.map((_, l) => rows.find((r) => r.lane === l)).filter(Boolean));
  return { rows, lanes, head, edges, tails, conflictNo, tips, into, off };
}

R.graph = (b, ctx) => {
  const g = layoutGraph(b);
  const conflicts = (Array.isArray(b.conflicts) ? b.conflicts : []).filter(Boolean).map((c) => (typeof c === 'string' ? { file: c } : c));
  const nConflicts = conflicts.length || g.conflictNo.size;
  const merge = GRAPH_STATE[b.merge] ? b.merge : nConflicts ? 'conflict' : g.into ? 'ready' : '';
  const merged = merge === 'merged';
  const laneColor = (l) => (l === 0 ? 'var(--g-base)' : merged && l === g.head ? 'var(--g-merged)' : `var(--g-${((l - 1) % 4) + 1})`);
  const x = (l) => 9 + l * GRAPH_LANE;
  const y = (row) => row * GRAPH_ROW + GRAPH_ROW / 2;
  const nRows = g.rows.length + g.off;
  const width = x(Math.max(0, g.lanes.length - 1)) + 10;
  const height = nRows * GRAPH_ROW + 10;
  const path = (x1, y1, x2, y2, bend) => {
    if (x1 === x2) return `M${x1} ${y1}V${y2}`;
    const r = GRAPH_ROW * 0.8;
    // 'late' stays in the child's lane and curves into the parent near it (a fork); 'early'
    // curves out right away (a merge pulling another branch in).
    return bend === 'early' ? `M${x1} ${y1}C${x1} ${y1 + r} ${x2} ${y1 + r * 0.2} ${x2} ${y1 + r}V${y2}` : `M${x1} ${y1}V${y2 - r}C${x1} ${y2 - r * 0.2} ${x2} ${y2 - r} ${x2} ${y2}`;
  };
  const wires = [];
  g.edges.forEach((e, k) => {
    wires.push(`<path class="g-wire" style="--k:${k};stroke:${laneColor(e.lane)}" pathLength="1" d="${path(x(e.from.lane), y(e.from.row), x(e.to.lane), y(e.to.row), e.bend)}"/>`);
  });
  g.tails.forEach((r) => wires.push(`<path class="g-tail" style="stroke:${laneColor(r.lane)}" d="M${x(r.lane)} ${y(r.row)}V${height}"/>`));
  if (g.into) {
    const headTip = g.rows.find((r) => r.lane === g.head && g.head !== 0);
    const baseTip = g.rows.find((r) => r.lane === 0);
    if (baseTip) wires.push(`<path class="g-tail" style="stroke:var(--g-base)" d="M${x(0)} ${y(0)}V${y(baseTip.row)}"/>`);
    if (headTip) wires.push(`<path class="g-wire ${merged ? '' : 'pending'} st-${merge}" style="--k:0" pathLength="1" d="${path(x(0), y(0), x(headTip.lane), y(headTip.row), 'early')}"/>`);
  }
  const dots = g.rows.map((r) => {
    const cls = r.c.conflict ? 'conflict' : r.c.merge || (Array.isArray(r.c.parents) && r.c.parents.length > 1) ? 'merge' : '';
    return `<circle class="g-dot ${cls}" style="--k:${r.row};--lc:${laneColor(r.lane)}" cx="${x(r.lane)}" cy="${y(r.row)}" r="${cls === 'merge' ? 4.5 : 4}"/>`;
  });
  const target = g.into ? `<g class="g-target st-${merge}" transform="translate(${x(0)} ${y(0)})"><circle r="7.5"/>${merge === 'conflict' ? '<path d="M0 -3.6V0.6M0 3V3.2"/>' : merge === 'ready' ? '<path d="M-3 0.2L-0.9 2.3L3.2 -2"/>' : merge === 'blocked' ? '<path d="M-2.6 -2.6L2.6 2.6M2.6 -2.6L-2.6 2.6"/>' : ''}</g>` : '';

  const meta = (c) => [c.hash ? `<code>${esc(String(c.hash).slice(0, 7))}</code>` : '', [c.author, c.when].filter(Boolean).map((s) => esc(s)).join(' · ')].filter(Boolean).join(' ');
  const rowHtml = (r) => {
    const n = g.conflictNo.get(r);
    const tag = g.tips.has(r) && g.lanes[r.lane] ? `<span class="g-tag" style="--lc:${laneColor(r.lane)}">${esc(g.lanes[r.lane])}</span>` : '';
    const tone = r.c.conflict ? 'conflict' : r.lane === g.head ? 'head' : 'other';
    return `<li class="g-row ${tone}" style="--k:${r.row}" ${n ? `data-n="${n}"` : ''} title="${esc(r.c.note || '')}"><span class="g-msg">${inlineMd(r.c.message || r.c.hash || '')}</span>${tag}${n ? `<span class="g-num">${n}</span>` : ''}<span class="g-meta">${meta(r.c)}</span></li>`;
  };
  const stateNote = b.note || (merge === 'conflict' ? `${nConflicts} conflict${nConflicts === 1 ? '' : 's'}` : GRAPH_STATE[merge]?.label || '');
  const targetRow = g.into ? `<li class="g-row target st-${merge}" style="--k:0"><span class="g-msg">${merged ? 'Merged' : 'Merge'} into ${esc(g.into)}</span><span class="g-state">${esc(stateNote)}</span></li>` : '';

  const checks = (Array.isArray(b.checks) ? b.checks : []).filter(Boolean).map((c) => (typeof c === 'string' ? { label: c, status: 'pass' } : c));
  const checkIcon = { pass: 'check', fail: 'x', pending: 'clock', skip: 'skip' };
  const checksHtml = checks.length
    ? `<div class="g-checks">${checks.map((c, i) => `<span class="g-check st-${esc(c.status || 'pass')}" style="--k:${i}" ${c.detail ? `title="${esc(c.detail)}"` : ''}>${icon(checkIcon[c.status] || 'check')}<b>${esc(c.label || '')}</b>${c.value ? `<span>${esc(c.value)}</span>` : ''}</span>`).join('')}</div>`
    : '';

  const numFor = (c) => {
    if (c.n) return Number(c.n);
    const r = c.commit && g.rows.find((o) => o.c.hash && (String(o.c.hash).startsWith(String(c.commit)) || String(c.commit).startsWith(String(o.c.hash))));
    return r ? g.conflictNo.get(r) : undefined;
  };
  const side = (label, text, cls) => (text ? `<div class="g-side ${cls}"><span class="g-who">${esc(label)}</span><code>${esc(text)}</code></div>` : '');
  const headName = g.lanes[g.head] || 'ours';
  const conflictsHtml = conflicts.length
    ? `<ol class="g-conflicts" ${b.expanded === false ? 'hidden' : ''}>${conflicts
        .map((c, i) => {
          const n = numFor(c);
          const loc = c.file ? `${c.file}${c.line || c.lines ? `:${c.line || c.lines}` : ''}` : '';
          return `<li style="--k:${i}" ${n ? `data-n="${n}"` : ''}>
            <div class="g-c-head"><span class="g-num ${n ? '' : 'plain'}">${n || i + 1}</span>${loc ? `<button class="link g-file" data-file="${esc(loc)}">${esc(loc)}</button>` : ''}${c.detail ? `<span class="g-c-detail">${inlineMd(c.detail)}</span>` : ''}</div>
            ${c.ours || c.theirs ? `<div class="g-sides">${side(c.oursLabel || headName, c.ours, 'ours')}${side(c.theirsLabel || g.into || g.lanes[0] || 'theirs', c.theirs, 'theirs')}</div>` : ''}
            ${c.resolution ? `<div class="g-res">${icon('check')}<span>${inlineMd(c.resolution)}</span></div>` : ''}
          </li>`;
        })
        .join('')}</ol>`
    : '';

  const footText = b.summary
    ? inlineMd(b.summary)
    : merge === 'conflict'
      ? `${conflicts.length ? `<button class="g-count">${nConflicts} conflict${nConflicts === 1 ? '' : 's'}</button>` : `<b>${nConflicts} conflict${nConflicts === 1 ? '' : 's'}</b>`} with ${esc(g.into || g.lanes[0] || 'base')}`
      : merge === 'ready'
        ? 'Ready to merge'
        : merged
          ? `Merged into ${esc(g.into || g.lanes[0])}`
          : merge === 'blocked'
            ? 'Blocked'
            : merge === 'pending'
              ? 'Checks running'
              : '';
  const action = b.action && (typeof b.action === 'string' ? { label: b.action } : b.action);
  const live = ctx.isLatest !== false;
  const foot = footText || action ? `<div class="g-foot st-${merge}">${merge ? icon(GRAPH_STATE[merge].icon) : ''}<span class="g-foot-text">${footText}</span>${action ? `<button class="g-action" ${live ? '' : 'disabled'}>${esc(action.label || 'Continue')}</button>` : ''}</div>` : '';
  const pr = PR_STATE[b.state] ? b.state : merged ? 'merged' : '';

  const node = el(`
    <div class="b-graph card">
      ${b.title || b.ref || pr ? `<div class="g-head"><h3>${inlineMd(b.title || '')}${b.ref ? ` <span class="g-ref">${esc(b.ref)}</span>` : ''}</h3>${pr ? `<span class="g-pr st-${pr}"><i></i>${PR_STATE[pr]}</span>` : ''}</div>` : ''}
      <div class="g-body" style="--g-w:${width}px">
        <svg class="g-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">${wires.join('')}${dots.join('')}${target}</svg>
        <ol class="g-rows">${targetRow}${g.rows.map(rowHtml).join('')}</ol>
      </div>
      ${checksHtml}${conflictsHtml}${foot}
    </div>`);

  const list = node.querySelector('.g-conflicts');
  node.querySelector('.g-count')?.addEventListener('click', () => {
    list.hidden = !list.hidden;
  });
  // Hovering a numbered conflict lights up the commit it came from, and the other way round.
  const light = (n, on) => node.querySelectorAll(`[data-n="${n}"]`).forEach((e) => e.classList.toggle('lit', on));
  node.querySelectorAll('[data-n]').forEach((e) => {
    e.addEventListener('mouseenter', () => light(e.dataset.n, true));
    e.addEventListener('mouseleave', () => light(e.dataset.n, false));
  });
  node.querySelectorAll('.g-file').forEach((btn) =>
    btn.addEventListener('click', () => {
      const [p, line] = btn.dataset.file.split(':');
      ctx.openFile?.(p, line);
    }),
  );
  node.querySelector('.g-action')?.addEventListener('click', () => {
    if (!live) return;
    const text = action.reply || action.label;
    if (action.draft) ctx.draft?.(text);
    else ctx.reply?.(text);
  });
  return node;
};

R.checklist = (b) =>
  el(`
    <div class="b-check card">
      ${b.title ? `<h3 class="b-title">${esc(b.title)}</h3>` : ''}
      <ul>${(b.items || []).map((it, i) => `<li class="${it.done ? 'done' : ''}" style="--k:${i}"><span class="box">${icon('check')}</span><span>${inlineMd(it.text || '')}</span></li>`).join('')}</ul>
    </div>`);

R.callout = (b) => {
  const tone = ['info', 'success', 'warn', 'danger'].includes(b.tone) ? b.tone : 'info';
  const ic = { info: 'info', success: 'check', warn: 'warn', danger: 'x' }[tone];
  return el(`<div class="b-callout tone-${tone}"><span class="ic">${icon(ic)}</span><div>${b.title ? `<b>${esc(b.title)}</b>` : ''}<div class="prose">${md(b.text || '')}</div></div></div>`);
};

R.image = (b, ctx) => {
  const src = /^https?:/.test(b.src || '') ? b.src : ctx.fileUrl(b.path || b.src || '');
  const node = el(`<figure class="b-image card"><img loading="lazy" alt="${esc(b.caption || b.path || '')}">${b.caption ? `<figcaption>${inlineMd(b.caption)}</figcaption>` : ''}</figure>`);
  const img = node.querySelector('img');
  img.src = src;
  img.addEventListener('click', () => ctx.zoom(src, img.alt));
  img.addEventListener('error', () => node.classList.add('broken'));
  return node;
};

R.question = (b, ctx) => {
  const answered = !ctx.isLatest;
  const node = el(`
    <div class="b-question ${answered ? 'answered' : ''}">
      <div class="q-head">${icon('ask')}<span>${answered ? 'Agent asked' : 'Needs your call'}</span></div>
      <p class="q-text">${inlineMd(b.question || '')}</p>
      <div class="q-opts">${(b.options || [])
        .map((o, i) => {
          const opt = typeof o === 'string' ? { label: o } : o;
          return `<button class="opt" data-i="${i}" ${answered ? 'disabled' : ''}><span class="k">${i + 1}</span>${esc(opt.label)}${opt.detail ? `<small>${esc(opt.detail)}</small>` : ''}</button>`;
        })
        .join('')}${answered ? '' : `<button class="opt own">${icon('pen')}Answer in my own words</button>`}</div>
    </div>`);
  node.addEventListener('click', (e) => {
    const btn = e.target.closest('.opt');
    if (!btn || answered) return;
    if (btn.classList.contains('own')) return ctx.draft('');
    const o = b.options[btn.dataset.i];
    ctx.reply(typeof o === 'string' ? o : o.reply || o.label);
  });
  return node;
};

// What the turn's permissions refused. On the latest turn: Allow & retry (exactly these where the
// harness can scope a grant, else one follow-up in Full auto) or Deny.
R.blocked = (b, ctx) => {
  const items = (b.items || []).filter((i) => i && typeof i === 'object');
  const t = ctx.turn || {};
  const scoped = !!t.blocked?.length && t.blocked.every((i) => i.rule !== undefined);
  const open = ctx.isLatest && !t.approval && !!ctx.approve && ctx.session?.state !== 'running';
  const state = (a) => (a === 'allowed' ? `${icon('check')}Allowed and retried` : a === 'denied' ? `${icon('x')}Denied` : '');
  const node = el(`
    <div class="b-blocked ${open ? '' : 'resolved'}">
      <div class="q-head">${icon('lock')}<span>Blocked by permissions</span>${t.approval ? `<span class="bl-state">${state(t.approval)}</span>` : ''}</div>
      <ul class="bl-items">${items
        .map((i) => `<li><span class="bl-tool">${esc(i.tool || 'tool')}</span>${i.detail ? `<code>${esc(i.detail)}</code>` : ''}${i.why ? `<small>${inlineMd(i.why)}</small>` : ''}</li>`)
        .join('')}</ul>
      ${open ? `<div class="bl-foot">
        <button class="primary sm bl-allow">${icon('check')}Allow &amp; retry</button>
        <button class="ghost sm bl-deny">Deny</button>
        <span class="bl-note">${scoped ? 'Allows exactly these, for the retry only.' : 'This harness can’t allow single actions, so the retry runs in Full auto (that follow-up only).'}</span>
      </div>` : ''}
    </div>`);
  if (!open) return node;
  const decide = async (allow) => {
    // Instant: the card settles at once and goes back if the server says no.
    const foot = node.querySelector('.bl-foot');
    const head = node.querySelector('.q-head');
    const tag = el(`<span class="bl-state">${state(allow ? 'allowed' : 'denied')}</span>`);
    node.classList.add('resolved');
    foot.hidden = true;
    head.append(tag);
    try {
      await ctx.approve(allow);
    } catch {
      node.classList.remove('resolved');
      foot.hidden = false;
      tag.remove();
    }
  };
  node.querySelector('.bl-allow').onclick = () => {
    decide(true);
  };
  node.querySelector('.bl-deny').onclick = () => {
    decide(false);
  };
  return node;
};

R.actions = (b, ctx) => {
  const items = (b.items || []).map((it, i) => (typeof it === 'string' ? { label: it, command: it, _i: i } : { ...it, _i: i }));
  const node = el(`
    <div class="b-actions card">
      ${b.title ? `<h3 class="b-title">${icon('terminal')}${esc(b.title)}</h3>` : ''}
      <ul class="act-list">${items
        .map((it, i) => {
          const isCmd = !!it.command;
          const key = `act:${i}:${it.command || it.reply || it.label}`;
          const prev = isCmd && ctx.turn?.actionRuns?.[key];
          return `<li class="act-row ${it.tone ? `tone-${esc(it.tone)}` : ''}" style="--k:${i}" data-i="${i}" data-key="${esc(key)}">
            <div class="act-bar">
              <div class="act-info">
                <b>${esc(it.label || it.command || it.reply || 'Action')}</b>
                ${isCmd ? `<code class="act-cmd">$ ${esc(it.command)}</code>` : ''}
                ${it.detail || it.note ? `<span class="act-detail">${inlineMd(it.detail || it.note)}</span>` : ''}
              </div>
              <div class="act-side">
                <span class="act-badge">${prev ? `<span class="exit ${prev.exitCode === 0 ? 'ok' : 'bad'}">exit ${esc(prev.exitCode)}</span>` : ''}</span>
                <button class="ghost xs act-go">${icon(isCmd ? (prev ? 'rerun' : 'play') : 'send')}<span>${isCmd ? (prev ? 'Run again' : 'Run') : 'Send'}</span></button>
              </div>
            </div>
            <div class="act-slot" ${prev ? '' : 'hidden'}></div>
          </li>`;
        })
        .join('')}</ul>
    </div>`);

  const paintResult = (li, it, res) => {
    if (!res) return;
    const badge = li.querySelector('.act-badge');
    const ok = res.exitCode === 0;
    badge.innerHTML = `<span class="exit ${ok ? 'ok' : 'bad'}">exit ${esc(res.exitCode)}</span>${res.durationMs ? `<span class="muted xs">${fmtDuration(res.durationMs)}</span>` : ''}`;
    const slot = li.querySelector('.act-slot');
    slot.hidden = false;
    slot.innerHTML = `
      <div class="act-res ${ok ? 'ok' : 'bad'}">
        <pre class="act-out">${esc(res.output || '(no output)')}</pre>
        ${!ok && ctx.reply ? `<button class="link xs act-fix">${icon('send')}Send failure to agent</button>` : ''}
      </div>`;
    slot.querySelector('.act-fix')?.addEventListener('click', () => {
      ctx.reply(`Command \`${it.command}\` failed (exit ${res.exitCode}):\n\`\`\`\n${(res.output || '').slice(0, 1600)}\n\`\`\``);
    });
  };

  items.forEach((it, i) => {
    const key = `act:${i}:${it.command || it.reply || it.label}`;
    const prev = it.command && ctx.turn?.actionRuns?.[key];
    if (prev) paintResult(node.querySelector(`li[data-i="${i}"]`), it, prev);
  });

  node.addEventListener('click', async (e) => {
    const btn = e.target.closest('.act-go');
    if (!btn) return;
    const li = btn.closest('li.act-row');
    const it = items[Number(li.dataset.i)];
    if (!it) return;
    if (!it.command) {
      return ctx.reply?.(it.reply || it.label);
    }
    if (it.confirm && !confirm(`Run this command in ${ctx.session?.cwd || 'the project'}?\n\n$ ${it.command}`)) return;
    if (!ctx.exec) return;
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Running…';
    try {
      const res = await ctx.exec(it.command, li.dataset.key);
      if (res) paintResult(li, it, res);
    } finally {
      btn.disabled = false;
      btn.querySelector('span').textContent = 'Run again';
    }
  });
  return node;
};

R.next = (b, ctx) => {
  const node = el(`
    <div class="b-next">
      <div class="next-label">${icon('spark')}Follow up</div>
      <div class="chips">${(b.items || []).map((t, i) => `<button class="chip" style="--k:${i}" data-i="${i}">${esc(typeof t === 'string' ? t : t.label)}</button>`).join('')}</div>
    </div>`);
  node.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const t = b.items[chip.dataset.i];
    const text = typeof t === 'string' ? t : t.reply || t.label;
    if (e.metaKey || e.ctrlKey) ctx.reply(text);
    else ctx.draft(text);
  });
  return node;
};

R.unknown = (b) => el(`<div class="b-code card"><div class="code-head"><span class="lang">unknown block · ${esc(b.type)}</span></div><pre class="code"><code>${esc(JSON.stringify(b, null, 2))}</code></pre></div>`);

// --- public -----------------------------------------------------------------

// Block types defined elsewhere: spells (features/spells.js) register the `spell` block and draw
// the types spells add through the fallback, before R.unknown.
export const registerBlock = (type, fn) => (R[type] = fn);
let fallback = () => null;
export const setBlockFallback = (fn) => (fallback = fn);

export function renderPresentation(presentation, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'presentation';
  const blocks = presentation?.blocks || [];
  // A turn's result reveals itself the first time it's shown; opening it again just shows it.
  const own = presentation && ctx?.session?.id && ctx.turn?.id && presentation === ctx.turn.presentation;
  still = !!own && !firstShow(`${ctx.session.id}:${ctx.turn.id}`);
  if (still) wrap.classList.add('still');
  // Group consecutive half-width-friendly blocks? Keep it a single calm column.
  blocks.forEach((b, i) => {
    const delay = quiet() ? 0 : Math.min(i, 10) * 110;
    let node;
    try {
      node = R[b.type] ? R[b.type](b, { ...ctx, delay }) : fallback(b, { ...ctx, delay }) || R.unknown(b);
    } catch (err) {
      console.error('block failed', b, err);
      node = R.unknown(b);
    }
    const holder = document.createElement('div');
    holder.className = `blk blk-${b.type}`;
    holder.style.setProperty('--d', `${delay}ms`);
    holder.append(node);
    wrap.append(holder);
  });
  still = false;
  if (presentation?.fallback) {
    wrap.prepend(el(`<div class="blk"><div class="fallback-note">${icon('info')} The agent answered in plain text instead of a wisp presentation.</div></div>`));
  }
  return wrap;
}

export function fmtDuration(ms) {
  if (!ms && ms !== 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 1) return `${ms}ms`;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export async function copy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    btn?.classList.add('copied');
    setTimeout(() => btn?.classList.remove('copied'), 1200);
  } catch {}
}

export { el, pathHtml, countChanges };
