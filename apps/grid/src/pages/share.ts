// A shared task (shares.ts) at <publicUrl>/s/<id>: its passkey page, and the task drawn in wisp's
// own look.

import { esc, type PageCfg } from './common.ts';
import { appPage } from './layout.ts';

export interface ShareFrom {
  name?: string | null;
  handle?: string | null;
  avatar?: string | null;
}
/** A share's card (shares.card): what anyone with the link may see before its passkey. */
export interface ShareCardView {
  url: string;
  title: string;
  from?: ShareFrom | null;
  [k: string]: unknown;
}
/** The task in a share (shares.task): drawn by web/js/share-view.js; the page reads only its runs' names. */
export interface ShareTaskView {
  runs?: Record<string, { name?: string } | undefined>;
  [k: string]: unknown;
}
/** wisp's page look, read from its index.html by the edge: stylesheet hrefs and the icon sprite. */
export interface WebLook {
  styles: string[];
  sprite: string;
}
export interface ShareViewArgs {
  share: ShareCardView;
  task: ShareTaskView;
  run?: string | null;
  look: WebLook;
}

// A shared task (grid/shares.js) at <publicUrl>/s/<id>, behind its passkey when it has one.
const SHARE_CSS = `
.sh-head{display:flex;align-items:flex-start;gap:14px}.sh-head .av{width:36px;height:36px;font-size:14px;flex:none}
.sh-lock{margin-top:18px;display:flex;gap:8px}.sh-lock .input{text-transform:none;letter-spacing:0;font:15px var(--sans)}
`;
const avatarOf = (from: ShareFrom | null | undefined): string => (from?.avatar ? `<span class="av"><img src="${esc(from.avatar)}" alt=""></span>` : `<span class="av">${esc((from?.name || from?.handle || '?').trim()[0]?.toUpperCase() || '?')}</span>`);

// A locked share: only its passkey opens it. Who shared it shows; nothing else does.
export function sharePassPage({ cfg, share, wrong = false }: { cfg: PageCfg; share: ShareCardView; wrong?: boolean }): string {
  return appPage({
    cfg,
    title: 'Shared task',
    narrow: true,
    head: `<style>${SHARE_CSS}</style>`,
    body: `<div class="sh-head">${avatarOf(share.from)}<div><h1 class="h1">A shared task</h1><p class="sub">${esc(share.from?.name || share.from?.handle || 'Someone')} locked it with a passkey. Ask them for it.</p></div></div>
      <form method="post" class="sh-lock"><input class="input tall" type="password" name="passkey" placeholder="Passkey" autocomplete="off" autofocus required aria-label="Passkey"><button class="primary tall">Open</button></form>
      ${wrong ? '<div class="flash bad">That passkey isn’t right.</div>' : ''}`,
  });
}

// A shared task's page in wisp's own look (web/js/share-view.js draws it with wisp's stylesheets
// and block renderer, served by the grid from web/). What it shows is embedded as JSON; until the
// script runs, the head and placeholders in the task page's shapes hold its place.
// look: { styles: [hrefs], sprite: '<svg …>' } read from web/index.html.
export function shareViewPage({ share, task, run = null, look }: ShareViewArgs): string {
  const base = new URL(share.url).pathname;
  const json = JSON.stringify({ share, task, run, base }).replace(/</g, '\\u003c');
  const title = run ? `@${task.runs?.[run]?.name || run}` : share.title;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)} · shared on wisp</title><meta name="referrer" content="same-origin"><meta name="robots" content="noindex">
<meta property="og:title" content="${esc(share.title)}"><meta property="og:description" content="${esc(`Shared by ${share.from?.name || share.from?.handle || 'someone'} on wisp`)}">
<link rel="icon" href="/favicon.svg">${look.styles.map((h) => `<link rel="stylesheet" href="${esc(h)}">`).join('')}</head>
<body class="share-view">${look.sprite}
<header class="sv-top"><a class="sv-brand" href="https://trywisp.dev" target="_blank" rel="noopener"><img src="/favicon.svg" alt="">wisp</a><span class="sv-tag">Shared task</span></header>
<div class="sv-wrap">
  <main class="sv-main">
    <header class="split-head sv-head" id="svHead"><div class="sh-row"><span class="q-dot"></span><h2 class="sh-title">${esc(title)}</h2></div></header>
    <div class="sv-turns" id="svTurns" aria-busy="true"><div class="sv-sk"><i class="sk sk-line"></i><i class="sk sk-block"></i></div><div class="sv-sk"><i class="sk sk-line"></i><i class="sk sk-block"></i></div></div>
  </main>
  <aside class="sv-side it-bar" id="svSide"><i class="sk sk-pill"></i><i class="sk sk-line"></i><i class="sk sk-line short"></i></aside>
</div>
<div class="overlay" id="overlay" hidden></div>
<div class="toasts" id="toasts"></div>
<script type="application/json" id="shareData">${json}</script>
<script type="module" src="/js/share-view.js"></script>
</body></html>`;
}
