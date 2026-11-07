// The crew's second half: kit (skills and instructions), notebook, track record, share and import,
// team (delegates) and Org. The member page (../member) shows KitSection and NotebookSection; the
// rest are views (../views.ts) registered here. Components load with import() on first show.

import { lazy } from 'solid-js';
import type { ExtensionDef, ViewDef } from '@wisp/shell/contract';
import type { MemberSectionProps } from './props.ts';

export type { MemberSectionProps } from './props.ts';

/** Skills and instructions, on the member page (v1 crew-kit.js). */
export const KitSection = lazy(() => import('./KitSection.tsx'));
/** The member's notebook, on the member page (v1 crew.js notebookEditor). */
export const NotebookSection = lazy(() => import('./NotebookSection.tsx'));
/** Its delegates, on the member page and the editor (v1 team.js). */
export const TeamSection = lazy(() => import('./TeamSection.tsx'));

/** Kit files a job proposed, under that job in the thread (v1 crew.js paintOffers). */
export const OffersSection = lazy(() => import('./OffersSection.tsx'));

export const moreExtensions: ExtensionDef[] = [];
export const moreViews: ViewDef[] = [];

