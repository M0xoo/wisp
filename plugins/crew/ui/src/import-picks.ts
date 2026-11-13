// Import crew's box and picks (ImportCrew.tsx): plain, so their tests needn't compile the dialog.

export type Src = { readonly text: string } | { readonly url: string; readonly password?: string };
export type Picks = Record<string, { name: string; skip: boolean }>;

/** What the box holds: a link (https, a share link, gist:) is fetched by the host, anything else is the bundle's text.
 * Plain http only for a share link (`/s/<id>`, a self-hosted grid on this network). */
export const srcOf = (v: string): Src =>
  /^(https:\/\/|gist:|wisp:\/\/open\/|grid:\/\/)/i.test(v.trim()) || /^http:\/\/[^/\s]+\/s\/[^/\s]+\/?$/i.test(v.trim()) ? { url: v.trim() } : { text: v };

/** Who joins: the ticked ones, each with the name it gets. */
export const joining = (picks: Picks): number => Object.values(picks).filter((p) => !p.skip).length;

/** The box's source with the link's password, once the review asked for one (a pasted file has none). */
export const withPassword = (src: Src, password: string): Src => ('url' in src && password.trim() ? { url: src.url, password: password.trim() } : src);

/** A review the grid answered `locked: "password"`: the password box shows, and says when the one tried didn't open it. */
export const lockedOf = (r: { readonly locked?: string; readonly wrong?: boolean }): { wrong: boolean } | undefined =>
  r.locked === 'password' ? { wrong: !!r.wrong } : undefined;
