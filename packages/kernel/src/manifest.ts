// validateManifest (plan §6.2): the whole static truth about a plugin, checked without running any of
// its code. Unknown keys are refused (with the key it probably meant), every id carries its owner's
// prefix, versions and ranges parse, permissions and activation events follow their grammars.
import type { Manifest, Requirement, SettingDecl, UiExtensionDecl } from './contract.ts';
import { ownedBy, PLUGIN_ID } from './ids.ts';
import { attachTo, checkActivation, checkPermission, isJson, isObj, isStr, type ManifestError, Problems, stringList, unknownKeys } from './manifest-check.ts';
import { validRange, validVersion } from './semver.ts';

export type { ManifestError } from './manifest-check.ts';
export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; errors: ManifestError[] };

const TOP = ['wispPlugin', 'id', 'name', 'version', 'api', 'description', 'author', 'kind', 'extends', 'requires', 'provides', 'permissions', 'server', 'activation', 'disable', 'contributes', 'migrations', 'trust'] as const;
const CONTRIB = ['commands', 'events', 'topics', 'points', 'settings', 'setSettings', 'ui', 'parts', 'partStyles', 'icons', 'blocks', 'recipes'] as const;
const POINT_KEY = /^[a-z][\w-]*(\.[\w:-]+)+(@\d+)?$/;
const SETTING_TYPES = ['string', 'int', 'bool', 'enum', 'json'] as const;

type Out = Record<string, unknown>;

export function validateManifest(json: unknown): ManifestResult {
  const p = new Problems();
  if (!isObj(json)) return { ok: false, errors: [{ path: '', message: 'a manifest is a JSON object' }] };
  unknownKeys(json, TOP, '', p);
  const out: Out = { wispPlugin: 1 };
  if (json['wispPlugin'] !== 1) p.add('wispPlugin', 'must be 1');
  const id = json['id'];
  if (!isStr(id) || !PLUGIN_ID.test(id)) p.add('id', 'an owner-prefixed id: lowercase segments joined by dots, like "acme.thing"');
  const pid = isStr(id) ? id : '';
  out['id'] = pid;
  header(json, out, p);
  relations(json, out, p);
  if (json['permissions'] !== undefined) out['permissions'] = stringList(json['permissions'], 'permissions', p, (s, at) => checkPermission(s, at, p));
  if (json['activation'] !== undefined) out['activation'] = stringList(json['activation'], 'activation', p, (s, at) => checkActivation(s, at, p));
  if (json['disable'] !== undefined) out['disable'] = stringList(json['disable'], 'disable', p);
  server(json['server'], out, p);
  if (json['contributes'] !== undefined) out['contributes'] = contributes(json['contributes'], pid, p);
  return p.list.length ? { ok: false, errors: p.list } : { ok: true, manifest: out as unknown as Manifest };
}

function header(json: Out, out: Out, p: Problems): void {
  for (const k of ['name', 'description', 'author', 'migrations'] as const) {
    const v = json[k];
    if (v === undefined) continue;
    if (typeof v !== 'string') p.add(k, 'must be a string');
    else out[k] = v;
  }
  if (!validVersion(json['version'])) p.add('version', 'must be a semver version, like "1.0.0"');
  else out['version'] = json['version'];
  if (!validRange(json['api'])) p.add('api', 'must be a semver range of the kernel api, like "^1"');
  else out['api'] = json['api'];
  const kind = json['kind'];
  if (kind !== undefined && kind !== 'plugin' && kind !== 'module') p.add('kind', 'must be "plugin" or "module"');
  else if (kind) out['kind'] = kind;
  const trust = json['trust'];
  if (trust !== undefined && trust !== 'declarative' && trust !== 'untrusted' && trust !== 'trusted') p.add('trust', 'must be "declarative", "untrusted" or "trusted"');
  else if (trust) out['trust'] = trust;
}

