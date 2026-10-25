// In-app browsers: X, Instagram, Facebook and friends open links in their own web view. Google
// refuses to sign anyone in there (403 disallowed_useragent) and nobody is signed in to GitHub in
// it, so the sign-in page offers the phone's real browser instead. docs/main.js has the same list
// for trywisp.dev: keep the two in step.

const APPS = [
  ['X', /Twitter for i(Phone|Pad)|TwitterAndroid/],
  ['Instagram', /Instagram/],
  ['Facebook', /FBAN|FBAV|FB_IAB|FBIOS/],
  ['LinkedIn', /LinkedInApp/],
  ['Threads', /Barcelona/],
  ['TikTok', /BytedanceWebview|musical_ly|TikTok/],
  ['Snapchat', /Snapchat/],
];

// { app, os } for an in-app browser ('ios' | 'android' | ''), or null for a real one.
export function inAppBrowser(ua = '') {
  ua = String(ua || '');
  const os = /iPhone|iPad|iPod/.test(ua) ? 'ios' : /Android/.test(ua) ? 'android' : '';
  const hit = APPS.find(([, re]) => re.test(ua));
  if (hit) return { app: hit[0], os };
  // Any other Android app's web view says "; wv)".
  if (os === 'android' && /; wv\)/.test(ua)) return { app: 'this app', os };
  return null;
}

// A link that leaves the app for the phone's browser: Chrome on Android (an intent, falling back
// to the page itself), Safari on iOS 17+ (x-safari-https://). Elsewhere, the page as it is.
export function openOutside(url, os) {
  const u = new URL(url);
  if (os === 'android') return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`;
  if (os === 'ios') return `x-safari-${url}`;
  return url;
}

export const browserName = (os) => (os === 'android' ? 'Chrome' : os === 'ios' ? 'Safari' : 'your browser');
