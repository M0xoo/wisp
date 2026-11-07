// SKILL.md files (v1 web/js/skill-md.js): instructions files a member follows on every job, and
// skills (a name, when to use it, the steps) it reads when a job needs one. Pure.

export const KIT_MAX = 24; // files per member
export const KIT_BODY_MAX = 50_000; // characters per file
export const KIT_TOTAL_MAX = 200_000;
export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const RULES_NAME = /^[\w][\w .-]{0,59}$/;

/** "Release Notes" → "release-notes", as SKILL.md names are written. */
export const skillName = (s: unknown): string =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);

export interface SkillMd {
  name: string;
  description: string;
  body: string;
}

/** Folded (`>`) and literal (`|`) values: the indented lines after the key. */
function folded(lines: readonly string[], i: number, mark: string): { value: string; next: number } {
  const more: string[] = [];
  let j = i;
  while (j + 1 < lines.length && /^(\s+|$)/.test(lines[j + 1] ?? '') && !/^[A-Za-z][\w-]*:/.test(lines[j + 1] ?? '')) more.push((lines[++j] ?? '').trim());
  return { value: more.join(mark.startsWith('|') ? '\n' : ' ').trim(), next: j };
}

/** A SKILL.md → { name, description, body }; without front matter all of it is the body. */
export function parseSkillMd(text: unknown = ''): SkillMd {
  const src = String(text ?? '').replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  if (!fm) return { name: '', description: '', body: src.trim() };
  const meta: Record<string, string> = {};
  const lines = (fm[1] ?? '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i] ?? '');
    if (!kv) continue;
    let v = (kv[2] ?? '').trim();
    if (/^[>|][-+]?$/.test(v)) {
      const f = folded(lines, i, v);
      v = f.value;
      i = f.next;
    }
    meta[(kv[1] ?? '').toLowerCase()] = v.replace(/^(["'])([\s\S]*)\1$/, '$2');
  }
  return { name: meta['name'] ?? '', description: meta['description'] ?? '', body: src.slice(fm[0].length).trim() };
}

/** The SKILL.md a skill in a kit is written out as. */
export const skillMd = ({ name, description, body }: { name: string; description?: string; body?: string }): string =>
  `---\nname: ${name}\ndescription: ${JSON.stringify(String(description ?? '').replace(/\s+/g, ' '))}\n---\n\n${body ?? ''}\n`;
