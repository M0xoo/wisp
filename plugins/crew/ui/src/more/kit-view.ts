// The kit section's view (v1 crew-kit.js kitHtml, importDialog, ideas, offerHtml), pure: rows a member's kit shows,
// the files on this computer it can take, the Generate dialog's ideas, and what an offer shows and adds.

import { alreadyHas, mergeKit, offerPicks, offerTag, sizeLabel } from './kit-logic.ts';
import { KIT_MAX } from './skill-md.ts';
import type { KitDraft, KitFile, LocalKitFile, Member } from './types.ts';
import type { Offer } from '../types.ts';

export type Say = (k: string, v?: Readonly<Record<string, string | number>>) => string;

export interface KitRowView {
  id: string;
  kind: 'skill' | 'rules';
  name: string;
  note: string;
  on: boolean;
  title: string;
  toggle: string;
}

/** The section's rows: a skill says when it's read, instructions how big they are (v1 kitHtml). */
export function kitRows(m: Pick<Member, 'kit' | 'spell'>, say: Say): KitRowView[] {
  return (m.kit ?? []).map((k) => ({
    id: k.id,
    kind: k.kind,
    name: k.name,
    note: k.kind === 'skill' ? (k.description ?? '') : say('wisp.crew.more.kit.every', { n: sizeLabel(k.body.length) }),
    on: k.on !== false,
    title: m.spell ? say('wisp.crew.more.kit.fromSpell', { name: m.spell.name }) : say(k.kind === 'skill' ? 'wisp.crew.more.kit.editSkill' : 'wisp.crew.more.kit.editRules'),
    toggle: say('wisp.crew.more.kit.use', { name: k.name }),
  }));
}

/** The kit with one file switched (kept, not used, while off). */
export const toggled = (kit: readonly KitFile[], id: string, on: boolean): KitFile[] => kit.map((k) => (k.id === id ? { ...k, on } : k));

/** A file found on this computer, as a kit file would take it; `undefined` when it had no text to copy. */
export function localDraft(f: LocalKitFile): KitDraft | undefined {
  if (!f.body?.trim()) return undefined;
  const skill = f.from === 'home';
  return { kind: skill ? 'skill' : 'rules', name: f.name, ...(skill && { description: f.description || `Use for ${f.name.replace(/-/g, ' ')}.` }), body: f.body, ...(skill && f.path && { path: f.path }) };
}

export interface LocalRow {
  key: string;
  draft: KitDraft;
  from: string;
  added: boolean;
}

/** The files on this computer the kit can take, those with text, marked when the kit has them already. */
export function localRows(kit: readonly KitFile[], files: readonly LocalKitFile[]): LocalRow[] {
  return files.flatMap((f, i) => {
    const d = localDraft(f);
    return d ? [{ key: String(i), draft: d, from: f.path, added: alreadyHas(kit, d) }] : [];
  });
}

/** v1 ideas(m): what the Generate dialog suggests, the first its placeholder. */
export function ideas(m: Pick<Member, 'role' | 'kit'>, say: Say): string[] {
  return [
    m.role ? say('wisp.crew.more.gen.idea.best', { role: m.role }) : say('wisp.crew.more.gen.idea.bestEng'),
    say('wisp.crew.more.gen.idea.conv'),
    say('wisp.crew.more.gen.idea.skill'),
    ...((m.kit ?? []).length ? [say('wisp.crew.more.gen.idea.improve')] : []),
  ];
}

/** What Start sends: the goal typed, or the first idea (v1 generateDialog submit). */
export const kitGoal = (typed: string, first: string): string => typed.trim() || `${first}.`;

export interface OfferPlan {
  kit: KitFile[];
  offers: { id: string; state: 'taken' | 'dismissed'; names: string[] }[];
}

/** Add: the ticked files join the kit (the same name replaces), and the offer is settled with their names. `tooMany` when
 * the kit would pass its cap. */
export function addOffer(kit: readonly KitFile[], o: Offer, off: ReadonlySet<number>, done: ReadonlySet<string>, id?: () => string): OfferPlan | 'tooMany' {
  const files = offerPicks(o.files as KitDraft[], off, done);
  const next = mergeKit(kit, files, id);
  if (next.length > KIT_MAX) return 'tooMany';
  return { kit: next, offers: [{ id: o.id, state: 'taken', names: [...done, ...files.map((f) => f.name)] }] };
}

/** Dismiss (or Done, after adding some through the editor). */
export const dropOffer = (o: Offer, done: ReadonlySet<string>): OfferPlan['offers'] => [{ id: o.id, state: done.size ? 'taken' : 'dismissed', names: [...done] }];

/** The pill beside an offer's file. */
export function offerPill(kit: readonly KitFile[], f: KitDraft, done: boolean, say: Say): string | undefined {
  if (done) return say('wisp.crew.more.local.added');
  const tag = offerTag(kit, f);
  return tag ? say(tag === 'same' ? 'wisp.crew.more.offer.same' : 'wisp.crew.more.offer.replaces') : undefined;
}

/** The open offer (or settled one) a job's thread shows under it: the newest for that job. */
export const offerOf = (offers: readonly Offer[] | undefined, job: string): Offer | undefined => (offers ?? []).find((o) => o.job === job);
