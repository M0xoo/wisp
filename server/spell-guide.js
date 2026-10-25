// What a Cast a spell agent is told: how spells work, what it may use, and how to hand one back.
// The reference (slots, parts, actions, …) comes from web/js/spell-schema.js, so it never drifts
// from what wisp accepts.

import { ACTIONS, CARD_HEAD_ORDER, EVENTS, HOOK_ACTIONS, HOOK_IF, ICONS, PART_PROPS, PARTS, SETTINGS, SLOTS, STYLE_PROPS, TOKENS, WISP_DATA, GH_READ } from '../web/js/spell-schema.js';

export const SPELL_EXAMPLES = [
  {
    ask: 'A floating button that opens all my open PRs',
    spell: {
      wispSpell: 1, id: 'my-prs', name: 'My PRs', version: '1.0.0', description: 'Open every PR you have open on GitHub, from a floating button.',
      data: { prs: { gh: ['search', 'prs', '--author', '@me', '--state', 'open', '--json', 'url,title,repository'], refresh: 120 } },
      buttons: [{ slot: 'float', icon: 'github', label: 'My PRs', badge: { count: 'prs' }, do: { openAll: { data: 'prs', field: 'url' } } }],
    },
  },
  {
    ask: 'A top bar button that shows my wisp tool stats',
    spell: {
      wispSpell: 1, id: 'tool-stats', name: 'Tool stats', version: '1.0.0',
      data: { tools: { wisp: '/usage/tools?days=30' } },
      buttons: [{ slot: 'topbar', icon: 'stats', label: 'Tools', do: { panel: 'tools' } }],
      panels: [{ id: 'tools', title: 'Tool calls · last 30 days', as: 'dialog', data: ['tools'], render: 'tools' }],
      script: "export function tools({ tools: t }) {\n  return [\n    { type: 'stats', items: [{ label: 'tool calls', value: t.total.calls }, { label: 'turns', value: t.total.turns }, { label: 'spend', value: Math.round(t.total.cost * 100) / 100, unit: '$' }] },\n    { type: 'chart', title: 'By kind', items: t.kinds.map((k) => ({ label: k.kind, value: k.calls })) },\n    { type: 'chart', title: 'By harness', items: t.agents.map((a) => ({ label: a.agent, value: a.calls })) },\n  ];\n}",
    },
  },
  {
    ask: 'A deploy block agents use after deploying',
    spell: {
      wispSpell: 1, id: 'deploy-block', name: 'Deploy block', version: '1.0.0',
      blocks: [{ type: 'deploy', doc: '{"type":"deploy","env":"staging","url":"https://…","status":"ok|failed","checks":[{"label":"health","ok":true}]} After you deploy: where it went and whether it is healthy.', summary: 'Deployed {env} → {url} ({status})', render: 'deploy' }],
      script: "export function deploy(b) {\n  return [\n    { type: 'callout', tone: b.status === 'ok' ? 'success' : 'danger', title: `${b.env} · ${b.status}`, text: b.url },\n    { type: 'checklist', items: (b.checks || []).map((c) => ({ text: c.label, done: !!c.ok })) },\n  ];\n}",
    },
  },
  {
    ask: 'A block agents use to have me rank options, by moving them up a list',
    spell: {
      wispSpell: 1, id: 'rank-block', name: 'Rank block', version: '1.0.0',
      blocks: [{ type: 'rank', doc: '{"type":"rank","title":"…","items":["option","…"]} When the user should put several options in order before you go on.', summary: 'Rank: {title}', render: 'rank' }],
      script: "export function rank(b) {\n  const items = (b.items || []).map(String);\n  const css = '<style>ol{margin:0;padding:12px 14px 8px;list-style:none;display:flex;flex-direction:column;gap:6px}li{display:flex;align-items:center;gap:8px;padding:8px 10px;border:1px solid var(--line);border-radius:8px}li span{flex:1;min-width:0}li button{border:1px solid var(--line-2);border-radius:6px;background:var(--surface);cursor:pointer}.go{margin:4px 14px 14px;padding:7px 12px;border:0;border-radius:8px;background:var(--accent);color:#fff;cursor:pointer}</style>';\n  const js = \"let o=wisp.state||\" + JSON.stringify(items).replace(/</g, '\\\\u003c') + \";const l=document.getElementById('l');\" +\n    \"const draw=()=>{l.innerHTML=o.map((t,i)=>'<li><span></span>'+(i?'<button data-i=\\\"'+i+'\\\">Up</button>':'')+'</li>').join('');l.querySelectorAll('span').forEach((s,i)=>{s.textContent=(i+1)+'. '+o[i]});wisp.save(o)};\" +\n    \"l.onclick=(e)=>{const i=+e.target.dataset.i;if(i){[o[i-1],o[i]]=[o[i],o[i-1]];draw()}};\" +\n    \"document.getElementById('go').onclick=()=>{wisp.send('My order:\\\\n'+o.map((t,i)=>(i+1)+'. '+t).join('\\\\n'))};draw();\";\n  const html = css + '<ol id=\"l\"></ol><button class=\"go\" id=\"go\">Send this order</button><script>' + js + '</scr' + 'ipt>';\n  return [{ type: 'app', title: b.title || 'Rank these', html, fallback: [{ type: 'checklist', items: items.map((t) => ({ text: t })) }] }];\n}",
    },
  },
  {
    ask: 'Compact cards, bold titles, PR first, no machine or project, and Open PR on hover',
    spell: {
      wispSpell: 1, id: 'compact-cards', name: 'Compact cards', version: '1.0.0',
      parts: { card: { props: { density: 'compact' } }, 'card.title': { style: { fontWeight: '650' } }, 'card.head': { order: ['pr', 'pill', 'time'] } },
      ui: { hide: ['card.machine', 'card.project'] },
      buttons: [{ slot: 'card.hover', icon: 'github', label: 'Open PR', when: { hasPr: true }, do: { open: '{pr.url}' } }],
    },
  },
  {
    ask: 'Split view with a wider task list showing full details, and a PR button in the task header',
    spell: {
      wispSpell: 1, id: 'split-wide', name: 'Wide split view', version: '1.0.0',
      parts: { sidebar: { props: { width: 420, details: 'full' } }, 'split.main': { props: { readWidth: 1000 } }, 'split.home': { props: { greeting: 'What should we ship today?' } } },
      buttons: [{ slot: 'split.head', icon: 'github', label: 'PR', when: { hasPr: true }, do: { open: '{pr.url}' } }],
    },
  },
  {
    ask: 'Quick replies above the follow-up box, and a second-opinion button',
    spell: {
      wispSpell: 1, id: 'quick-replies', name: 'Quick replies', version: '1.0.0',
      buttons: [
        { slot: 'composer.chips', label: 'Run the tests', do: { send: 'Run the tests and show me the output.' } },
        { slot: 'composer.chips', label: 'Explain why…', do: { insert: 'Explain why ' } },
        { slot: 'composer.bar', icon: 'agent', label: 'Second opinion', do: { rerun: { agent: 'codex', mode: 'plan', prompt: 'Review the changes on branch {branch} and say what you would do differently.' } } },
      ],
    },
  },
  {
    ask: 'When tests fail, send the task back once',
    spell: {
      wispSpell: 1, id: 'fix-failing-tests', name: 'Fix failing tests', version: '1.0.0',
      hooks: [{ on: 'turn.finished', if: { testsFailed: true }, max: 1, do: { reply: 'Some tests fail. Fix them, rerun the suite and report again.' } }],
    },
  },
  {
    ask: 'A crew member who reviews my PRs every hour, with a review checklist',
    spell: {
      wispSpell: 1, id: 'pr-reviewer', name: 'PR reviewer', version: '1.0.0', description: 'Quill, a crew member who reviews new and changed pull requests every hour.',
      crew: [
        {
          key: 'quill', name: 'Quill', role: 'PR reviewer', avatar: 'blob.violet.wide.flat.headphones', cron: '0 * * * *', mode: 'plan',
          brief: 'Review pull requests that are new or changed since your last check-in (`gh pr list`, `gh pr diff`). Look for bugs, missing tests and risky changes, worst first, one short review per PR. Never push, approve or merge.',
          kit: [{ kind: 'skill', name: 'review-checklist', description: 'When reviewing a pull request', body: '1. Read the description and the linked issue.\n2. Read the diff file by file; note bugs first, then missing tests, then style.\n3. Run the tests when the change touches logic.\n4. One short review: what to fix, worst first.' }],
        },
      ],
    },
  },
];

