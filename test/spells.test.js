// Spells: validation, the store, the settings overlay, the API, hooks, agent blocks and a whole
// Cast a spell task through a real wisp server with the fake harnesses.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { installFakeBins, makeRepo, records, tmp, until } from './helpers.js';

const RECORD = tmp('spells-record');
process.env.FAKE_RECORD = RECORD;
process.env.WISP_HOME = tmp('spells-home');
process.env.WISP_UPDATE_CHECK = '0';
process.env.WISP_NO_OPEN = '1';
process.env.WISP_RETRO_IDLE_MS = '600000';
process.env.FAKE_GH_STATE = path.join(tmp('spells-gh'), 'state.json');
installFakeBins();

const { normalizeSpell, describeSpell, overlayDefaults, Spells, scopeMatches } = await import('../server/spells.js');
const { SPELL_EXAMPLES, spellReference } = await import('../server/spell-guide.js');
const { systemPrompt, parsePresentation } = await import('../server/protocol.js');
const { blocksToMarkdown } = await import('../server/render.js');
const schema = await import('../web/js/spell-schema.js');
const { startServer } = await import('../server/index.js');

const problems = (raw) => {
  try {
    normalizeSpell(raw);
    return [];
  } catch (err) {
    return err.problems || [err.message];
  }
};
const base0 = { wispSpell: 1, id: 'x', name: 'X' };

// --- validation ------------------------------------------------------------------------------

test('every worked example in the agent reference is a valid spell', () => {
  for (const ex of SPELL_EXAMPLES) assert.deepEqual(problems(ex.spell), [], ex.ask);
  assert.ok(spellReference().slots.float);
});

test('normalizing is idempotent: a stored spell loads back the same', () => {
  const fnSpell = {
    ...base0, data: { s: { wisp: '/sessions' } }, script: 'export function n({ s }) { return s.length; }\nexport function links({ s }) { return []; }',
    buttons: [{ slot: 'float', label: 'N', badge: { fn: 'n', with: ['s'] }, do: { openAll: { fn: 'links', with: ['s'] } } }],
    chips: [{ slot: 'card.head', fn: 'n', with: ['s'] }],
  };
  for (const ex of [...SPELL_EXAMPLES, { ask: 'fn sources', spell: fnSpell }]) {
    const a = normalizeSpell(ex.spell).spell;
    assert.deepEqual(normalizeSpell(a).spell, a, ex.ask);
  }
});

