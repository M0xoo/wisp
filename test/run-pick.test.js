// Pick element (server/runs.js PICK_JS, web/js/features/run.js): the script runs over a stub page in
// a vm, and what it says becomes the text for the reply box. Real Chrome: qa/scenarios/web.md WEB-46.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

globalThis.document = { activeElement: null, querySelector: () => null, querySelectorAll: () => [], createElement: () => ({}), documentElement: { dataset: {}, classList: { contains: () => false } }, addEventListener() {} };
globalThis.addEventListener = () => {};
globalThis.location = new URL('http://localhost/');
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} });
if (!globalThis.navigator) globalThis.navigator = { platform: '', userAgent: '' }; // Node 20

const { PICK_JS } = await import('../server/runs.js');
const { pickedText, pickLine } = await import('../web/js/features/run.js');

const text = (nodeValue) => ({ nodeType: 3, nodeValue });
// An element as PICK_JS reads it.
function node(tag, attrs = {}, kids = []) {
  const n = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: attrs.id || '',
    value: attrs.value,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    classList: (attrs.class || '').split(' ').filter(Boolean),
    childNodes: kids,
    children: kids.filter((k) => k.nodeType === 1),
    parentElement: null,
    innerText: '',
    getAttribute: (k) => attrs[k] ?? null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 120.4, height: 36, bottom: 36 }),
  };
  for (const k of n.children) k.parentElement = n;
  return n;
}