function relations(json: Out, out: Out, p: Problems): void {
  const ext = json['extends'];
  if (ext !== undefined) {
    if (!isStr(ext) || !PLUGIN_ID.test(ext)) p.add('extends', 'must be a plugin id');
    else out['extends'] = ext;
  }
  if (json['kind'] === 'module' && ext === undefined) p.add('extends', 'a module extends exactly one plugin: name it');
  if (ext !== undefined && json['kind'] !== 'module') p.add('kind', 'only a module extends a plugin: set kind to "module"');
  const req = json['requires'];
  if (req !== undefined) {
    if (!isObj(req)) p.add('requires', 'must map plugin or service ids to a range or {version, optional}');
    else {
      const r: Record<string, string | Requirement> = {};
      for (const [k, v] of Object.entries(req)) {
        const at = `requires.${k}`;
        if (!PLUGIN_ID.test(k)) p.add(at, 'must be a plugin id or a service contract id, like "git.service"');
        if (typeof v === 'string') {
          if (!validRange(v)) p.add(at, `"${v}" is not a semver range`);
          r[k] = v;
        } else if (isObj(v)) {
          unknownKeys(v, ['version', 'optional'], at, p);
          if (!validRange(v['version'])) p.add(`${at}.version`, 'must be a semver range');
          if (v['optional'] !== undefined && typeof v['optional'] !== 'boolean') p.add(`${at}.optional`, 'must be true or false');
          r[k] = { version: String(v['version']), ...(v['optional'] === true && { optional: true }) };
        } else p.add(at, 'must be a range or {version, optional}');
      }
      out['requires'] = r;
    }
  }
  const prov = json['provides'];
  if (prov !== undefined) {
    if (!isObj(prov)) p.add('provides', 'must map service contract ids to {version}');
    else {
      const r: Record<string, { version: string }> = {};
      for (const [k, v] of Object.entries(prov)) {
        const at = `provides.${k}`;
        if (!PLUGIN_ID.test(k)) p.add(at, 'must be a service contract id, like "git.service"');
        if (!isObj(v) || !validVersion(v['version'])) p.add(at, 'must be {version: "1.3.0"}');
        else {
          unknownKeys(v, ['version'], at, p);
          r[k] = { version: v['version'] };
        }
      }
      out['provides'] = r;
    }
  }
}

function server(v: unknown, out: Out, p: Problems): void {
  if (v === undefined) return;
  if (isObj(v) && isStr(v['builtin']) && Object.keys(v).length === 1) out['server'] = { builtin: v['builtin'] };
  else if (isObj(v) && Array.isArray(v['exec']) && v['exec'].length > 0 && v['exec'].every(isStr) && Object.keys(v).length === 1) out['server'] = { exec: v['exec'] };
  else p.add('server', 'must be {builtin: "<module>"} or {exec: ["<program>", …args]}');
}

function owned(id: unknown, pid: string, at: string, p: Problems, what: string): id is string {
  if (!isStr(id)) {
    p.add(at, `${what} must be a non-empty string`);
    return false;
  }
  if (pid && !ownedBy(id, pid)) p.add(at, `"${id}" must start with this plugin's prefix ("${pid.slice(pid.indexOf('.') + 1)}." or "${pid}.")`);
  return true;
}

function contributes(v: unknown, pid: string, p: Problems): Out | undefined {
  if (!isObj(v)) {
    p.add('contributes', 'must be an object');
    return undefined;
  }
  const out: Out = {};
  for (const [k, val] of Object.entries(v)) {
    const at = `contributes.${k}`;
    if ((CONTRIB as readonly string[]).includes(k)) continue;
    if (!POINT_KEY.test(k)) unknownKeys({ [k]: val }, CONTRIB, 'contributes', p);
    else if (!isJson(val)) p.add(at, 'a contribution is plain JSON');
    else out[k] = val;
  }
  commands(v['commands'], pid, out, p);
  for (const k of ['events', 'topics', 'parts', 'icons'] as const) {
    const own = k === 'events' || k === 'parts' ? (s: string, at: string) => owned(s, pid, at, p, k) : undefined;
    const list = stringList(v[k], `contributes.${k}`, p, own);
    if (list) out[k] = list;
  }
  points(v['points'], pid, out, p);
  const settings = settingDecls(v['settings'], pid, p);
  if (settings) out['settings'] = settings;
  setSettings(v['setSettings'], pid, out, p);
  const ui = uiDecls(v['ui'], pid, p);
  if (ui) out['ui'] = ui;
  misc(v, out, p);
  return out;
}