test('spells are refused for what they may not do, with every problem listed', () => {
  const p = problems({
    wispSpell: 1,
    id: 'Bad Id',
    data: { m: { gh: ['pr', 'merge', '1'] }, a: { gh: ['api', 'repos/x', '-X', 'POST'] }, r: { wisp: '/remote' }, i: { wisp: '/internal/ask/1' } },
    parts: { card: { style: { background: 'url(https://evil.example/x.png)', color: 'red; display:none' } }, 'ask.question': { style: { color: 'red' } } },
    ui: { hide: ['approval'], tokens: { '--nope': '#fff' } },
    settings: { telemetry: 'off' },
    buttons: [{ slot: 'nowhere', label: 'x', do: { open: 'javascript:alert(1)' } }, { slot: 'topbar', label: 'y', do: { panel: 'missing' } }],
    blocks: [{ type: 'hero', doc: 'x', render: 'r' }],
    slash: [{ name: 'btw', do: { send: 'x' } }],
    hooks: [{ on: 'turn.finished', do: { exec: 'rm -rf /' } }],
    script: 'export function f( {',
  });
  const has = (re) => assert.ok(p.some((x) => re.test(x)), `expected a problem matching ${re}\n${p.join('\n')}`);
  has(/^id:/);
  has(/^name:/);
  has(/data\.m: gh pr merge isn't allowed/);
  has(/data\.a: gh api may only read/);
  has(/data\.r: \/remote isn't readable/);
  has(/data\.i: \/internal/);
  has(/parts\.card: background: value not allowed/);
  has(/parts\.card: color: value not allowed/);
  has(/parts\.ask\.question: not a part/);
  has(/ui\.hide: approval isn't a part/);
  has(/--nope isn't a token/);
  has(/settings\.telemetry: not a setting/);
  has(/buttons\[0\]: slot must be/);
  has(/buttons\[0\]: open needs an http\(s\) URL/);
  has(/buttons\[1\]: no panel named missing/);
  has(/blocks\[0\]: hero is a built-in block/);
  has(/slash\[0\]: \/btw is built in/);
  has(/hooks\[0\]: a hook can only/);
  has(/script: doesn't compile/);
});

test('theme: the theme setting takes system, light or dark, and its icons exist', () => {
  for (const theme of ['system', 'light', 'dark']) assert.deepEqual(problems({ ...base0, settings: { theme } }), []);
  assert.deepEqual(spellReference().settings.theme, ['system', 'light', 'dark']);
  const p = problems({ ...base0, settings: { theme: 'sepia' } });
  assert.ok(p.some((x) => /settings\.theme/.test(x) && /system \| light \| dark/.test(x)), p.join('\n'));
  assert.deepEqual(problems({ ...base0, buttons: [{ slot: 'topbar', icon: 'moon', do: { copy: 'x' } }, { slot: 'topbar', icon: 'sun', do: { copy: 'x' } }] }), []);
});

test('the overlap pill and warning (another open task changes the same files) are parts spells can restyle or hide', () => {
  assert.deepEqual(problems({ ...base0, parts: { 'card.overlap': { hide: true }, 'card.overlapNote': { style: { borderRadius: '4px' } } } }), []);
  assert.deepEqual(problems({ ...base0, ui: { hide: ['card.overlap', 'card.overlapNote'] } }), []);
  const p = problems({ ...base0, parts: { 'card.overlaps': { hide: true } } });
  assert.ok(p.some((x) => /card\.overlaps/.test(x)), p.join('\n'));
});

test('the follow-up box’s Delegate button and the Delegate popover are parts spells can restyle or hide', () => {
  assert.deepEqual(problems({ ...base0, parts: { 'composer.team': { hide: true } } }), []);
  // The Delegate popover: its lead strip and the delegates' place chips can be restyled or hidden.
  assert.deepEqual(problems({ ...base0, parts: { 'delegate.lead': { hide: true }, 'delegate.place': { style: { color: 'red' } }, 'delegate.panel': { style: { color: 'red' } }, 'delegate.live': { style: { color: 'red' } }, 'delegate.open': { hide: true }, 'task.from': { hide: true } } }), []);
  assert.deepEqual(normalizeSpell({ ...base0, parts: { 'composer.team': { style: { color: 'red' } } } }).spell.parts['composer.team'].style, { color: 'red' });
});

test('the layout switch is gone: a spell that still sets settings.view loads, with a warning', () => {
  for (const view of ['feed', 'split', 'grid']) {
    const out = normalizeSpell({ ...base0, settings: { view, theme: 'dark' } });
    assert.deepEqual(out.spell.settings, { theme: 'dark' });
    assert.ok(out.warnings.some((w) => /settings\.view/.test(w) && /only layout/.test(w)), out.warnings.join('\n'));
  }
});

test('split view: sidebar and split slots, parts and pixel props', () => {
  const ok = {
    ...base0,
    parts: {
      sidebar: { props: { width: 420, side: 'right', details: 'full' }, style: { background: '#fafafa' } },
      'split.main': { props: { readWidth: 1100 } },
      'split.home': { props: { greeting: 'Hi' } },
      tips: { props: { count: 5 }, style: { fontSize: '12px' } },
      'split.title': { style: { fontSize: '22px' } },
      'split.details': { props: { width: 280 }, style: { fontSize: '12px' } },
      'split.pr': { style: { borderRadius: '6px' } },
      'split.back': { style: { color: 'red' } },
      'split.feedback': { style: { color: 'red' } },
    },
    ui: { hide: ['sidebar.new', 'topbar.view', 'sidebar.foot', 'sidebar.nav', 'sidebar.account', 'split.actions', 'topbar.account', 'account.menu', 'split.feedback'] },
    buttons: [
      { slot: 'sidebar.top', icon: 'github', do: { open: 'https://github.com/pulls' } },
      { slot: 'split.head', label: 'PR', when: { hasPr: true }, do: { open: '{pr.url}' } },
      { slot: 'split.details', icon: 'copy', label: 'Branch', do: { copy: '{branch}' } },
    ],
  };
  assert.deepEqual(problems(ok), []);
  assert.deepEqual(normalizeSpell(ok).spell.parts.sidebar.props, { width: 420, side: 'right', details: 'full' });
  assert.deepEqual(normalizeSpell(ok).spell.parts['split.details'].props, { width: 280 });
  assert.ok(schema.SLOTS['sidebar.top'] && schema.CARD_SLOTS.has('split.head') && schema.CARD_SLOTS.has('split.details'));
  assert.ok(!('view' in spellReference().settings));
  const p = problems({ ...base0, parts: { sidebar: { props: { width: 40, side: 'top' } }, 'split.main': { props: { readWidth: 5000 } }, 'split.details': { props: { width: 90, side: 'left' } } } });
  assert.ok(p.some((x) => /width: px from 160 to 1600/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /readWidth: px from 160 to 1600/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /side: left \| right/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /split\.details.*width: px from 160 to 1600/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /split\.details.*side/.test(x)), p.join('\n'));
  // the details slot takes buttons, not panels
  assert.ok(problems({ ...base0, buttons: [{ slot: 'split.details', panel: 'x' }] }).length);
  // int props keep their 1–40 range
  assert.ok(problems({ ...base0, parts: { 'card.sub': { props: { lines: 41 } } } }).some((x) => /lines: int from 1 to 40/.test(x)));
  // the tips under the prompt box: hide them, or show more or fewer
  assert.deepEqual(problems({ ...base0, ui: { hide: ['tips'] } }), []);
  assert.deepEqual(problems({ ...base0, ui: { hide: ['tips.setup'] }, parts: { 'tips.setup': { style: { borderRadius: '8px' } } } }), []);
  assert.deepEqual(problems({ ...base0, ui: { hide: ['tips.tools', 'tips.grid'] } }), []);
  assert.ok(problems({ ...base0, parts: { tips: { props: { count: 0 } } } }).some((x) => /count: int from 1 to 40/.test(x)));
});

test('the phone app\'s row swipes are card props, and their band is a part', () => {
  assert.deepEqual(problems({ ...base0, parts: { card: { props: { swipeRight: 'later', swipeLeft: 'archive' } }, 'card.swipe': { style: { borderRadius: '0' } } } }), []);
  assert.deepEqual(problems({ ...base0, parts: { card: { props: { swipeLeft: 'off' } } } }), []);
  const p = problems({ ...base0, parts: { card: { props: { swipeLeft: 'nuke' } } } });
  assert.ok(p.some((x) => /swipeLeft: done \| later \| archive \| delete \| off/.test(x)), p.join('\n'));
});

test('toasts, their glyph, action, timer ring and Clear all are parts', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['toast.timer', 'toast.glyph', 'toast.clear'] }, parts: { toast: { style: { borderRadius: '6px' } }, 'toast.action': { style: { fontWeight: '700' } } } }), []);
  assert.ok(problems({ ...base0, ui: { hide: ['toast.close'] } }).length);
});

test('accounts: the picker row, the button part, the details initial and the Settings list are parts', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['picker.accounts', 'runner.account', 'details.account', 'settings.accounts'] } }), []);
  assert.deepEqual(problems({ ...base0, parts: { 'runner.account': { style: { color: 'red' } }, 'settings.accounts': { style: { borderRadius: '6px' } } } }), []);
  for (const part of ['picker.accounts', 'picker.thinking', 'runner.account', 'details.account', 'settings.accounts']) assert.ok(schema.PARTS[part], part);
  // A task's topics on its ⌘K row (wisp_tag): restyle or hide them.
  assert.deepEqual(problems({ ...base0, ui: { hide: ['palette.tags'] }, parts: { 'palette.tags': { style: { color: 'red' } } } }), []);
  // Connectors: restyle or hide the pane, its rows and the import offer; never add one (they run commands).
  assert.deepEqual(problems({ ...base0, ui: { hide: ['connectors.import'] }, parts: { 'connectors.row': { style: { borderRadius: '6px' } }, 'settings.connectors': { style: { color: 'red' } } } }), []);
  assert.ok(schema.ICONS.includes('plug'));
  assert.ok(!Object.keys(schema.SETTINGS).some((k) => /connector/i.test(k)), 'connectors carry secrets: not a spell setting');
  assert.ok(problems({ ...base0, ui: { hide: ['picker.account'] } }).some((x) => /picker\.account/.test(x)));
});

