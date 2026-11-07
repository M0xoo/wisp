// What every grid page shares: escaping, the icons, the pending-button script, the config a page
// reads, and the screenshots. Server-rendered HTML strings: the grid is its own deployment with no
// build step, so its pages are plain templates (not the Solid kit, which is wisp's own UI).

import type { GridConfig } from '../config.ts';

/** The part of the grid's config a page reads. */
export type PageCfg = Pick<GridConfig, 'name' | 'domain' | 'publicUrl' | 'instanceUrl'>;

/** Who a signed-in page is for. */
export interface PageUser {
  handle: string;
  name?: string | null;
  email?: string | null;
  avatar?: string | null;
}

/** A sign-in provider as pages show it (auth/providers.ts). */
export interface PageProvider {
  id: string;
  label: string;
}

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const A = '/_grid/a';
export const I = {
  github: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.04-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.58.23 2.75.11 3.04.74.81 1.19 1.83 1.19 3.09 0 4.41-2.7 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>',
  google: '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.67-.22-2.45H12v4.64h6.45a5.52 5.52 0 0 1-2.4 3.62v3h3.88c2.27-2.09 3.57-5.17 3.57-8.81Z"/><path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.9l-3.88-3.01c-1.07.72-2.45 1.15-4.06 1.15-3.13 0-5.78-2.11-6.72-4.95H1.27v3.11A12 12 0 0 0 12 24Z"/><path fill="#FBBC05" d="M5.28 14.29a7.2 7.2 0 0 1 0-4.58V6.6H1.27a12 12 0 0 0 0 10.8l4.01-3.11Z"/><path fill="#EA4335" d="M12 4.77c1.76 0 3.34.61 4.59 1.8l3.44-3.44A11.97 11.97 0 0 0 12 0 12 12 0 0 0 1.27 6.6l4.01 3.11C6.22 6.88 8.87 4.77 12 4.77Z"/></svg>',
  key: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="15" r="4" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  code: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 8l-4 4 4 4M16 8l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h13M13 6.5l5.5 5.5-5.5 5.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  laptop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="11" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M2.5 19h19" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M11 18.5h2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  globe: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  cloud: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 18.5h10a4 4 0 00.6-7.95A5.5 5.5 0 007.6 9.1 4.75 4.75 0 007.5 18.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V6a2 2 0 00-2-2H6a2 2 0 00-2 2v8a2 2 0 002 2h2" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>',
  shield: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6L12 3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M9.5 7V4.8h5V7M6.5 7l.9 12.2a1.5 1.5 0 001.5 1.3h6.2a1.5 1.5 0 001.5-1.3L17.5 7M10 11v5.5M14 11v5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  chev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stack: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="6.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M7.5 7.25h.01M7.5 16.75h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 3L5.5 13.5H12L11 21l7.5-10.5H12L13 3z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
  gpu: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><rect x="9.5" y="9.5" width="5" height="5" rx=".8" fill="currentColor" opacity=".35"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V4M7.5 8.5L12 4l4.5 4.5M5 13.5V19a1.5 1.5 0 001.5 1.5h11A1.5 1.5 0 0019 19v-5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  moon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>',
} as const;
export type IconName = keyof typeof I;
const icon = (k: string): string | undefined => (Object.hasOwn(I, k) ? I[k as IconName] : undefined);
export const logo = (id: string): string => icon(id) || icon(id.split(':')[0] ?? '') || (id === 'dev' ? I.code : I.key);
export const AGENTS: readonly (readonly [file: string, name: string, cls: string])[] = [
  ['claudecode-color.svg', 'Claude Code', ''],
  ['codex-color.svg', 'Codex', ''],
  ['opencode.svg', 'opencode', 'mono'],
  ['cursor.svg', 'Cursor', 'mono'],
];


// Every form and sign-in link: the button spins at once while the next page loads (a provider's
// redirect, Allow, Sign out), and a second press does nothing. Back from the browser cache clears it.
// Script that sends a form itself cancels the submit first: then it's not pending here.
export const PENDING = `<script>(()=>{const go=(b)=>{if(b)setTimeout(()=>{b.classList.add('wait');b.setAttribute('aria-busy','true')})};document.addEventListener('submit',(e)=>{if(e.defaultPrevented)return;const b=e.submitter||e.target.querySelector('button');if(b&&b.classList.contains('wait'))return e.preventDefault();go(b)});document.addEventListener('click',(e)=>{const a=e.target.closest('a[href^="/auth/"]');if(a)go(a)});addEventListener('pageshow',()=>document.querySelectorAll('.wait').forEach((b)=>{b.classList.remove('wait');b.removeAttribute('aria-busy')}))})()</script>`;

// The word beside the logo follows the grid's name, so grid.json's "name": "wisp Cloud" shows Cloud.
export const tag = (cfg: Pick<PageCfg, 'name'>): string => (cfg.name || 'wisp Grid').replace(/^wisp\s+/i, '') || 'Grid';

export const shot = (name: string, alt: string): string => `<picture><source srcset="${A}/dark-${name}.webp" media="(prefers-color-scheme: dark)"><img src="${A}/light-${name}.webp" alt="${esc(alt)}" decoding="async"></picture>`;
