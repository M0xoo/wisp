// The grid's own pages. Signed out, it's the site (trywisp.dev's paper, ink and one blue): what a
// grid gives you, the real app, and the way in. Signed in, it's the app (wisp's own tokens and
// rows): your cloud computer, where to use it, your devices and sign-ins. Server-rendered, no
// build; every form posts with a CSRF token. Images come from assets/ (/_grid/a/…).

export { esc, type PageCfg, type PageProvider, type PageUser } from './common.ts';
export { signInPage, devSignInPage, type SignInArgs } from './signin.ts';
export { accountPage, type AccountPageArgs, type IdentityView, type RouteView } from './account.ts';
export type { ComputerView, DeviceView, InstanceView, MachineView, Offers, SiteView } from './home.ts';
export { APP_URL, activatePage, messagePage, wakingPage, type ActivateArgs, type MessageArgs } from './device.ts';
export { sharePassPage, shareViewPage, type ShareCardView, type ShareTaskView, type ShareViewArgs, type WebLook } from './share.ts';