test('Auto\'s preview: the chip, its popover, the alternatives and suggestion, and Settings → Auto\'s sources and rules are parts', () => {
  const parts = ['launcher.autoPreview', 'autoPreview.panel', 'autoPreview.alternatives', 'autoPreview.suggest', 'router.sources', 'router.rules'];
  for (const part of parts) assert.ok(schema.PARTS[part], part);
  assert.deepEqual(problems({ ...base0, ui: { hide: parts } }), []);
  assert.deepEqual(problems({ ...base0, parts: { 'launcher.autoPreview': { style: { borderRadius: '6px' } }, 'autoPreview.panel': { style: { fontSize: '13px' } } } }), []);
  assert.ok(problems({ ...base0, ui: { hide: ['launcher.autopreview'] } }).some((x) => /launcher\.autopreview/.test(x)));
});

test('forks: a fork button acts on the card\'s task, its chips, turn button and start line are parts', () => {
  assert.deepEqual(problems({ ...base0, buttons: [{ slot: 'card.menu', icon: 'fork', label: 'Try with Codex', do: { fork: { prompt: 'Try it another way', agent: 'codex', mode: 'plan' } } }] }), []);
  assert.ok(problems({ ...base0, buttons: [{ slot: 'card.menu', label: 'x', do: { fork: { agent: 'codex' } } }] }).some((x) => /fork needs a prompt: what the fork should try/.test(x)));
  assert.ok(problems({ ...base0, buttons: [{ slot: 'card.menu', label: 'x', do: { fork: { prompt: 'p', mode: 'yolo' } } }] }).some((x) => /mode must be plan, edits or auto/.test(x)));
  assert.deepEqual(problems({ ...base0, ui: { hide: ['turn.fork', 'turn.forkStart'] }, parts: { 'card.forkedFrom': { style: { color: 'red' } }, 'card.forks': { style: { fontWeight: '700' } } } }), []);
  assert.ok(schema.ICONS.includes('fork'));
});

test('the usage-limit card under a turn\'s hero is not a part: it asks you something', () => {
  assert.equal(schema.PARTS['turn.limit'], undefined, 'a limit asks you what next: never a part a spell could hide');
});

test('every task-list section and its folding heading are parts', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['section.needs', 'section.working'] }, parts: { 'section.heading': { style: { fontSize: '13px' } } } }), []);
  assert.ok(problems({ ...base0, ui: { hide: ['section.waiting'] } }).length);
});

test('for later: the section and the row button are parts; forLater is a button action and a hook action', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['section.forLater', 'card.quickLater'] }, parts: { 'section.forLater': { style: { opacity: '0.9' } } } }), []);
  assert.deepEqual(problems({ ...base0, buttons: [{ slot: 'card.menu', label: 'Park', icon: 'bookmark', do: { forLater: true } }], hooks: [{ on: 'turn.finished', if: { testsFailed: false }, do: { forLater: true } }] }), []);
  assert.ok(problems({ ...base0, ui: { hide: ['section.later'] } }).some((x) => /section\.later isn't a part/.test(x)));
  assert.ok(problems({ ...base0, buttons: [{ slot: 'card.menu', label: 'Park', icon: 'flag', do: { forLater: true } }] }).some((x) => /icon/.test(x)));
});

test('later: Scheduled, Coming up, the follow-up rows, Send later and the time chip are parts; Coming up takes buttons and a count; readTimes is a setting', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['section.scheduled', 'split.upcoming', 'card.later', 'composer.sendLater', 'launcher.later'] }, parts: { 'composer.later': { style: { fontSize: '12px' } }, 'scheduled.row': { style: { opacity: '0.8' } }, 'split.upcoming': { props: { count: 8 } } } }), []);
  assert.deepEqual(problems({ ...base0, buttons: [{ slot: 'split.upcoming', label: 'All', do: { open: 'https://example.com' } }] }), []);
  assert.ok(problems({ ...base0, parts: { 'split.upcoming': { props: { count: 41 } } } }).some((x) => /count: int from 1 to 40/.test(x)));
  // The crew's folded row and how many full rows it keeps.
  assert.deepEqual(problems({ ...base0, parts: { 'section.crew': { props: { rows: 4 } }, 'crew.strip': { style: { opacity: '0.8' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'section.crew': { props: { rows: 0 } } } }).some((x) => /rows: int from 1 to 40/.test(x)));
  assert.ok(problems({ ...base0, parts: { 'section.crew': { props: { rows: '3' } } } }).some((x) => /rows: int from 1 to 40/.test(x)));
  // Track record (a member's, with Compare crew inside) are parts; the suggestion line is a switch.
  assert.deepEqual(problems({ ...base0, parts: { 'crew.record': { props: { tips: false }, style: { opacity: '0.9' } }, 'crew.compare': { hide: true }, 'crew.record.subject': { style: { fontSize: '15px' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'crew.record': { props: { tips: 'no' } } } }).some((x) => /tips: bool/.test(x)));
  assert.ok(problems({ ...base0, parts: { 'crew.compare': { props: { tips: false } } } }).some((x) => /tips isn't a prop of crew.compare/.test(x)));
  assert.ok(problems({ ...base0, buttons: [{ slot: 'split.upcoming', panel: 'x' }] }).length);
  assert.deepEqual(problems({ ...base0, settings: { readTimes: 'off' } }), []);
  assert.ok(problems({ ...base0, settings: { readTimes: 'sometimes' } }).some((x) => /readTimes/.test(x) && /on \| off/.test(x)));
});

test('plan budget: its group in Settings → Usage is a part; Wait for the reset (limitWait) is a setting', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['settings.budget'] }, parts: { 'settings.budget': { style: { fontSize: '12px' } } } }), []);
  assert.deepEqual(problems({ ...base0, settings: { limitWait: 'on' } }), []);
  assert.ok(problems({ ...base0, settings: { limitWait: 'always' } }).some((x) => /limitWait/.test(x) && /on \| off/.test(x)));
});

test('ask near the limit: limitHold is a setting with its lines; the harness picker’s note is a part, the hold row and held card aren’t', () => {
  assert.deepEqual(problems({ ...base0, settings: { limitHold: '95' } }), []);
  assert.deepEqual(problems({ ...base0, settings: { limitHold: 'off' } }), []);
  assert.ok(problems({ ...base0, settings: { limitHold: '50' } }).some((x) => /limitHold/.test(x) && /off \| 80 \| 90 \| 95/.test(x)));
  assert.deepEqual(problems({ ...base0, ui: { hide: ['harness.usage'] } }), []);
  for (const sel of Object.values(schema.PARTS)) assert.ok(!/\.(c-hold|l-hold|b-held|st-held)\b/.test(sel), `${sel} must not be a part: a held send needs you`);
});

