// convertSpell (plan §6.0.1): a v1 `wispSpell: 1` file as a `wispPlugin: 1` manifest, so the spells
// people already have load as plugins. v1's reader is server/spells.js (normalizeSpell); its slot and
// part names are web/js/spell-schema.js. Everything a spell held maps to a field; what the shell must
// still apply (actions, data sources, hooks) goes to the shell's and runtime's list points.
import type { Json, Manifest, UiExtensionDecl } from './contract.ts';
import { isJson, isObj, isStr, type ManifestError } from './manifest-check.ts';
import { validateManifest } from './manifest.ts';
import { validVersion } from './semver.ts';

export type SpellResult = { ok: true; manifest: Manifest; warnings: string[] } | { ok: false; errors: ManifestError[]; warnings: string[] };

/** The plugin id a spell becomes: spells were the user's own, so they live under `user.`. */
export const spellPluginId = (spellId: string): string => `user.${spellId}`;

const KNOWN = ['wispSpell', 'id', 'name', 'version', 'description', 'author', 'wisp', 'harnesses', 'when', 'data', 'buttons', 'chips', 'panels', 'blocks', 'parts', 'ui', 'prompt', 'settings', 'slash', 'commands', 'hooks', 'recipes', 'crew', 'script'];
const SPELL_ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** A v1 slot ('composer.bar', 'float') as an extension-tree input ({id:'shell.composer', input:'bar'}). */
export function slotInput(slot: string): { id: string; input: string } {
  const at = slot.lastIndexOf('.');
  return at < 0 ? { id: 'shell', input: slot } : { id: `shell.${slot.slice(0, at)}`, input: slot.slice(at + 1) };
}

const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const json = (v: unknown): Json => (isJson(v) ? v : null);

/** The spell's `harnesses` and `when` as one extension `if` expression. */
function condition(j: Record<string, unknown>): string | undefined {
  const parts: string[] = [];
  const hs = list(j['harnesses']).filter(isStr).filter((h) => h !== '*');
  if (hs.length) parts.push(`session.harness in [${hs.map((h) => `'${h}'`).join(', ')}]`);
  if (isObj(j['when'])) for (const [k, v] of Object.entries(j['when'])) parts.push(`session.${k} == ${JSON.stringify(v)}`);
  return parts.length ? parts.join(' && ') : undefined;
}

function extension(prefix: string, kind: string, x: Record<string, unknown>, i: number, iff: string | undefined): UiExtensionDecl {
  const { id, slot, ...rest } = x;
  const at = kind === 'Panel' ? panelInput(x) : slotInput(isStr(slot) ? slot : kind === 'Chip' ? 'composer.chips' : 'topbar');
  return { id: `${prefix}.${isStr(id) ? id : `${kind.toLowerCase()}${i}`}`, attachTo: at, kit: { c: kind, ...(json(rest) as Record<string, Json>) }, ...(iff && { if: iff }) };
}

function panelInput(x: Record<string, unknown>): { id: string; input: string } {
  if (x['as'] === 'card') return slotInput(isStr(x['slot']) ? x['slot'] : 'card.bottom');
  if (x['as'] === 'feed') return { id: 'shell.home', input: 'feed' };
  return { id: 'shell', input: x['as'] === 'dialog' ? 'dialogs' : 'panes' };
}

/** A v1 data source as the read permission it needs. */
function dataPermission(src: unknown): string | undefined {
  if (!isObj(src)) return undefined;
  if (isStr(src['wisp'])) return `topic:read{path:${src['wisp']}}`;
  if (Array.isArray(src['gh'])) return `gh:read{cmd:${src['gh'].slice(0, 2).join(' ')}}`;
  return undefined;
}

function styles(j: Record<string, unknown>): { partStyles: Record<string, Record<string, string>>; props: Record<string, Json> } {
  const partStyles: Record<string, Record<string, string>> = {};
  const props: Record<string, Json> = {};
  for (const [part, v] of Object.entries(isObj(j['parts']) ? j['parts'] : {})) {
    if (!isObj(v)) continue;
    const { style, hide, ...rest } = v;
    if (isObj(style)) partStyles[part] = Object.fromEntries(Object.entries(style).map(([k, s]) => [k, String(s)]));
    if (hide === true) partStyles[part] = { ...partStyles[part], display: 'none' };
    if (Object.keys(rest).length) props[part] = json(rest);
  }
  const ui = isObj(j['ui']) ? j['ui'] : {};
  for (const part of list(ui['hide']).filter(isStr)) partStyles[part] = { ...partStyles[part], display: 'none' };
  return { partStyles, props };
}

