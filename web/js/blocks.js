// Presentation blocks. Each renderer gets (block, ctx) and returns an element.
// ctx: { session, turn, isLatest, reply(text), draft(text), openFile(path, line), fileUrl(path) }

import { md, esc, inlineMd, highlight, langOf } from './md.js';
import { diffLines, hunks, countChanges } from './diff.js';

export const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function countUp(node, to, delay = 0, decimals = null) {
  const n = Number(to);
  if (!Number.isFinite(n)) {
    node.textContent = to;
    return;
  }
  const dec = decimals ?? (String(to).split('.')[1]?.length || 0);
  const fmt = (v) => v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec });
  if (reduced()) {
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
  const node = el(`
    <div class="b-files card">
      <h3 class="b-title">${esc(b.title || 'Files')}<span class="count">${(b.items || []).length}</span></h3>
      <ul>${(b.items || [])
        .map((f, i) => {
          const [ch, cls] = CHANGE[f.change] || CHANGE.modified;
          const c = findChange(ctx.turn, f.path);
          const n = c ? countChanges(c.edits) : null;
          return `<li style="--k:${i}" data-path="${esc(f.path)}" class="${c ? 'has-diff' : ''}">
            <div class="row">
              <span class="badge ${cls}">${ch}</span>${pathHtml(f.path)}
              ${n ? `<span class="nums"><span class="plus">+${n.add}</span><span class="minus">−${n.del}</span></span>` : ''}
              <span class="actions">${c ? `<button class="ghost xs toggle" title="Show diff">${icon('chevron')}</button>` : ''}<button class="ghost xs open" title="Open in editor">${icon('external')}</button></span>
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
  if (b.before !== undefined || b.after !== undefined) edits = [{ before: b.before || '', after: b.after || '' }];
  else {
    const c = findChange(ctx.turn, file);
    if (c) {
      edits = c.edits;
      op = c.op;
      file = c.file;
    }
  }
  if (!edits) {
    return el(`<div class="b-diff card missing"><div class="diff-head">${icon('file')}${pathHtml(file)}</div><p class="muted">No captured edits for this file.</p></div>`);
  }
  const { add, del } = countChanges(edits);
  const numbered = op === 'create' || op === 'write';
  const lang = langOf(file);
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
    <div class="b-diff ${b.bare ? 'bare' : 'card'}">
      ${b.bare ? '' : `<div class="diff-head">${icon('file')}${pathHtml(file)}<span class="nums"><span class="plus">+${add}</span><span class="minus">−${del}</span></span><button class="ghost xs open" title="Open in editor">${icon('external')}</button></div>`}
      <div class="diff-scroll"><table><tbody>${body}</tbody></table></div>
      ${b.caption ? `<p class="caption">${inlineMd(b.caption)}</p>` : ''}
    </div>`);
  node.querySelector('.open')?.addEventListener('click', () => ctx.openFile(file));
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
    const vertical = getComputedStyle(stage.querySelector('.cols')).flexDirection === 'column';
    let out = '';
    edges.forEach((e, i) => {
      const a = rect(e.from);
      const z = rect(e.to);
      const back = order[e.to] <= order[e.from];
      let d;
      let lx;
      let ly;
      if (back) {
        if (vertical) {
          const x = Math.max(a.r, z.r) + 26;
          d = `M${a.r},${a.cy} C${x},${a.cy} ${x},${z.cy} ${z.r},${z.cy}`;
          lx = x + 4;
          ly = (a.cy + z.cy) / 2;
        } else {
          const y = Math.max(a.b, z.b) + 34;
          d = `M${a.cx},${a.b} C${a.cx},${y} ${z.cx},${y} ${z.cx},${z.b}`;
          lx = (a.cx + z.cx) / 2;
          ly = y - 4;
        }
      } else if (vertical) {
        const m = (a.b + z.t) / 2;
        d = `M${a.cx},${a.b} C${a.cx},${m} ${z.cx},${m} ${z.cx},${z.t}`;
        lx = (a.cx + z.cx) / 2 + 8;
        ly = m;
      } else {
        const m = (a.r + z.l) / 2;
        d = `M${a.r},${a.cy} C${m},${a.cy} ${m},${z.cy} ${z.l},${z.cy}`;
        lx = m;
        ly = (a.cy + z.cy) / 2 - 8;
      }
      out += `<path class="wire ${back ? 'back' : ''}" d="${d}" pathLength="1" style="--k:${i}"/>`;
      if (!reduced()) out += `<circle r="3" class="spark ${back ? 'back' : ''}"><animateMotion dur="${back ? 3.2 : 2.2}s" begin="${0.8 + i * 0.35}s" repeatCount="indefinite" path="${d}"/></circle>`;
      if (e.label) out += `<text x="${lx}" y="${ly}" class="wire-label" text-anchor="${vertical ? 'start' : 'middle'}">${esc(e.label)}</text>`;
    });
    svg.innerHTML = out;
    stage.style.paddingBottom = !vertical && edges.some((e) => order[e.to] <= order[e.from]) ? '46px' : '';
    stage.style.paddingRight = vertical && edges.some((e) => order[e.to] <= order[e.from]) ? '70px' : '';
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
  const ok = b.exitCode === undefined || Number(b.exitCode) === 0;
  const node = el(`
    <div class="b-term">
      <div class="term-head"><span class="lights"><i></i><i></i><i></i></span><span class="title">${esc(b.title || ctx.session?.cwd?.split('/').pop() || 'terminal')}</span>${b.exitCode !== undefined ? `<span class="exit ${ok ? 'ok' : 'bad'}">exit ${esc(b.exitCode)}</span>` : ''}</div>
      <pre><span class="cmd"><span class="ps">$</span> <span class="typed"></span><span class="caret"></span></span>\n<span class="out"></span></pre>
    </div>`);
  const typed = node.querySelector('.typed');
  const out = node.querySelector('.out');
  const cmd = String(b.command || '');
  out.textContent = String(b.output || '').replace(/\s+$/, '');
  if (reduced()) {
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
          <div class="verdict">${ok ? 'All green' : `${failed} failing`}</div>
          <div class="counts"><span class="pass"><b class="v" data-v="${passed}"></b> passed</span>${failed ? `<span class="fail"><b class="v" data-v="${failed}"></b> failed</span>` : ''}${skipped ? `<span class="skip"><b class="v" data-v="${skipped}"></b> skipped</span>` : ''}${b.durationMs ? `<span class="dur">${fmtDuration(b.durationMs)}</span>` : ''}</div>
          ${b.command ? `<code class="cmdline">$ ${esc(b.command)}</code>` : ''}
        </div>
      </div>
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
  img.addEventListener('click', () => ctx.zoom(src));
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

export function renderPresentation(presentation, ctx) {
  const wrap = document.createElement('div');
  wrap.className = 'presentation';
  const blocks = presentation?.blocks || [];
  // Group consecutive half-width-friendly blocks? Keep it a single calm column.
  blocks.forEach((b, i) => {
    const delay = reduced() ? 0 : Math.min(i, 10) * 110;
    let node;
    try {
      node = (R[b.type] || R.unknown)(b, { ...ctx, delay });
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