test('Automations stop at (autoStop) is a setting; its row, Where it went and a task’s plan share are parts', () => {
  assert.deepEqual(problems({ ...base0, settings: { autoStop: '75' } }), []);
  assert.deepEqual(problems({ ...base0, settings: { autoStop: 'off' } }), []);
  assert.ok(problems({ ...base0, settings: { autoStop: '80' } }).some((x) => /autoStop/.test(x) && /off \| 50 \| 75 \| 90/.test(x)));
  assert.deepEqual(problems({ ...base0, ui: { hide: ['budget.where', 'details.plan'] }, parts: { 'settings.autoStop': { style: { opacity: '0.8' } } } }), []);
});

test('the crew: its section, rows, faces, page and editor are parts; the page takes buttons, not panels', () => {
  const ok = {
    ...base0,
    parts: { 'section.crew': { style: { fontSize: '12px' } }, 'crew.row': { style: { padding: '2px' } }, 'crew.avatar': { style: { borderRadius: '8px' } }, 'crew.page': { style: { width: '900px' } }, 'crew.editor': { hide: false }, 'crew.editor.events': { hide: true } },
    buttons: [{ slot: 'crew.page', icon: 'crew', label: 'Standup', do: { open: 'https://example.com' } }],
  };
  assert.deepEqual(problems(ok), []);
  assert.deepEqual(problems({ ...base0, ui: { hide: ['section.crew'] } }), []);
  assert.ok(schema.SLOTS['crew.page'] && !schema.CARD_SLOTS.has('crew.page'));
  assert.ok(schema.ICONS.includes('crew') && schema.ICONS.includes('pause') && schema.ICONS.includes('user'));
  assert.ok(problems({ ...base0, buttons: [{ slot: 'crew.page', panel: 'x' }] }).length);
  assert.ok(problems({ ...base0, parts: { 'crew.nope': { hide: true } } }).some((x) => /crew\.nope/.test(x)));
  // Skills and instructions: the section and its editor.
  assert.deepEqual(problems({ ...base0, parts: { 'crew.kit': { hide: true }, 'crew.kitEditor': { style: { width: '900px' } }, 'crew.notebookEditor': { style: { width: '900px' } }, 'crew.kitGenerate': { hide: true }, 'crew.offer': { style: { padding: '4px' } }, 'turn.kitOffer': { hide: true } } }), []);
  assert.ok(problems({ ...base0, parts: { 'crew.kits': { hide: true } } }).some((x) => /crew\.kits/.test(x)));
  // Sharing: Share, and Import with its review. Never the review that gates a spell's own members,
  // nor the note saying which spell a member is from.
  assert.deepEqual(problems({ ...base0, parts: { 'crew.share': { style: { width: '700px' } }, 'crew.import': { style: { width: '800px' } } } }), []);
  assert.ok(problems({ ...base0, ui: { hide: ['crew.review'] } }).some((x) => /crew\.review isn't a part/.test(x)));
  assert.ok(problems({ ...base0, parts: { 'crew.spellNote': { hide: true } } }).some((x) => /crew\.spellNote/.test(x)));
});

test('take over in wisp: the terminal setting, its parts, font size and header slot', () => {
  const ok = {
    ...base0,
    settings: { terminal: 'wisp' },
    parts: { term: { props: { fontSize: 15 }, style: { borderRadius: '4px' } }, 'term.head': { style: { background: 'var(--bg-2)' } }, 'term.screen': { style: { padding: '4px' } } },
    ui: { hide: ['term.keys'] },
    buttons: [{ slot: 'term.head', icon: 'copy', label: 'Branch', do: { copy: '{branch}' } }],
  };
  assert.deepEqual(problems(ok), []);
  assert.ok(schema.CARD_SLOTS.has('term.head'));
  const p = problems({ ...base0, settings: { terminal: 'custom' }, parts: { term: { props: { fontSize: 99, height: 3 } } } });
  assert.ok(p.some((x) => /settings\.terminal/.test(x) && /wisp/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /fontSize: int from 1 to 40/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /height/.test(x)), p.join('\n'));
});

test('Settings → Cloud is parts spells can restyle or hide', () => {
  assert.deepEqual(problems({ ...base0, parts: { 'machines.cloud': { style: { borderRadius: '4px' } }, 'settings.cloud': { style: { borderRadius: '4px' } }, 'settings.cloud.computer': { style: { background: 'var(--surface)' } }, 'settings.connect': { style: { borderRadius: '4px' } }, 'getapp.card': { style: { borderRadius: '4px' } } }, ui: { hide: ['settings.cloud.signin', 'settings.cloud.add', 'topbar.getapp'] } }), []);
  assert.ok(problems({ ...base0, parts: { 'settings.cloud': { props: { width: 400 } } } }).some((x) => /settings\.cloud/.test(x)));
});

test('Settings → Machines → This computer is a part spells can restyle or hide', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['settings.nav'] }, parts: { settings: { style: { borderRadius: '4px' } }, 'settings.head': { style: { background: 'var(--bg-2)' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'settings.head': { props: { width: 400 } } } }).some((x) => /settings\.head/.test(x)));
  // wisp Grid in Machines: this computer's row and the where-it-comes-from pill.
  assert.deepEqual(problems({ ...base0, ui: { hide: ['machines.kind'] }, parts: { 'machines.grid.here': { style: { borderRadius: '4px' } } } }), []);
  assert.deepEqual(problems({ ...base0, parts: { 'machines.grid.previews': { style: { background: 'var(--surface)' } } } }), []);
  assert.ok(problems({ ...base0, ui: { hide: ['machines.grid.nope'] } }).length);
  assert.deepEqual(problems({ ...base0, ui: { hide: ['settings.reachable', 'machines.howto'] }, parts: { 'settings.reachable': { style: { borderRadius: '4px' } }, 'machines.letin': { style: { background: 'var(--surface)' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'settings.reachable': { props: { width: 400 } } } }).some((x) => /settings\.reachable/.test(x)));
  // The update channel's row can be restyled or hidden, but a spell can't move you onto nightlies.
  assert.deepEqual(problems({ ...base0, ui: { hide: ['settings.updates'] }, parts: { 'settings.updates': { style: { borderRadius: '4px' } } } }), []);
  assert.ok(problems({ ...base0, settings: { updateChannel: 'nightly' } }).some((x) => /updateChannel/.test(x)));
});

test('a video in a reply and its buttons are parts, and video is a built-in block', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['video.tools', 'image.tools'] }, parts: { video: { style: { borderRadius: '4px' } } } }), []);
  assert.ok(schema.BUILTIN_BLOCKS.includes('video'));
});