// The full reference, as JSON (wisp_spell_schema).
export function spellReference() {
  return {
    format: 'One JSON object. Required: wispSpell (1), id (lowercase-dashes), name. Everything else is optional.',
    fields: {
      version: '"1.0.0" — bump it when you change a spell the user already has',
      description: 'one sentence',
      harnesses: '["*"] or e.g. ["claude","codex"]: which harnesses its prompt rules, blocks and hooks apply to',
      when: '{ project: [names|ids|paths], agent: [...], mode: [...] } scope for prompt rules, blocks and hooks',
      data: '{ name: { wisp: "/path?query" } | { gh: [args], cwd?: "task", refresh?: seconds } } — fetched by wisp; script functions receive them as their first argument { name: value }. gh args may use {field} templates over the card\'s task (e.g. "{pr.number}").',
      buttons: '[{ id?, slot, label, icon?, title?, badge?: { count: "<data>" } | { text: "{field}" } | { fn, with: [data] }, group?: "name" (float only: folds into one button), corner?: "bottom-left", when?: {hasPr, prState, state, status, agent, project, unread, hasBranch} (card slots), do }]',
      chips: '[{ slot: "card.head" | "launcher.chips" | "composer.chips", text: "{field} template" | fn: "<script fn>" (returns a string), with?: [data], tone?: good|bad|warn|info|neutral, icon?, title?, when?, do? }]',
      panels: '[{ id, title, icon?, as: dialog|drawer|feed|card, slot?: card.top|card.bottom (as card), data: [names], render: "<script fn>", refresh?: { every: seconds, on: [summary, finished] } }] — render returns an array of wisp presentation blocks (stats, chart, markdown, checklist, files, callout, steps, tree, flow, terminal, code, actions with url…, preview, app)',
      blocks: '[{ type, doc: "one-line JSON example + when to use it", summary: "{field} template for text-only places", render: "<script fn>" }] — new presentation blocks agents can use; render(block) returns wisp blocks',
      parts: '{ "<part>": { style?: { cssProp: value }, props?: {...}, order?: [...] (card.head only) } }',
      ui: '{ hide: [parts], tokens: { "--accent": "#7c5cff" }, dark: { … tokens for dark mode } }',
      prompt: '["text", { text, when }] — added to agents\' system prompts while the spell is on',
      settings: '{ key: value } — wins over the user\'s setting while the spell is on (theme: "dark" keeps wisp dark)',
      slash: '[{ name, args?, hint?, do }] — /name in a follow-up box; {args} in do\'s text is what the user typed after it',
      commands: '[{ label, keywords?, icon?, key?, do }] — ⌘K items (key: a single key like "g" or "shift+g", only when no built-in uses it)',
      hooks: `[{ on, if?, max?, do }] — on: ${Object.keys(EVENTS).join(' | ')}; if: { ${HOOK_IF.join(', ')} }; do: one of ${[...HOOK_ACTIONS].join(', ')}; max: times per task (default 1)`,
      recipes: '[{ name, prompt with {params}, agent?, mode? }] — saved prompts',
      crew: '[{ key, name, role?, avatar?, brief, cron?: "5-field cron" (empty: only when asked), on?: [finished | done | ci], mode?: plan|edits|auto, agent?, model?, effort?, parallel?: 1-5, kit?: [{ kind: skill|rules, name, description (skills), body }], team?: [{ crew: "<key of another member here>" } | { agent }] }] — crew members the spell brings (at most 10). They join paused; the user reviews each and picks its project (one that starts when CI fails needs one). The spell owns who they are: change them by bumping the version. Prefer mode plan for a reviewer or watcher',
      script: 'JS with `export function name(data, ctx) { return … }` functions. It runs in a sandbox with no network, no DOM and no wisp API: it can only compute and return values (blocks, strings, numbers, lists of links). To make something interactive, return an app block: { type: "app", title, html: "<style>…</style>…<script>…</script>", height?, fallback?: [blocks] }. wisp runs its html in a sandboxed frame with no network, themed by wisp\'s CSS variables (var(--ink), --surface, --line, --accent, …); in it, wisp.send(text) offers text for the user to send to the task as a follow-up, wisp.save(obj) / wisp.state keep its state. Make it work from 320px wide. ctx: { session } (the card\'s task summary, when there is one), { block } for agent blocks (the block is also the first argument).',
    },
    templates: '{field} in text, labels, links and gh args is filled from the card\'s task summary: id, title, state, status, agent, model, mode, project, branch, cwd, preview, pr.number, pr.url, pr.state, pr.checks …; in slash commands {args} too. Missing fields become empty.',
    slots: SLOTS,
    parts: Object.keys(PARTS),
    partProps: PART_PROPS,
    cardHeadOrder: Object.keys(CARD_HEAD_ORDER),
    styleProps: STYLE_PROPS,
    tokens: TOKENS,
    icons: ICONS,
    actions: Object.fromEntries(Object.entries(ACTIONS).map(([k, v]) => [k, v.doc])),
    settings: SETTINGS,
    wispData: WISP_DATA,
    ghReadOnly: Object.fromEntries(Object.entries(GH_READ).map(([k, v]) => [k, v || 'GET only'])),
    examples: SPELL_EXAMPLES,
  };
}

