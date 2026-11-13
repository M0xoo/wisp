// Import crew's box and picks (ImportCrew.tsx): plain, so their tests needn't compile the dialog.

export type Src = { readonly text: string } | { readonly url: string };
export type Picks = Record<string, { name: string; skip: boolean }>;

/** What the box holds: a link (https, a share link, gist:) is fetched by the host, anything else is the bundle's text.
 * Plain http only for a share link (`/s/<id>`, a self-hosted grid on this network). */
export const srcOf = (v: string): Src =>
  /^(https:\/\/|gist:|wisp:\/\/open\/|grid:\/\/)/i.test(v.trim()) || /^http:\/\/[^/\s]+\/s\/[^/\s]+\/?$/i.test(v.trim()) ? { url: v.trim() } : { text: v };

/** Who joins: the ticked ones, each with the name it gets. */
export const joining = (picks: Picks): number => Object.values(picks).filter((p) => !p.skip).length;