test('the viewer\'s previous / next arrows are a part', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['viewer.nav'] }, parts: { 'viewer.nav': { style: { background: 'var(--bg)' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'viewer.nav': { props: { size: 4 } } } }).some((x) => /viewer\.nav/.test(x)));
});

test('a preview in a reply is a part, its stage can be made taller, and preview is a built-in block', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['preview.foot'] }, parts: { 'preview.stage': { style: { maxHeight: '900px' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'preview.stage': { props: { size: 4 } } } }).some((x) => /preview\.stage/.test(x)));
  assert.ok(schema.BUILTIN_BLOCKS.includes('preview'));
});

test('the image viewer is a part spells can restyle or hide', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['viewer.bar', 'image.tools'] }, parts: { 'image.tools': { style: { borderRadius: '4px' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'image.tools': { props: { size: 4 } } } }).some((x) => /image\.tools/.test(x)));
  assert.deepEqual(problems({ ...base0, ui: { hide: ['viewer.bar'] }, parts: { viewer: { style: { background: 'var(--bg)' } }, 'viewer.bar': { style: { borderRadius: '4px' } } } }), []);
  assert.ok(problems({ ...base0, parts: { viewer: { props: { zoom: 4 } } } }).some((x) => /viewer/.test(x)));
});

test('style values: no url(), imports, escapes or extra declarations; tokens and colours are fine', () => {
  assert.equal(schema.styleProblem('fontWeight', '650'), '');
  assert.equal(schema.styleProblem('background', 'var(--surface-2)'), '');
  assert.equal(schema.styleProblem('box-shadow', '0 1px 2px rgba(0,0,0,.2)'), '');
  for (const v of ['url(x)', 'image-set("a.png" 1x)', '@import "x"', 'red;color:blue', '\\75rl(x)', 'attr(data-x)', '}body{color:red']) assert.ok(schema.styleProblem('background', v), v);
  assert.ok(schema.styleProblem('position', 'fixed'), 'not an allowed property');
});

test('gh and wisp data allowlists', () => {
  assert.equal(schema.ghProblem(['search', 'prs', '--author', '@me']), '');
  assert.equal(schema.ghProblem(['pr', 'checks', '{pr.number}', '--json', 'name,state']), '');
  assert.equal(schema.ghProblem(['api', 'user']), '');
  assert.ok(schema.ghProblem(['api', 'graphql', '-f', 'query=mutation{}']));
  assert.ok(schema.ghProblem(['repo', 'delete', 'x']));
  assert.ok(schema.ghProblem(['auth', 'token']));
  assert.equal(schema.wispPathProblem('/usage/tools?days=7'), '');
  assert.equal(schema.wispPathProblem('/sessions/abc'), '');
  assert.ok(schema.wispPathProblem('/sessions/abc/exec'));
  assert.ok(schema.wispPathProblem('/config'));
});

test('templates, card filters and script exports', () => {
  assert.equal(schema.fillTemplate('PR #{pr.number} on {branch}{missing}', { pr: { number: 7 }, branch: 'wisp/x' }), 'PR #7 on wisp/x');
  assert.ok(schema.whenMatches({ hasPr: true, state: ['review', 'done'] }, { pr: { number: 1 }, state: 'review' }));
  assert.ok(!schema.whenMatches({ hasPr: true }, { pr: null }));
  assert.ok(!schema.whenMatches({ agent: 'codex' }, { agent: 'claude' }));
  assert.deepEqual(schema.scriptExports('export function a() {}\nexport async function b() {}\nexport const c = () => 1;\nfunction d() {}'), ['a', 'b', 'c']);
  const fns = new Function(schema.scriptBody('export function twice(x) { return x * 2; }\nexport const name = () => "n";'))();
  assert.equal(fns.twice(4), 8);
  assert.equal(fns.name(), 'n');
});