/** Point contributions that only the shell or the runtime can apply. */
function points(j: Record<string, unknown>, prefix: string): Record<string, Json> {
  const out: Record<string, Json> = {};
  const put = (k: string, v: unknown): void => {
    if (v !== undefined && (!Array.isArray(v) || v.length)) out[k] = json(v);
  };
  const ui = isObj(j['ui']) ? j['ui'] : {};
  if (ui['tokens'] || ui['dark']) put('shell.tokens', [{ ...(isObj(ui['tokens']) && { tokens: ui['tokens'] }), ...(isObj(ui['dark']) && { dark: ui['dark'] }) }]);
  if (isObj(j['data'])) put('shell.data', Object.entries(j['data']).map(([name, src]) => ({ name, ...(isObj(src) ? src : {}) })));
  put('shell.actions', list(j['commands']).filter(isObj).map((c, i) => ({ command: `${prefix}.${isStr(c['id']) ? c['id'] : `k${i}`}`, ...c })));
  put('shell.slash', j['slash']);
  put('runtime.hooks', j['hooks']);
  put('runtime.prompt', isStr(j['prompt']) ? [{ text: j['prompt'] }] : j['prompt']);
  put('crew.members', j['crew']);
  if (isStr(j['script'])) put('shell.sandbox', [{ script: j['script'] }]);
  for (const b of list(j['blocks']).filter(isObj)) put('shell.blocks', [...list(out['shell.blocks']), b]);
  return out;
}

export function convertSpell(spell: unknown): SpellResult {
  const warnings: string[] = [];
  if (!isObj(spell)) return { ok: false, errors: [{ path: '', message: 'a spell is a JSON object' }], warnings };
  const j = spell;
  if (j['wispSpell'] !== 1) return { ok: false, errors: [{ path: 'wispSpell', message: 'must be 1' }], warnings };
  const sid = String(j['id'] ?? '').trim();
  if (!SPELL_ID.test(sid)) return { ok: false, errors: [{ path: 'id', message: 'lowercase letters, digits and dashes, starting with a letter or digit (at most 41)' }], warnings };
  for (const k of Object.keys(j)) if (!KNOWN.includes(k)) warnings.push(`${k}: not something spells knew about, left out`);
  if (j['wisp'] !== undefined) warnings.push('wisp: a minimum wisp version; plugins name the kernel api instead ("api": "^1")');
  const prefix = sid;
  const iff = condition(j);
  const ui = [
    ...list(j['buttons']).filter(isObj).map((b, i) => extension(prefix, 'Button', b, i, iff)),
    ...list(j['chips']).filter(isObj).map((b, i) => extension(prefix, 'Chip', b, i, iff)),
    ...list(j['panels']).filter(isObj).map((b, i) => extension(prefix, 'Panel', b, i, iff)),
  ];
  const { partStyles, props } = styles(j);
  const contributes: Record<string, unknown> = { ...points(j, prefix) };
  if (Object.keys(props).length) contributes['shell.partProps'] = [props];
  if (ui.length) contributes['ui'] = ui;
  if (Object.keys(partStyles).length) contributes['partStyles'] = partStyles;
  const commands = list(j['commands']).filter(isObj).map((c, i) => ({ id: `${prefix}.${isStr(c['id']) ? c['id'] : `k${i}`}`, title: String(c['label'] ?? c['id'] ?? 'Untitled') }));
  if (commands.length) contributes['commands'] = commands;
  if (list(j['recipes']).length) contributes['recipes'] = json(list(j['recipes']));
  const blocks = list(j['blocks']).filter(isObj).filter((b) => isStr(b['type'])).map((b) => ({ type: String(b['type']) }));
  if (blocks.length) contributes['blocks'] = blocks;
  if (isObj(j['settings']) && Object.keys(j['settings']).length) contributes['setSettings'] = Object.fromEntries(Object.entries(j['settings']).map(([k, v]) => [`shell.${k}`, json(v)]));
  const harnesses = list(j['harnesses']).filter(isStr).filter((h) => h !== '*');
  const permissions = [...new Set(Object.values(isObj(j['data']) ? j['data'] : {}).map(dataPermission).filter(isStr))];
  const manifest: Record<string, unknown> = {
    wispPlugin: 1,
    id: spellPluginId(sid),
    name: isStr(j['name']) ? j['name'] : sid,
    version: validVersion(j['version']) ? j['version'] : '1.0.0',
    api: '^1',
    ...(isStr(j['description']) && { description: j['description'] }),
    ...(isStr(j['author']) && { author: j['author'] }),
    trust: isStr(j['script']) ? 'untrusted' : 'declarative',
    ...(harnesses.length && { requires: Object.fromEntries(harnesses.map((h) => [`wisp.${h}`, { version: '*', optional: true }])) }),
    ...(permissions.length && { permissions }),
    ...(Object.keys(contributes).length && { contributes }),
  };
  const r = validateManifest(manifest);
  return r.ok ? { ok: true, manifest: r.manifest, warnings } : { ok: false, errors: r.errors, warnings };
}