function commands(v: unknown, pid: string, out: Out, p: Problems): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) return p.add('contributes.commands', 'must be a list of {id, title}');
  const seen = new Set<string>();
  out['commands'] = v.flatMap((c, i) => {
    const at = `contributes.commands[${i}]`;
    if (!isObj(c)) return p.add(at, 'must be {id, title}'), [];
    unknownKeys(c, ['id', 'title', 'optimistic'], at, p);
    if (!owned(c['id'], pid, `${at}.id`, p, 'id')) return [];
    if (seen.has(c['id'])) p.add(`${at}.id`, `"${c['id']}" is listed twice`);
    seen.add(c['id']);
    if (!isStr(c['title'])) p.add(`${at}.title`, 'every command has a title (the palette shows it)');
    const opt = c['optimistic'];
    if (opt !== undefined && opt !== 'none' && opt !== 'declared') p.add(`${at}.optimistic`, 'must be "none" or "declared"');
    return [{ id: c['id'], title: String(c['title'] ?? ''), ...(opt !== undefined && { optimistic: opt }) }];
  });
}

function points(v: unknown, pid: string, out: Out, p: Problems): void {
  if (v === undefined) return;
  if (!Array.isArray(v)) return p.add('contributes.points', 'must be a list of {id, version, kind}');
  out['points'] = v.flatMap((x, i) => {
    const at = `contributes.points[${i}]`;
    if (!isObj(x)) return p.add(at, 'must be {id, version, kind}'), [];
    unknownKeys(x, ['id', 'version', 'kind'], at, p);
    owned(x['id'], pid, `${at}.id`, p, 'id');
    if (!Number.isInteger(x['version']) || Number(x['version']) < 1) p.add(`${at}.version`, 'every extension point has a version: a whole number from 1');
    if (x['kind'] !== 'list' && x['kind'] !== 'interceptor' && x['kind'] !== 'subscriber') p.add(`${at}.kind`, 'must be "list", "interceptor" or "subscriber"');
    return [{ id: x['id'], version: x['version'], kind: x['kind'] }];
  });
}

function settingDecls(v: unknown, pid: string, p: Problems): SettingDecl[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return p.add('contributes.settings', 'must be a list of setting declarations'), undefined;
  return v.flatMap((d, i) => {
    const at = `contributes.settings[${i}]`;
    if (!isObj(d)) return p.add(at, 'must be {key, type, …}'), [];
    unknownKeys(d, ['key', 'type', 'values', 'min', 'max', 'default', 'overridable', 'scope', 'secret'], at, p);
    owned(d['key'], pid, `${at}.key`, p, 'key');
    const type = d['type'];
    if (!(SETTING_TYPES as readonly unknown[]).includes(type)) p.add(`${at}.type`, `must be one of ${SETTING_TYPES.join(', ')}`);
    if (type === 'enum' && (!Array.isArray(d['values']) || !d['values'].length || !d['values'].every(isStr))) p.add(`${at}.values`, 'an enum lists its values');
    for (const k of ['min', 'max'] as const) if (d[k] !== undefined && typeof d[k] !== 'number') p.add(`${at}.${k}`, 'must be a number');
    if (typeof d['min'] === 'number' && typeof d['max'] === 'number' && d['min'] > d['max']) p.add(`${at}.min`, 'is above max');
    if (d['scope'] !== undefined && d['scope'] !== 'server' && d['scope'] !== 'device') p.add(`${at}.scope`, 'must be "server" or "device"');
    for (const k of ['overridable', 'secret'] as const) if (d[k] !== undefined && typeof d[k] !== 'boolean') p.add(`${at}.${k}`, 'must be true or false');
    const decl = d as unknown as SettingDecl;
    if (d['default'] !== undefined) {
      const why = settingProblem(decl, d['default']);
      if (why) p.add(`${at}.default`, why);
    }
    return [decl];
  });
}