test('describeSpell says what a spell does and how risky it is', () => {
  const ex = (id) => normalizeSpell(SPELL_EXAMPLES.find((e) => e.spell.id === id).spell).spell;
  assert.equal(describeSpell(ex('tool-stats')).kind, 'safe');
  assert.equal(describeSpell(ex('my-prs')).kind, 'reads');
  assert.equal(describeSpell(ex('quick-replies')).kind, 'acts');
  assert.equal(describeSpell(ex('fix-failing-tests')).kind, 'acts');
  const ex2 = normalizeSpell({ ...base0, buttons: [{ slot: 'card.hover', label: 'Finder', do: { exec: 'open .' } }] }).spell;
  assert.equal(describeSpell(ex2).kind, 'runs');
  assert.match(describeSpell(ex('my-prs')).lines.join('\n'), /A floating button “My PRs” that opens every link in prs/);
  assert.match(describeSpell(ex('my-prs')).lines.join('\n'), /Reads GitHub: `gh search prs/);
});

test('crew: members a spell brings, each a blueprint; risk by what starts them; no paths', () => {
  const member = { key: 'quill', name: 'Quill', role: 'PR reviewer', brief: 'Review PRs.', mode: 'plan' };
  assert.deepEqual(problems({ ...base0, crew: [member] }), []);
  const on = (x) => describeSpell(normalizeSpell({ ...base0, crew: [{ ...member, ...x }] }).spell);
  assert.equal(on({}).kind, 'acts', 'on call, in Plan: acts only when you hand it work');
  assert.equal(on({ cron: '0 * * * *' }).kind, 'runs', 'a schedule starts jobs on its own');
  assert.equal(on({ on: ['finished'] }).kind, 'runs', 'so do events');
  assert.equal(on({ mode: 'auto' }).kind, 'runs', 'and Full auto runs commands');
  assert.match(on({ cron: '0 * * * *', on: ['ci'] }).lines.join('\n'), /A crew member, Quill · PR reviewer: works hourly, when CI fails, in Plan mode\. Joins paused/);
  assert.ok(problems({ ...base0, crew: [{ ...member, cwd: '/Users/me/repo' }] }).some((x) => /crew\[0\] \(Quill\): cwd: a shared member has no folder/.test(x)));
  assert.ok(problems({ ...base0, crew: [{ ...member, cron: 'now and then' }] }).some((x) => /cron: Couldn’t read/.test(x)));
  assert.ok(problems({ ...base0, crew: [{ ...member, kit: [{ kind: 'skill', name: 'x', body: 'y' }] }] }).some((x) => /kit: Say when x should be used/.test(x)));
  assert.ok(problems({ ...base0, crew: [{ ...member, on: ['issues'] }] }).some((x) => /on: issues isn't one of/.test(x)));
  assert.ok(problems({ ...base0, crew: Array.from({ length: 11 }, (_, i) => ({ name: `M${i}` })) }).some((x) => /crew: at most 10 members/.test(x)));
  assert.ok(problems({ ...base0, crew: [member, { ...member }] }).some((x) => /two members share/.test(x)));
  // The worked example the Cast a spell agent sees is one.
  assert.equal(SPELL_EXAMPLES.find((e) => e.spell.crew)?.spell.crew[0].name, 'Quill');
  assert.match(JSON.stringify(spellReference().fields.crew), /They join paused/);
});

test('scopes: project, harness and mode', () => {
  const project = { id: 'p1', name: 'api' };
  assert.ok(scopeMatches({ project: ['api'] }, { project, agent: 'claude' }));
  assert.ok(scopeMatches({ project: ['p1'], agent: ['claude'] }, { project, agent: 'claude' }));
  assert.ok(!scopeMatches({ agent: ['codex'] }, { project, agent: 'claude' }));
  assert.ok(scopeMatches({ project: ['/code/api'] }, { cwd: '/code/api/sub' }));
  assert.ok(!scopeMatches({ mode: ['plan'] }, { mode: 'auto' }));
});

test('a spell block that lost its closing brace (seen from Codex) is repaired, not skipped', () => {
  const raw = '```wisp\n{"blocks":[\n{"type":"hero","title":"t","summary":"s","status":"done"},\n{"type":"spell","spell":{"wispSpell":1,"id":"w","name":"W","script":"export function f() {\\n  return [];\\n}"}\n]}\n```';
  const p = parsePresentation(raw);
  assert.deepEqual(p.blocks.map((b) => b.type), ['hero', 'spell']);
  assert.equal(p.blocks[1].spell.id, 'w');
});

// --- the store and the overlay --------------------------------------------------------------

test('the store keeps spells off until turned on; a broken file is listed, not loaded', () => {
  const home = tmp('spells-store');
  const a = new Spells(home);
  a.install({ ...base0, settings: { mode: 'plan' } });
  assert.equal(a.isOn('x'), false);
  assert.deepEqual(a.settings().values, {});
  a.setEnabled('x', true);
  assert.deepEqual(a.settings().values, { mode: 'plan' });
  fs.writeFileSync(path.join(home, 'spells', 'junk.json'), '{"wispSpell":1,"id":"junk"}');
  const b = new Spells(home);
  assert.ok(b.isOn('x'), 'on/off survives a restart');
  assert.equal(b.list().broken[0].id, 'junk');
  assert.equal(new Spells(home, { safe: true }).enabled().length, 0, 'safe mode turns every spell off');
});

test('overlayDefaults: spell values win while on, and config.json keeps only yours', () => {
  const mine = { mode: 'auto', editor: 'zed' };
  let values = { mode: 'plan' };
  const d = overlayDefaults(mine, () => ({ values }));
  assert.equal(d.mode, 'plan');
  assert.equal(d.editor, 'zed');
  assert.deepEqual({ ...d }, { mode: 'plan', editor: 'zed' });
  assert.equal(JSON.stringify({ defaults: d }), '{"defaults":{"mode":"auto","editor":"zed"}}');
  d.editor = 'cursor';
  assert.equal(mine.editor, 'cursor', 'writes land on your settings');
  values = {};
  assert.equal(d.mode, 'auto', 'off: back to yours');
});

test('agent blocks from spells join the protocol; their summary stands in for them as text', () => {
  const p = systemPrompt({ extraBlocks: [{ type: 'deploy', doc: '{"type":"deploy","env":"x"} After you deploy.', spell: 'Deploy block' }] });
  assert.match(p, /- \{"type":"deploy","env":"x"\}\n {2}After you deploy\.\n {2}\(From the user's spell Deploy block\.\)\n\nStrings must be valid JSON/);
  assert.equal(systemPrompt(), systemPrompt({ extraBlocks: [] }));
  assert.match(blocksToMarkdown([{ type: 'spell', spell: { name: 'My PRs', description: 'Opens PRs' } }]), /🧙 Spell: My PRs\*\* — Opens PRs/);
  assert.match(blocksToMarkdown([{ type: 'spell', spell: { type: 'spell', remove: 'my-prs' } }]), /remove `my-prs`/, 'a removal nested the way agents write it');
});

// --- through a real server ------------------------------------------------------------------

let srv;
let base;
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
async function call(method, p, body) {
  const write = method !== 'GET';
  const r = await fetch(`${base}/api${p}`, { method, headers: write ? { 'content-type': 'application/json' } : {}, body: write ? JSON.stringify(body || {}) : undefined });
  return { status: r.status, body: await r.json() };
}
const ok = async (method, p, body) => {
  const r = await call(method, p, body);
  assert.ok(r.status < 300, `${method} ${p}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
};
const done = (id) => until(async () => (await ok('GET', `/sessions/${id}`)).turns.at(-1)?.status === 'done' && (await ok('GET', `/sessions/${id}`)), { timeout: 30_000 });

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  srv = await startServer({ port, handleSignals: false });
});
after(() => {
  srv.shutdown();
  srv.server.closeAllConnections?.();
  srv.server.close();
});

test('install → off; enable → its settings win and lock; off → yours are back, config.json never had them', async () => {
  const spell = { wispSpell: 1, id: 'plan-first', name: 'Plan first', settings: { mode: 'plan', transcript: 'on' }, recipes: [{ name: 'Triage', prompt: 'Triage {label}' }] };
  const check = await ok('POST', '/spells/check', { spell });
  assert.equal(check.ok, true);
  assert.equal(check.kind, 'safe');
  assert.equal((await call('POST', '/spells', { spell })).status, 201);
  assert.equal((await ok('GET', '/config')).defaults.mode, 'auto', 'installed, not on');

  await ok('PATCH', '/spells/plan-first', { enabled: true });
  const cfg = await ok('GET', '/config');
  assert.equal(cfg.defaults.mode, 'plan');
  assert.deepEqual(cfg.lockedBy.mode, { id: 'plan-first', name: 'Plan first' });
  assert.ok(cfg.spells.some((s) => s.id === 'plan-first'));
  assert.ok(cfg.recipes.some((r) => r.name === 'Triage' && r.spell?.id === 'plan-first'));
  const locked = await call('PATCH', '/config', { defaults: { mode: 'auto' } });
  assert.equal(locked.status, 409);
  await ok('PATCH', '/config', { defaults: { mode: 'plan', editor: 'zed' } }); // same value + another key: fine
  assert.equal((await call('PATCH', `/recipes/${cfg.recipes.find((r) => r.spell).id}`, { name: 'Mine now' })).status, 409);

  await ok('PATCH', '/spells/plan-first', { enabled: false });
  const after = await ok('GET', '/config');
  assert.equal(after.defaults.mode, 'auto');
  assert.equal(after.defaults.editor, 'zed');
  assert.ok(!after.recipes.some((r) => r.spell));
  const saved = JSON.parse(fs.readFileSync(path.join(process.env.WISP_HOME, 'config.json'), 'utf8'));
  assert.equal(saved.defaults.mode, 'auto');
  assert.equal(saved.defaults.transcript, undefined);
});

test('check reports problems without installing; export is the spell file; remove deletes it', async () => {
  const bad = await ok('POST', '/spells/check', { text: JSON.stringify({ wispSpell: 1, id: 'bad', name: 'Bad', ui: { hide: ['nope'] } }) });
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /nope isn't a part/);
  assert.equal((await call('POST', '/spells', { spell: { wispSpell: 1, id: 'bad' } })).status, 400);
  assert.equal((await call('POST', '/spells/check', { text: '{nope' })).status, 400);

  await ok('POST', '/spells', { text: JSON.stringify({ wispSpell: 1, id: 'shared', name: 'Shared', prompt: ['Be brief.'] }), name: 'shared.spell.json' });
  const listed = (await ok('GET', '/spells')).spells.find((s) => s.id === 'shared');
  assert.equal(listed.enabled, false);
  assert.equal(listed.source.kind, 'file');
  const exported = await ok('GET', '/spells/shared/export');
  assert.deepEqual(Object.keys(exported).sort(), ['harnesses', 'id', 'name', 'prompt', 'version', 'wispSpell', 'author', 'description'].sort());
  await ok('DELETE', '/spells/shared');
  assert.equal((await call('GET', '/spells/shared')).status, 404);
});

test('two spells that claim the same block type or slash command can not both be on', async () => {
  const mk = (id) => ({ wispSpell: 1, id, name: id, blocks: [{ type: 'deploy', doc: '{"type":"deploy"}', render: 'r' }], script: 'export function r(b) { return []; }' });
  await ok('POST', '/spells', { spell: mk('one'), enable: true });
  await ok('POST', '/spells', { spell: mk('two') });
  const r = await call('PATCH', '/spells/two', { enabled: true });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /block type deploy is already one's/);
  await ok('POST', '/spells/off', {});
  assert.equal((await ok('GET', '/spells')).spells.filter((s) => s.enabled).length, 0);
  await ok('DELETE', '/spells/one');
  await ok('DELETE', '/spells/two');
});

test('data sources: wisp GETs and read-only gh, fetched for the spell; /open takes only http(s)', async () => {
  fs.writeFileSync(process.env.FAKE_GH_STATE, JSON.stringify({ runs: [{ databaseId: 1, name: 'CI', conclusion: 'failure', url: 'https://github.com/acme/repo/actions/runs/1', headBranch: 'main' }] }));
  await ok('POST', '/spells', {
    spell: { wispSpell: 1, id: 'data', name: 'Data', data: { tools: { wisp: '/usage/tools?days=7' }, runs: { gh: ['run', 'list', '--json', 'url,name'] } } },
    enable: true,
  });
  const tools = await ok('POST', '/spells/data/data/tools', {});
  assert.equal(typeof tools.value.total.calls, 'number');
  assert.ok(Array.isArray(tools.value.kinds));
  const runs = await ok('POST', '/spells/data/data/runs', {});
  assert.ok(Array.isArray(runs.value));
  assert.ok(records(RECORD, 'gh').some((r) => r.argv[0] === 'run' && r.argv[1] === 'list'));
  assert.equal((await call('POST', '/spells/data/data/nope', {})).status, 404);
  assert.deepEqual((await ok('POST', '/open', { urls: ['https://github.com/a', 'file:///etc/passwd', 'javascript:x'] })).opened, ['https://github.com/a']);
  assert.equal((await call('POST', '/open', { urls: ['file:///etc/passwd'] })).status, 400);
  await ok('DELETE', '/spells/data');
});

test('prompt rules and agent blocks reach the agent; a spell-only harness filter keeps them off others', async () => {
  const cwd = makeRepo();
  await ok('POST', '/spells', {
    spell: {
      wispSpell: 1, id: 'rules', name: 'Rules', prompt: ['Run the linter before you report.', { text: 'Codex only rule.', when: { agent: 'codex' } }],
      blocks: [{ type: 'deploy', doc: '{"type":"deploy","env":"staging","url":"https://…"} After a deploy.', summary: 'Deployed {env} → {url}', render: 'deploy' }],
      script: 'export function deploy(b) { return [{ type: "callout", tone: "success", title: b.env, text: b.url }]; }',
    },
    enable: true,
  });
  const s = await ok('POST', '/sessions', { prompt: 'fix the bug DEPLOYBLOCK', cwd, agent: 'claude', mode: 'auto', worktree: false });
  const full = await done(s.id);
  const argv = records(RECORD, 'claude').findLast((r) => r.stdin.includes('DEPLOYBLOCK')).argv;
  const sys = argv[argv.indexOf('--append-system-prompt') + 1];
  assert.match(sys, /## Spells the user cast[\s\S]*Run the linter before you report\. _\(spell: Rules\)_/);
  assert.doesNotMatch(sys, /Codex only rule/);
  assert.match(sys, /\{"type":"deploy","env":"staging"/);
  assert.ok(full.turns.at(-1).presentation.blocks.some((b) => b.type === 'deploy'));
  const md = await ok('GET', `/sessions/${s.id}/presentation`);
  assert.match(md.markdown, /Deployed staging → https:\/\/staging\.example\.com/);
  await ok('DELETE', '/spells/rules');
});

test('a hook sends a task with failing tests back once, then stops', async () => {
  const cwd = makeRepo();
  await ok('POST', '/spells', { spell: SPELL_EXAMPLES.find((e) => e.spell.id === 'fix-failing-tests').spell, enable: true });
  const s = await ok('POST', '/sessions', { prompt: 'fix it FAILTESTS', cwd, agent: 'claude', mode: 'auto', worktree: false });
  const full = await until(async () => {
    const x = await ok('GET', `/sessions/${s.id}`);
    return x.turns.length === 2 && x.turns[1].status === 'done' && x;
  }, { timeout: 30_000 });
  assert.match(full.turns[1].prompt, /Some tests fail\. Fix them/);
  assert.equal(full.turns[1].by, 'wisp');
  // A third turn never comes: max 1 per task, and the follow-up's report passed anyway.
  await ok('POST', `/sessions/${s.id}/reply`, { text: 'again FAILTESTS' });
  await until(async () => (await ok('GET', `/sessions/${s.id}`)).turns[2]?.status === 'done', { timeout: 30_000 });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await ok('GET', `/sessions/${s.id}`)).turns.length, 3);
  await ok('DELETE', '/spells/fix-failing-tests');
});

test('Cast a spell: a folder-less task whose agent gets the spell tools and hands back a spell block', async () => {
  const s = await ok('POST', '/sessions', { prompt: 'CAST add a hello rule', kind: 'spell', agent: 'claude', cwd: makeRepo() });
  assert.equal(s.kind, 'spell');
  assert.match(s.title, /^Spell: /);
  const full = await done(s.id);
  assert.equal(full.mode, 'edits'); // Claude's Plan mode refuses MCP tools
  assert.ok(full.cwd.includes(`${path.sep}scratch${path.sep}`), 'runs in a scratch folder, not the project');
  const rec = records(RECORD, 'claude').findLast((r) => r.stdin.includes('CAST'));
  const sys = rec.argv[rec.argv.indexOf('--append-system-prompt') + 1];
  assert.match(sys, /## This task: cast a spell on wisp/);
  const mcp = JSON.parse(rec.argv[rec.argv.indexOf('--mcp-config') + 1]);
  assert.equal(mcp.mcpServers.wisp.env.WISP_SPELLS, '1');
  const hero = full.turns.at(-1).presentation.blocks[0];
  assert.match(hero.summary, /schema read \| check: ok — “Fake hello” \(safe\) would:/);
  const block = full.turns.at(-1).presentation.blocks.find((b) => b.type === 'spell');
  assert.equal(block.spell.id, 'fake-hello');
  assert.equal((await call('GET', '/spells/fake-hello')).status, 404, 'nothing is installed until the user keeps it');
});

test('the spell tools only answer a Cast a spell task with the right token', async () => {
  const cwd = makeRepo();
  const s = await ok('POST', '/sessions', { prompt: 'plain task', cwd, agent: 'claude', worktree: false });
  await done(s.id);
  const r = await fetch(`${base}/api/internal/spell-schema/${s.id}`, { headers: { 'x-wisp-token': srv.runner.bridge.token } });
  assert.equal(r.status, 403);
  const r2 = await fetch(`${base}/api/internal/spell-schema/${s.id}`, { headers: { 'x-wisp-token': 'nope' } });
  assert.equal(r2.status, 403);
});

test('the follow-up Queue switch is a part spells can restyle or hide', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['composer.queue'] }, parts: { 'composer.queue': { style: { borderRadius: '4px' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'composer.queue': { props: { width: 400 } } } }).some((x) => /composer\.queue/.test(x)));
});

