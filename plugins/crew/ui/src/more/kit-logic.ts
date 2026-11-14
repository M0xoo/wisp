// The kit's rules (v1 crew-kit.js), pure: which files are the same, adding files to a kit, what a
// dropped file becomes, what the editor checks, and what an offer adds.

import { KIT_BODY_MAX, KIT_MAX, parseSkillMd, skillName } from './skill-md.ts';
import type { KitDraft, KitFile, LocalItem } from './types.ts';

/** Same kind and name (any case): one replaces the other. */
export const sameFile = (a: { kind: string; name: string }, b: { kind: string; name: string }): boolean => a.kind === b.kind && a.name.toLowerCase() === b.name.toLowerCase();

/** "820", "1.2k", "34k": a file's size in characters */
export const sizeLabel = (n: number): string => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`);

/** A fresh kit id; `rand` is injected so tests are stable. */
export const newKitId = (rand: () => number = Math.random): string => rand().toString(36).slice(2, 12).padEnd(10, '0');

/** The kit with files added: one with the same kind and name is replaced, keeping its id and switch. */
export function mergeKit(kit: readonly KitFile[], items: readonly KitDraft[], id: () => string = newKitId): KitFile[] {
  const out = kit.map((k) => ({ ...k }));
  for (const it of items) {
    const at = out.findIndex((k) => sameFile(k, it));
    const prev = out[at];
    if (prev) out[at] = { ...prev, ...it, id: prev.id };
    else out.push({ id: id(), on: true, ...it });
  }
  return out;
}

export const fitsKit = (count: number, more: number): boolean => count + more <= KIT_MAX;

/** A dropped or picked file: a SKILL.md (or one with a name and description up top) is a skill. */
export function fileToKit(name: string, text: string): KitDraft {
  const sk = parseSkillMd(text);
  if (/^skill\.md$/i.test(name) || (sk.name && sk.description)) {
    const n = skillName(sk.name || name.replace(/\.\w+$/, ''));
    return { kind: 'skill', name: n, description: sk.description || `Use for ${n.replace(/-/g, ' ')}.`, body: sk.body.slice(0, KIT_BODY_MAX) };
  }
  return { kind: 'rules', name: name.replace(/[^\w .-]/g, '').slice(0, 60) || 'AGENTS.md', body: text.trim().slice(0, KIT_BODY_MAX) };
}

/** Files that may be a kit file: markdown or text, not too big. */
export const kitFileOk = (name: string, size: number): boolean => /\.(md|markdown|txt)$/i.test(name) && size <= KIT_BODY_MAX * 2;

export type LocalPick = LocalItem & { kind: 'skill' | 'rules' };

/** Picked local files → drafts: a second instructions file with a taken name is named after where it came from. */
export function localToKit(kit: readonly KitFile[], picked: readonly LocalPick[]): KitDraft[] {
  return picked.map((it, i) => {
    const clash = it.kind === 'rules' && [...kit, ...picked.slice(0, i)].some((k) => sameFile(k, it));
    const name = clash
      ? it.from
          .replace(/[^\w .-]+/g, ' ')
          .replace(/^[^\w]+/, '')
          .trim()
          .slice(-60)
      : it.name;
    return { kind: it.kind, name, ...(it.kind === 'skill' && { description: it.description || `Use for ${it.name.replace(/-/g, ' ')}.` }), body: it.body, ...(it.path !== undefined && { path: it.path }) };
  });
}

/** A local file that's in the kit already (same file, same text). */
export const alreadyHas = (kit: readonly KitFile[], it: { kind: string; name: string; body: string }): boolean => kit.some((k) => sameFile(k, it) && k.body === it.body);

/** What the editor checks before saving: the missing field, or a clash with another file. */
export function checkDraft(kit: readonly KitFile[], d: KitDraft, editing: string | undefined): { missing?: 'name' | 'description' | 'body'; clash?: boolean } {
  const fields: ('name' | 'description' | 'body')[] = d.kind === 'skill' ? ['name', 'description', 'body'] : ['name', 'body'];
  const missing = fields.find((k) => !String(d[k] ?? '').trim());
  if (missing) return { missing };
  return kit.some((k) => k.id !== editing && sameFile(k, d)) ? { clash: true } : {};
}

/** A whole SKILL.md pasted into a skill's body: its name, When and steps; undefined when it isn't one. */
export function pastedSkill(body: string): { name: string; description: string; body: string } | undefined {
  if (!body.startsWith('---\n')) return undefined;
  const sk = parseSkillMd(body);
  return sk.body === body.trim() ? undefined : { name: sk.name ? skillName(sk.name) : '', description: sk.description, body: sk.body };
}

/** An offer's files you left ticked and haven't already added through the editor. */
export const offerPicks = <F extends { name: string }>(files: readonly F[], off: ReadonlySet<number>, done: ReadonlySet<string>): F[] => files.filter((f, i) => !off.has(i) && !done.has(f.name));

/** How a proposed file compares to the member's own: 'same' | 'replaces' | undefined (new). */
export function offerTag(kit: readonly KitFile[], f: KitDraft): 'same' | 'replaces' | undefined {
  const was = kit.find((k) => sameFile(k, f));
  return was ? (was.body === f.body ? 'same' : 'replaces') : undefined;
}