/** Why `value` doesn't fit `decl`, or undefined. Shared with the settings registry. */
export function settingProblem(decl: Pick<SettingDecl, 'type' | 'values' | 'min' | 'max'>, value: unknown): string | undefined {
  switch (decl.type) {
    case 'string':
      return typeof value === 'string' ? undefined : 'must be a string';
    case 'bool':
      return typeof value === 'boolean' ? undefined : 'must be true or false';
    case 'enum':
      return typeof value === 'string' && (decl.values ?? []).includes(value) ? undefined : `must be one of ${(decl.values ?? []).join(', ')}`;
    case 'int':
      if (!Number.isInteger(value)) return 'must be a whole number';
      if (decl.min !== undefined && Number(value) < decl.min) return `must be at least ${decl.min}`;
      return decl.max !== undefined && Number(value) > decl.max ? `must be at most ${decl.max}` : undefined;
    default:
      return isJson(value) ? undefined : 'must be plain JSON';
  }
}

function setSettings(v: unknown, pid: string, out: Out, p: Problems): void {
  if (v === undefined) return;
  if (!isObj(v) || !isJson(v)) return p.add('contributes.setSettings', "must map other plugins' setting keys to values");
  for (const k of Object.keys(v)) if (pid && ownedBy(k, pid)) p.add(`contributes.setSettings.${k}`, 'is this plugin’s own setting: give it a default instead');
  out['setSettings'] = v;
}

function uiDecls(v: unknown, pid: string, p: Problems): UiExtensionDecl[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v)) return p.add('contributes.ui', 'must be a list of extensions'), undefined;
  return v.flatMap((x, i) => {
    const at = `contributes.ui[${i}]`;
    if (!isObj(x)) return p.add(at, 'must be {id, attachTo, …}'), [];
    unknownKeys(x, ['id', 'attachTo', 'component', 'kit', 'config', 'if', 'priority'], at, p);
    // any id: reusing another plugin's extension id is how an override replaces it (plan §6.0.3)
    if (!isStr(x['id'])) p.add(`${at}.id`, 'id must be a non-empty string');
    const to = attachTo(x['attachTo'], `${at}.attachTo`, p);
    if (x['component'] !== undefined && !(isStr(x['component']) && /^\.\/[\w./-]+(#\w+)?$/.test(x['component']))) p.add(`${at}.component`, 'must be "./path#Export" inside the plugin’s ui package');
    if (x['component'] === undefined && x['kit'] === undefined) p.add(at, 'an extension has a component or a kit descriptor');
    for (const k of ['kit', 'config'] as const) if (x[k] !== undefined && !isJson(x[k])) p.add(`${at}.${k}`, 'must be plain JSON');
    if (x['if'] !== undefined && typeof x['if'] !== 'string') p.add(`${at}.if`, 'must be an expression string');
    if (x['priority'] !== undefined && typeof x['priority'] !== 'number') p.add(`${at}.priority`, 'must be a number');
    return to ? [{ ...(x as unknown as UiExtensionDecl), attachTo: to }] : [];
  });
}

function misc(v: Out, out: Out, p: Problems): void {
  const styles = v['partStyles'];
  if (styles !== undefined) {
    const ok = isObj(styles) && Object.values(styles).every((s) => isObj(s) && Object.values(s).every((x) => typeof x === 'string'));
    if (!ok) p.add('contributes.partStyles', 'must map part names to {property: value}');
    else out['partStyles'] = styles;
  }
  const blocks = v['blocks'];
  if (blocks !== undefined) {
    if (!Array.isArray(blocks) || !blocks.every((b) => isObj(b) && isStr(b['type']) && Object.keys(b).every((k) => k === 'type' || k === 'schema') && isJson(b))) p.add('contributes.blocks', 'must be a list of {type, schema?}');
    else out['blocks'] = blocks;
  }
  const recipes = v['recipes'];
  if (recipes !== undefined) {
    if (!Array.isArray(recipes) || !isJson(recipes)) p.add('contributes.recipes', 'must be a list of plain JSON recipes');
    else out['recipes'] = recipes;
  }
}