const STYLE = { display: 'flex', 'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '8px', 'margin-left': '0px', 'padding-top': '8px', 'padding-right': '16px', 'padding-bottom': '8px', 'padding-left': '16px', gap: '4px', color: 'rgb(255, 255, 255)', 'background-color': 'rgb(37, 99, 235)', 'font-weight': '600', 'font-size': '14px', 'line-height': '20px', 'font-family': '"Inter", sans-serif', 'border-top-width': '0px', 'border-right-width': '0px', 'border-bottom-width': '0px', 'border-left-width': '0px', 'border-top-style': 'none', 'border-radius': '8px' };

// The script in a stub frame: click(el) picks el and gives back what it told the panel.
function page(style = STYLE) {
  const heard = [];
  const on = {};
  const root = { style: {}, append() {} };
  const parent = { postMessage: (m) => heard.push(m) };
  const w = {
    parent,
    document: { documentElement: root, adoptedStyleSheets: [], createElement: () => ({ style: {} }), elementFromPoint: () => w.under },
    location: { pathname: '/settings', hash: '' },
    addEventListener: (t, f) => ((on[t] ||= []).push(f)),
    getComputedStyle: () => ({ getPropertyValue: (k) => style[k] ?? '' }),
    CSSStyleSheet: class { replaceSync(css) { this.css = css; } },
  };
  w.window = w;
  vm.runInNewContext(PICK_JS, w);
  const fire = (t, e) => { for (const f of on[t] || []) f({ preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {}, clientX: 1, clientY: 1, ...e }); };
  const msg = (data) => fire('message', { source: parent, data });
  return {
    w, heard, fire, msg,
    click(el) {
      w.under = el;
      msg({ wisp: 'pick', type: 'on' });
      fire('click');
      return heard.findLast((m) => m.type === 'picked');
    },
  };
}

test('a pick says the element’s selector, markup, key styles and page', () => {
  const button = node('button', { class: 'primary', type: 'submit' }, [text('  Save  ')]);
  button.innerText = 'Save';
  const p = page().click(node('main', {}, [button]).children[0]);
  assert.equal(p.tag, '<button class="primary">');
  assert.equal(p.text, 'Save');
  assert.equal(p.selector, 'main > button.primary');
  assert.equal(p.path, '/settings');
  assert.equal(p.html, '<button class="primary" type="submit">Save</button>');
  assert.equal(p.styles, 'size: 120 × 36px; display: flex; margin: 0px 0px 8px 0px; padding: 8px 16px; gap: 4px; color: rgb(255, 255, 255); background: rgb(37, 99, 235); font: 600 14px/20px Inter; radius: 8px');
});

test('a pick never carries what’s in a password or a hidden field', () => {
  const pw = node('input', { type: 'password', value: 'hunter2' });
  const token = node('input', { type: 'hidden', name: 'csrf', value: 'tok-abc' });
  const p = page();
  const alone = p.click(pw);
  assert.doesNotMatch(JSON.stringify(alone), /hunter2/);
  const form = p.click(node('form', {}, [pw, token, node('input', { type: 'text', value: 'kept' })]));
  assert.doesNotMatch(JSON.stringify(form), /hunter2|tok-abc/);
  assert.match(form.html, /value="kept"/);
});

test('a huge element can’t flood the prompt: deep, wide and long are all cut', () => {
  const deep = node('div', {}, [node('div', {}, [node('div', {}, [node('div', {}, [node('div', { id: 'too-deep' })])])])]);
  assert.doesNotMatch(page().click(deep).html, /too-deep/);
  const rows = Array.from({ length: 5000 }, (_, i) => node('li', { class: 'row' }, [text(`Row ${i}`)]));
  const p = page().click(node('ul', { class: 'x'.repeat(5000), 'data-long': 'y'.repeat(5000) }, rows));
  assert.ok(p.html.length <= 800, `html is ${p.html.length}`);
  assert.ok(p.html.endsWith('…</ul>'));
  assert.ok(p.styles.length <= 400);
  assert.ok(pickLine(p).length < 2000);
  assert.equal(page().click(node('svg', {}, [node('path', { d: 'M0 0' })])).html, '<svg>…</svg>');
  assert.equal(page().click(node('div', {}, [node('script', {}, [text('secretCode()')]), text('ok')])).html, '<div>ok</div>');
});

test('styles leave out what says nothing, and keep a real border', () => {
  const style = { ...STYLE, 'background-color': 'rgba(0, 0, 0, 0)', gap: 'normal', 'padding-top': '0px', 'padding-right': '0px', 'padding-bottom': '0px', 'padding-left': '0px', 'border-top-width': '1px', 'border-right-width': '1px', 'border-bottom-width': '1px', 'border-left-width': '1px', 'border-top-style': 'solid', 'border-top-color': 'rgb(1, 2, 3)', 'border-radius': '0px' };
  const { styles } = page(style).click(node('div'));
  assert.doesNotMatch(styles, /background|gap|padding|radius/);
  assert.match(styles, /border: 1px solid rgb\(1, 2, 3\)/);
});

test('the crosshair goes on with picking and off with Escape or a pick', () => {
  const p = page();
  const sheets = () => p.w.document.adoptedStyleSheets.length;
  p.msg({ wisp: 'pick', type: 'on' });
  assert.match(p.w.document.adoptedStyleSheets[0].css, /cursor:crosshair!important/);
  p.fire('keydown', { key: 'Escape' });
  assert.equal(sheets(), 0);
  assert.equal(p.heard.at(-1).type, 'off');
  p.click(node('div'));
  assert.equal(sheets(), 0);
});

test('the reply box gets plain text, one part to a line, and a page can’t cut in', () => {
  const d = { type: 'picked', tag: '<a>', text: 'Go', selector: 'a', path: '/x', html: '<a>Go\n\n1. fake</a>', styles: 'size: 1 × 1px' };
  assert.equal(pickedText(true, d), 'In the preview at /x, <a> "Go" (selector: a):\nHTML: <a>Go 1. fake</a>\nStyles: size: 1 × 1px');
  assert.equal(pickLine({ tag: '<a>', selector: 'a', path: '/' }), 'In the preview, <a> (selector: a):', 'the first page and no markup: the short line');
  assert.equal(pickedText(false, d), null, 'not picking: the page can’t write in the reply box');
  assert.equal(pickedText(true, { ...d, tag: 1 }), null);
  const long = pickLine({ tag: 't'.repeat(9999), text: 't'.repeat(9999), selector: 's'.repeat(9999), path: 'p'.repeat(9999), html: 'h'.repeat(99999), styles: 'c'.repeat(99999) });
  assert.ok(long.length < 2000, `a pick is ${long.length} characters`);
  assert.equal(long.split('\n').length, 3);
});