// The system-prompt section for a Cast a spell task (kind: 'spell').
export function spellGuide(tool = 'mcp__wisp__ask_user') {
  const t = (name) => tool.replace(/ask_user$/, name);
  return `

## This task: cast a spell on wisp

The user wants to change wisp itself — add a button, a panel, a block agents can use, restyle or hide
part of the UI, change how agents behave — without anyone editing wisp's code. You do it by writing a
**spell**: one JSON object wisp layers over itself at runtime. You don't edit files and you don't run
commands; wisp installs the spell when the user clicks **Keep** on your report.

How to work:
1. Call \`wisp_spell_schema\` (${t('wisp_spell_schema')}) for the full reference: slots, parts, actions,
   icons, tokens, data sources, examples. Use only what it lists.
2. Call \`wisp_spells\` (${t('wisp_spells')}) to see what the user has already. To change one, keep its id and
   bump its version; to remove one, end with \`{"type":"spell","remove":"<id>"}\` (remove at the top
   level of the block, no spell object).
3. If you read data (a \`wisp\` or \`gh\` source), call \`wisp_spell_data\` (${t('wisp_spell_data')}) with the
   source to see the real shape before writing script that reads it.
4. Call \`wisp_spell_check\` (${t('wisp_spell_check')}) with your spell until it says ok. It validates and
   compiles the script (without running it) and says in plain words what the spell does.
5. End with a report whose blocks include exactly one \`spell\` block:
   {"type":"spell","spell":{ …the whole spell… }}
   Put a hero first (what the spell does, in a line), then the spell block, then anything worth
   knowing (what you assumed, what it can't do). Keep it short: the spell block itself shows the user
   a preview and what changes.

Rules: prefer the smallest spell that does what was asked. Never invent slots, parts, actions or
fields. Script functions are pure: no fetch, no DOM, no globals — they get data and return values.
If the ask needs something spells can't do yet, say so in a callout and do the closest thing they can.
`;
}
