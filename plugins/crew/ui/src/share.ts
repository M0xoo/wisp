// Share… (v1 crew-share.js shareMember), pure: what can go along (kit, notebook, delegates) for these members, the
// export's args for the options ticked, the notes worth showing, and the text a bundle is copied or saved as.

import type { Member } from './types.ts';

export interface ShareOpts {
  kit: boolean;
  notebook: boolean;
  team: boolean;
}

export interface ShareWhat {
  /** files across their kits */
  kits: number;
  /** someone has a notebook to share */
  noted: boolean;
  /** one member's crew delegates (other members), who stay here unless ticked */
  mates: string[];
  /** the options as they start: the kit when there is one, never the notebook or delegates */
  start: ShareOpts;
}

export function shareWhat(members: readonly Pick<Member, 'id' | 'kit' | 'notebook' | 'team'>[], all: readonly Pick<Member, 'id' | 'name'>[]): ShareWhat {
  const kits = members.reduce((n, m) => n + (m.kit?.length ?? 0), 0);
  const noted = members.some((m) => !!m.notebook?.trim());
  const one = members.length === 1 ? members[0] : undefined;
  const mates = one ? (one.team ?? []).flatMap((x) => (x.crew ? (all.find((m) => m.id === x.crew)?.name ?? []) : [])) : [];
  return { kits, noted, mates, start: { kit: kits > 0, notebook: false, team: false } };
}

/** The peer's notes, without the one the delegates option already says (who stays here). */
export const shareNotes = (notes: readonly string[], mates: readonly string[]): string[] => notes.filter((n) => !(mates.length && / delegates to .*, who stays here/.test(n)));

/** The file as it is saved or copied (v1: pretty, with a newline at the end). */
export const bundleText = (bundle: unknown): string => `${JSON.stringify(bundle, null, 2)}\n`;