test('interactive answers: the apps setting, the block.app parts, and app is a built-in block', () => {
  for (const apps of ['on', 'off']) assert.deepEqual(problems({ ...base0, settings: { apps } }), []);
  const p = problems({ ...base0, settings: { apps: 'yes' } });
  assert.ok(p.some((x) => /settings\.apps/.test(x) && /on \| off/.test(x)), p.join('\n'));
  assert.deepEqual(problems({ ...base0, parts: { 'block.app': { style: { borderRadius: '4px' } }, 'block.app.head': { style: { background: 'var(--bg-2)' } } }, ui: { hide: ['block.app.head'] } }), []);
  assert.ok(problems({ ...base0, ui: { hide: ['block.app.send'] } }).some((x) => /block\.app\.send/.test(x)), 'the send strip can not be hidden');
  const own = problems({ ...base0, blocks: [{ type: 'app', doc: 'x', render: 'r' }], script: 'export function r() { return []; }' });
  assert.ok(own.some((x) => /app is a built-in block/.test(x)), own.join('\n'));
});

test("a question's choices in a phone's card row are a part spells can restyle or hide", () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['card.choices'] }, parts: { 'card.choices': { style: { gap: '4px' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'card.choices': { props: { lines: 2 } } } }).some((x) => /card\.choices/.test(x)));
});

