// The signed-out site's frame: head (meta, Open Graph, the hosted grid's analytics), nav and footer.

import { posthogKey } from '../shared/posthog.ts';
import { A, PENDING, esc, tag, type PageCfg } from './common.ts';
import { SITE_CSS } from './site-css.ts';

const DESC = 'Your own wisp on a server: Claude Code, Codex and the rest keep working when your laptop closes, and the report waits on your phone.';

// The hosted grid's sign-in page counts visits and clicks in wisp's PostHog project, like
// trywisp.dev, so the funnel reads site → this page → GitHub → signed up. Its cookie is on
// .trywisp.dev, so it's the same anonymous visitor as on the site. Self-hosted grids load nothing.
const POSTHOG_STUB = String.raw`!function(t,e){var o,n,p,r;e.__SV||(window.posthog && window.posthog.__loaded)||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}p||((p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",p.onerror=function(){p=null},(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r));var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],Object.defineProperty(u,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e}}),Object.defineProperty(u.people,"toString",{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+".people (stub)"}}),o="vu pu gu mu init Gu Qu Hu Wu Xu il Vu Yu ju oc ac lc uc cc hc capture getExtension Zu hu gc calculateEventProperties vc register register_once register_for_session unregister unregister_for_session zu mc getFeatureFlag getFeatureFlagPayload getFeatureFlagResult getAllFeatureFlags isFeatureEnabled reloadFeatureFlags updateFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSurveysLoaded onSessionId getSurveys getActiveMatchingSurveys onActiveMatchingSurveysChanged renderSurvey displaySurvey cancelPendingSurvey canRenderSurvey canRenderSurveyAsync wc identify setPersonProperties unsetPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset kc shutdown setIdentity clearIdentity get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException addExceptionStep captureLog startExceptionAutocapture stopExceptionAutocapture loadToolbar get_property getSessionProperty yc nc createPersonProfile setInternalOrTestUser bc xu ku opt_in_capturing opt_out_capturing Su has_opted_in_capturing has_opted_out_capturing get_explicit_consent_status is_capturing clear_opt_in_out_capturing tc debug nl Os getPageViewId captureTraceFeedback captureTraceMetric Du".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`;
const analyticsScript = (): string => `<script>${POSTHOG_STUB}
posthog.init(${JSON.stringify(posthogKey())},{api_host:'https://us.i.posthog.com',defaults:'2026-05-30',person_profiles:'identified_only'});
document.addEventListener('click',(e)=>{const a=e.target.closest('a[href^="/auth/"]');if(a)posthog.capture('grid_signin_clicked',{provider:decodeURIComponent(a.pathname.split('/')[2]||'')},{transport:'sendBeacon'})});</script>`;

export function siteHead(title: string, cfg: PageCfg, analytics = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="referrer" content="same-origin"><meta name="description" content="${DESC}">
<link rel="canonical" href="${esc(cfg.publicUrl)}/"><meta property="og:type" content="website"><meta property="og:url" content="${esc(cfg.publicUrl)}/"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${DESC}"><meta property="og:image" content="${esc(cfg.publicUrl)}${A}/og.png"><meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="${A}/icon.svg"><style>${SITE_CSS}</style>${analytics ? analyticsScript() : ''}</head><body>
<header class="nav" id="nav"><div class="wrap"><a class="brand" href="/"><span class="mark"></span>wisp<span class="tag">${esc(tag(cfg))}</span></a>
<nav class="links"><a href="#how">How it works</a><a href="#report">What you get back</a><a href="#private">Private by design</a></nav>
<div class="right"><a class="pill" href="https://trywisp.dev" target="_blank" rel="noopener">trywisp.dev</a><a class="pill dark" href="#join">Sign in</a></div></div></header>`;
}
export const siteFoot = (cfg: PageCfg): string => `<footer class="foot"><div class="wrap"><span>${esc(cfg.name)} · ${esc(cfg.domain)}</span><a href="https://trywisp.dev" target="_blank" rel="noopener">wisp</a><a href="https://github.com/M0xoo/wisp" target="_blank" rel="noopener">Open source (MIT)</a><a href="https://github.com/M0xoo/wisp/tree/main/grid" target="_blank" rel="noopener">Run your own grid</a></div></footer>
<script>addEventListener('scroll',()=>document.getElementById('nav').classList.toggle('scrolled',scrollY>8),{passive:true})</script>${PENDING}</body></html>`;

// The hosted grid's waitlist lives on trywisp.dev; a self-hosted grid that's full just says so.
