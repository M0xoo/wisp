// The iPhone home-screen app on wisp Grid: Safari → Share → Add to Home Screen gives a full-screen
// wisp that opens from the service worker's cache (cache.js startShell) and keeps out of the notch
// and the home indicator (html.standalone: index.html's first script, split.css).
// Only on a Grid: the manifest and Apple's tags go in once /config says so, so a desktop browser on
// this computer is never offered to install wisp, and the Android app (MOBILE) is left as it is.
// Alerts there come from the ntfy app (Settings → Phone): iOS lets a home-screen app notify only
// through Web Push, which wisp doesn't send yet.

import { IOS, MOBILE, STANDALONE, inGrid, load, save } from '../core/state.js';

const SEEN = 'wisp.installSeen';
let tagged = false;

// The head tags iOS reads when the page is added to the Home Screen, and the theme colours for its
// status bar (the light and dark backgrounds, web/css/tokens.css).
export function homeScreenTags() {
  if (tagged || MOBILE || !inGrid()) return;
  tagged = true;
  const tags = [
    ['link', { rel: 'manifest', href: '/manifest.webmanifest' }],
    ['meta', { name: 'apple-mobile-web-app-capable', content: 'yes' }],
    ['meta', { name: 'mobile-web-app-capable', content: 'yes' }],
    ['meta', { name: 'apple-mobile-web-app-status-bar-style', content: 'black-translucent' }],
    ['meta', { name: 'apple-mobile-web-app-title', content: 'wisp' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: light)', content: '#ffffff' }],
    ['meta', { name: 'theme-color', media: '(prefers-color-scheme: dark)', content: '#111111' }],
  ];
  for (const [tag, attrs] of tags) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    document.head.append(n);
  }
}

// Home's card (home.install): on a Grid, in an iPhone's browser, until it's added or dismissed.
export const installHint = () => inGrid() && IOS && !MOBILE && !STANDALONE && !load(SEEN, false);
export function dismissInstall() {
  save(SEEN, true);
}