test("the phone's New task button is a part spells can restyle or hide", () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['launcher.fab'] }, parts: { 'launcher.fab': { style: { borderRadius: '12px' } } } }), []);
  assert.ok(problems({ ...base0, parts: { 'launcher.fab': { props: { size: 2 } } } }).some((x) => /launcher\.fab/.test(x)));
});

test('goals: the band, its parts, the row pill and the launcher line are parts; the band takes buttons; goalRounds is a setting', () => {
  assert.deepEqual(problems({ ...base0, ui: { hide: ['card.goal', 'launcher.goal', 'goal.track'] }, parts: { 'goal.band': { style: { opacity: '0.9' } }, 'goal.text': { style: { fontSize: '14px' } }, 'goal.check': { style: { color: 'var(--muted)' } }, 'launcher.goalLine': { style: { opacity: '0.8' } } } }), []);
  assert.deepEqual(problems({ ...base0, buttons: [{ slot: 'goal.band', label: 'Tests', icon: 'target', do: { open: 'https://example.com' } }] }), []);
  for (const goalRounds of ['3', '5', '10', '20']) assert.deepEqual(problems({ ...base0, settings: { goalRounds } }), []);
  assert.ok(problems({ ...base0, settings: { goalRounds: '7' } }).some((x) => /goalRounds/.test(x) && /3, 5, 10, 20|3/.test(x)));
});

test('the side panel: its parts, width, opening tab and bot comments as props, a head slot; the verdict is not a part', () => {
  const ok = {
    ...base0,
    parts: { panel: { props: { width: 560, tab: 'pr' }, style: { background: 'var(--surface)' } }, 'panel.pr': { props: { bots: true } }, 'panel.place': { style: { fontSize: '13px' } } },
    ui: { hide: ['panel.files', 'panel.conversation'] },
    buttons: [{ slot: 'panel.head', icon: 'shell', label: 'Logs', do: { copy: '{branch}' } }],
  };
  assert.deepEqual(problems(ok), []);
  assert.ok(schema.CARD_SLOTS.has('panel.head'));
  assert.ok(schema.ICONS.includes('panel') && schema.ICONS.includes('shell'));
  const p = problems({ ...base0, parts: { panel: { props: { width: 40, tab: 'files' } }, 'panel.verdict': { hide: true } } });
  assert.ok(p.some((x) => /width/.test(x) && /160/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /tab/.test(x) && /shell/.test(x)), p.join('\n'));
  assert.ok(p.some((x) => /panel\.verdict/.test(x)), p.join('\n'));
});
