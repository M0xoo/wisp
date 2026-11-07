// The signed-out site's stylesheet (trywisp.dev's paper, ink and one blue). One string, inlined in
// each page's <style>: the grid's pages have no build step and load nothing but their own images.

export const SITE_CSS = `
:root{--bg:#f4f3ef;--bg-2:#ecebe6;--surface:#fff;--ink:#141414;--ink-2:#3a3a38;--muted:#6c6b66;--faint:#a6a49d;--line:#e1dfd8;--line-2:#d1cfc7;--accent:#2f5bea;--accent-soft:rgba(47,91,234,.1);--good:#18794e;--bad:#cd2b31;--band:#121212;--band-ink:#ededed;--band-muted:#8f8f8f;--band-line:#262626;--win-bar:#ebeae6;
--shadow:0 1px 1px rgba(0,0,0,.04),0 2px 6px rgba(0,0,0,.04),0 40px 80px -40px rgba(30,28,20,.35);
--sans:-apple-system,BlinkMacSystemFont,'SF Pro Text','Inter','Segoe UI',system-ui,sans-serif;--display:-apple-system,BlinkMacSystemFont,'SF Pro Display','Inter','Segoe UI',system-ui,sans-serif;--mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0e0e0d;--bg-2:#151514;--surface:#171717;--ink:#ededeb;--ink-2:#c8c7c2;--muted:#8d8c86;--faint:#5c5b57;--line:#232322;--line-2:#31302e;--accent:#6d8dff;--accent-soft:rgba(109,141,255,.14);--good:#4cc38a;--bad:#ff6369;--band:#161615;--band-line:#2a2a28;--win-bar:#1d1d1c;--shadow:0 1px 1px rgba(0,0,0,.3),0 40px 80px -40px rgba(0,0,0,.9);color-scheme:dark}img.mono{filter:invert(1)}}
*,*::before,*::after{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:72px;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 var(--sans);-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit}img{display:block;max-width:100%;height:auto}code{font-family:var(--mono);font-size:.86em;padding:.12em .38em;border-radius:5px;background:rgba(127,127,127,.12);white-space:nowrap}
h1,h2,h3{font-family:var(--display);margin:0;letter-spacing:-.03em;text-wrap:balance}p{margin:0}
.wrap{max-width:1120px;margin:0 auto;padding:0 28px}
.nav{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--bg) 86%,transparent);backdrop-filter:saturate(1.4) blur(12px);border-bottom:1px solid transparent}
.nav.scrolled{border-bottom-color:var(--line)}
.nav .wrap{display:flex;align-items:center;gap:22px;height:60px}
.brand{display:flex;align-items:center;gap:9px;font-weight:650;font-size:17px;letter-spacing:-.02em;text-decoration:none}
.mark{width:26px;height:14px;flex:none;background:linear-gradient(90deg,var(--ink) 72%,var(--accent) 90%);-webkit-mask:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 45 24%22%3E%3Cpath d=%22M1.1,7L1.6,6.9L1.8,7.1L2.1,7.4L2.5,7.9L2.9,8.8L3.2,9.8L3.6,11L3.9,12.4L4.3,13.8L4.7,15.4L5.1,17L5.6,18.6L5.9,19.7L6.5,20.7L7.1,21.6L7.9,22.4L9,23L10.2,23.3L11.5,23.3L12.7,22.9L13.7,22.2L14.7,21.3L15.5,20.2L16.2,19L16.8,17.9L17.3,16.6L17.9,15.3L18.4,14L19,12.7L19.5,11.5L20,10.3L20.5,9.4L20.9,8.7L21.1,8.4L20.9,8.5L19.9,8.7L18.8,8.5L18.6,8.3L18.8,8.6L19.1,9.3L19.5,10.2L19.9,11.4L20.4,12.6L20.9,14L21.4,15.3L21.9,16.7L22.4,18L23,19.1L23.7,20.4L24.6,21.5L25.6,22.4L26.8,23.1L28.2,23.5L29.6,23.5L30.9,23L32,22.3L32.8,21.4L33.5,20.3L34.1,19.1L34.5,17.9L34.9,16.4L35.2,14.9L35.5,13.4L35.6,11.8L35.7,10.4L35.7,8.9L35.6,7.6L35.3,6.3L35,5.1L34.4,4L33.6,3.1L32.6,2.6L31.6,2.4L30.7,2.6L30,3.1L29.6,3.8L29.4,4.5L29.5,5.3L29.9,6L30.3,6.7L31,7.2L31.9,7.7L33,8L34.2,8.1L35,8L35.8,7.9L36.6,7.8L37.3,7.6L37.9,7.3L38.6,7L39.2,6.6L39.8,6.2L40.3,5.8L40.8,5.4L41.3,4.9L41.7,4.4L41.8,4.2L41.9,3.8L41.8,3.5L41.6,3.3L41.3,3.1L41,3.1L40.7,3.1L40.4,3.3L40,3.8L39.6,4.2L39.2,4.5L38.8,4.9L38.3,5.2L37.8,5.5L37.3,5.8L36.7,6L36.1,6.2L35.5,6.3L34.9,6.4L34.2,6.4L33.2,6.3L32.5,6.1L31.9,5.8L31.6,5.5L31.3,5.2L31.3,4.9L31.3,4.6L31.4,4.5L31.4,4.5L31.4,4.5L31.5,4.6L31.6,4.6L31.9,4.9L32.2,5.4L32.4,6L32.5,6.8L32.5,7.7L32.4,8.8L32.2,10L32,11.3L31.6,12.6L31.2,13.9L30.7,15.1L30.2,16.4L29.8,17.2L29.4,17.8L29.1,18.2L28.8,18.4L28.7,18.4L28.8,18.4L29,18.3L29,18.3L29,18.2L28.8,18L28.4,17.5L28.1,16.6L27.7,15.7L27.3,14.6L26.9,13.4L26.5,12.1L26.1,10.7L25.6,9.4L25.2,8L24.7,6.8L24.1,5.6L23.3,4.4L22,3.3L19.9,2.7L17.8,3.3L16.6,4.4L15.8,5.5L15.1,6.7L14.6,7.9L14,9.3L13.5,10.7L13.1,12L12.6,13.4L12.2,14.7L11.8,15.8L11.5,16.7L11.1,17.6L10.8,18.2L10.5,18.5L10.4,18.6L10.4,18.7L10.5,18.7L10.6,18.7L10.5,18.8L10.3,18.6L10,18.3L9.7,17.8L9.3,17.2L8.7,15.7L8.1,14.2L7.4,12.8L6.8,11.4L6.2,10L5.6,8.8L5,7.7L4.3,6.7L3.5,5.9L2.7,5.3L1.6,5.1L0.7,5.4L0.4,5.5L0.2,5.7L0.1,6L0.1,6.3L0.2,6.6L0.5,6.9L0.8,7Z%22/%3E%3Cpath d=%22M7.5,20.9a2.3,2.3 0 1 0 4.6,0a2.3,2.3 0 1 0 -4.6,0M8,21a2.3,2.3 0 1 0 4.7,0a2.3,2.3 0 1 0 -4.7,0M8.6,21a2.4,2.4 0 1 0 4.7,0a2.4,2.4 0 1 0 -4.7,0M9.1,20.7a2.4,2.4 0 1 0 4.8,0a2.4,2.4 0 1 0 -4.8,0M15.8,6.4a3,3 0 1 0 6,0a3,3 0 1 0 -6,0M16.4,5.9a3,3 0 1 0 6.1,0a3,3 0 1 0 -6.1,0M16.9,5.7a3,3 0 1 0 6.1,0a3,3 0 1 0 -6.1,0M17.4,5.9a3,3 0 1 0 6.1,0a3,3 0 1 0 -6.1,0M17.9,6.4a3,3 0 1 0 6.1,0a3,3 0 1 0 -6.1,0M25.3,20.7a2.6,2.6 0 1 0 5.3,0a2.6,2.6 0 1 0 -5.3,0M25.9,20.9a2.6,2.6 0 1 0 5.2,0a2.6,2.6 0 1 0 -5.2,0M26.6,20.9a2.6,2.6 0 1 0 5.2,0a2.6,2.6 0 1 0 -5.2,0M27.3,20.7a2.5,2.5 0 1 0 5.1,0a2.5,2.5 0 1 0 -5.1,0M30,3.5a1.1,1.1 0 1 0 2.1,0a1.1,1.1 0 1 0 -2.1,0M29.7,3.8a1,1 0 1 0 2,0a1,1 0 1 0 -2,0%22/%3E%3Ccircle cx=%2242.4%22 cy=%222.5%22 r=%222.6%22/%3E%3C/svg%3E") center/contain no-repeat;mask:url("data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 45 24%22%3E%3Cpath d=%22M1.1,7L1.6,6.9L1.8,7.1L2.1,7.4L2.5,7.9L2.9,8.8L3.2,9.8L3.6,11L3.9,12.4L4.3,13.8L4.7,15.4L5.1,17L5.6,18.6L5.9,19.7L6.5,20.7L7.1,21.6L7.9,22.4L9,23L10.2,23.3L11.5,23.3L12.7,22.9L13.7,22.2L14.7,21.3L15.5,20.2L16.2,19L16.8,17.9L17.3,16.6L17.9,15.3L18.4,14L19,12.7L19.5,11.5L20,10.3L20.5,9.4L20.9,8.7L21.1,8.4L20.9,8.5L19.9,8.7L18.8,8.5L18.6,8.3L18.8,8.6L19.1,9.3L19.5,10.2L19.9,11.4L20.4,12.6L20.9,14L21.4,15.3L21.9,16.7L22.4,18L23,19.1L23.7,20.4L24.6,21.5L25.6,22.4L26.8,23.1L28.2,23.5L29.6,23.5L30.9,23L32,22.3L32.8,21.4L33.5,20.3L34.1,19.1L34.5,17.9L34.9,16.4L35.2,14.9L35.5,13.4L35.6,11.8L35.7,10.4L35.7,8.9L35.6,7.6L35.3,6.3L35,5.1L34.4,4L33.6,3.1L32.6,2.6L31.6,2.4L30.7,2.6L30,3.1L29.6,3.8L29.4,4.5L29.5,5.3L29.9,6L30.3,6.7L31,7.2L31.9,7.7L33,8L34.2,8.1L35,8L35.8,7.9L36.6,7.8L37.3,7.6L37.9,7.3L38.6,7L39.2,6.6L39.8,6.2L40.3,5.8L40.8,5.4L41.3,4.9L41.7,4.4L41.8,4.2L41.9,3.8L41.8,3.5L41.6,3.3L41.3,3.1L41,3.1L40.7,3.1L40.4,3.3L40,3.8L39.6,4.2L39.2,4.5L38.8,4.9L38.3,5.2L37.8,5.5L37.3,5.8L36.7,6L36.1,6.2L35.5,6.3L34.9,6.4L34.2,6.4L33.2,6.3L32.5,6.1L31.9,5.8L31.6,5.5L31.3,5.2L31.3,4.9L31.3,4.6L31.4,4.5L31.4,4.5L31.4,4.5L31.5,4.6L31.6,4.6L31.9,4.9L32.2,5.4L32.4,6L32.5,6.8L32.5,7.7L32.4,8.8L32.2,10L32,11.3L31.6,12.6L31.2,13.9L30.7,15.1L30.2,16.4L29.8,17.2L29.4,17.8L29.1,18.2L28.8,18.4L28.7,18.4L28.8,18.4L29,18.3L29,18.3L29,18.2L28.8,18L28.4,17.5L28.1,16.6L27.7,15.7L27.3,14.6L26.9,13.4L26.5,12.1L26.1,10.7L25.6,9.4L25.2,8L24.7,6.8L24.1,5.6L23.3,4.4L22,3.3L19.9,2.7L17.8,3.3L16.6,4.4L15.8,5.5L15.1,6.7L14.6,7.9L14,9.3L13.5,10.7L13.1,12L12.6,13.4L12.2,14.7L11.8,15.8L11.5,16.7L11.1,17.6L10.8,18.2L10.5,18.5L10.4,18.6L10.4,18.7L10.5,18.7L10.6,18.7L10.5,18.8L10.3,18.6L10,18.3L9.7,17.8L9.3,17.2L8.7,15.7L8.1,14.2L7.4,12.8L6.8,11.4L6.2,10L5.6,8.8L5,7.7L4.3,6.7L3.5,5.9L2.7,5.3L1.6,5.1L0.7,5.4L0.4,5.5L0.2,5.7L0.1,6L0.1,6.3L0.2,6.6L0.5,6.9L0.8,7Z%22/%3E%3Cpath d=%22M7.5,20.9a2.3,2.3 0 1 0 4.6,0a2.3,2.3 0 1 0 -4.6,0M8,21a2.3,2.3 0 1 0 4.7,0a2.3,2.3 0 1 0 -4.7,0M8.6,21a2.4,2.4 0 1 0 4.7,0a2.4,2.4 0 1 0 -4.7,0M9.1,20.7a2.4,2.4 0 1 0 4.8,0a2.4,2.4 0 1 0 -4.8,0M15.8,6.4a3,3 0 1 0 6,0a3,3 0 1 0 -6,0M16.4,5.9a3,3 0 1 0 6.1,0a3,3 0 1 0 -6.1,0M16.9,5.7a3,3 0 1 0 6.1,0a3,3 0 1 0 -6.1,0M17.4,5.9a3,3 0 1 0 6.1,0a3,3 0 1 0 -6.1,0M17.9,6.4a3,3 0 1 0 6.1,0a3,3 0 1 0 -6.1,0M25.3,20.7a2.6,2.6 0 1 0 5.3,0a2.6,2.6 0 1 0 -5.3,0M25.9,20.9a2.6,2.6 0 1 0 5.2,0a2.6,2.6 0 1 0 -5.2,0M26.6,20.9a2.6,2.6 0 1 0 5.2,0a2.6,2.6 0 1 0 -5.2,0M27.3,20.7a2.5,2.5 0 1 0 5.1,0a2.5,2.5 0 1 0 -5.1,0M30,3.5a1.1,1.1 0 1 0 2.1,0a1.1,1.1 0 1 0 -2.1,0M29.7,3.8a1,1 0 1 0 2,0a1,1 0 1 0 -2,0%22/%3E%3Ccircle cx=%2242.4%22 cy=%222.5%22 r=%222.6%22/%3E%3C/svg%3E") center/contain no-repeat}
.tag{font:500 12px var(--sans);padding:2px 8px;border-radius:99px;color:var(--accent);background:var(--accent-soft);letter-spacing:0}
.links{display:flex;gap:22px}.links a{font-size:14px;color:var(--muted);text-decoration:none}.links a:hover{color:var(--ink)}
.nav .right{margin-left:auto;display:flex;gap:10px;align-items:center}
.pill{display:inline-flex;align-items:center;gap:8px;height:36px;padding:0 14px;border-radius:10px;font-size:14px;font-weight:550;text-decoration:none;border:1px solid var(--line-2);background:var(--surface);cursor:pointer}
.pill.dark{background:var(--ink);color:var(--bg);border-color:var(--ink)}.pill svg{width:16px;height:16px}
.hero{padding:72px 0 40px}.hero .wrap{display:grid;grid-template-columns:minmax(0,.92fr) minmax(0,1.08fr);gap:56px;align-items:center}
.kicker{font:13px var(--mono);color:var(--muted);display:flex;align-items:center;gap:8px;margin-bottom:18px}.kicker i{width:7px;height:7px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 4px var(--accent-soft)}
h1.big{font-size:clamp(40px,5.4vw,64px);line-height:1.02;font-weight:700}h1.big span{color:var(--faint)}
.lede{margin-top:20px;font-size:17.5px;color:var(--ink-2);max-width:500px}
.join{margin-top:28px;max-width:440px}
.join .btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;height:52px;border-radius:12px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink);font:550 15.5px var(--sans);text-decoration:none;cursor:pointer;transition:border-color .15s,transform .15s}
.join .btn:hover{border-color:var(--faint);transform:translateY(-1px)}.join .btn svg,.join .btn img{width:19px;height:19px}
.join .btn.first{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.join .btn+.btn,.join .btn+.ways{margin-top:10px}
.join .ways{display:grid;grid-template-columns:1fr 1fr;gap:10px}.join .ways .btn{gap:8px;white-space:nowrap}.join .ways .btn+.btn{margin-top:0}
@media (max-width:480px){.join .ways .cw{display:none}}
.join .fine{margin-top:12px;font-size:13px;color:var(--muted);display:flex;flex-wrap:wrap;gap:6px 14px}.join .fine span{display:inline-flex;align-items:center;gap:5px}.join .fine svg{width:14px;height:14px;color:var(--good)}
.join .full{margin:0 0 14px;font-size:14.5px;color:var(--ink-2)}.join .full b{color:var(--ink)}.final .join .full{text-align:center}
.inapp{margin-top:28px;max-width:440px;padding:16px;border-radius:14px;border:1px solid var(--line-2);background:var(--surface)}
.inapp p{font-size:14.5px;color:var(--ink-2)}.inapp p b{color:var(--ink)}
.inapp .ways{display:grid;grid-template-columns:1.4fr 1fr;gap:10px;margin-top:14px}
.inapp .btn{display:flex;align-items:center;justify-content:center;gap:8px;height:48px;padding:0 14px;border-radius:12px;border:1px solid var(--line-2);background:var(--surface);color:var(--ink);font:550 15px var(--sans);text-decoration:none;cursor:pointer;white-space:nowrap;transition:transform .15s,border-color .15s}
.inapp .btn:active{transform:scale(.97)}.inapp .btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.inapp .btn.first{background:var(--ink);color:var(--bg);border-color:var(--ink)}.inapp .btn svg{width:17px;height:17px;flex:none}
.inapp .tip{margin-top:10px;font-size:13px;color:var(--muted)}.inapp .tip b{white-space:nowrap}
.inapp .link{display:block;width:100%;margin-top:10px;height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line-2);background:var(--bg);color:var(--ink);font:16px var(--mono)}
.inapp .mail{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}.inapp .mail label{display:block;font-size:13.5px;color:var(--ink-2);margin-bottom:8px}
.inapp .mail div{display:flex;gap:8px}.inapp .mail input{flex:1;min-width:0;height:44px;padding:0 12px;border-radius:10px;border:1px solid var(--line-2);background:var(--bg);color:var(--ink);font:16px var(--sans)}
.inapp .mail input:focus{outline:0;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}.inapp .mail .btn{height:44px;padding:0 16px}
.inapp .sent{display:flex;align-items:flex-start;gap:8px;color:var(--ink);font-size:14.5px}.inapp .sent svg{width:17px;height:17px;flex:none;margin-top:2px;color:var(--good)}.inapp .err{margin:10px 0 0}
.inapp+.join{margin-top:14px}
.inapp [hidden]{display:none!important}
.err{margin:0 0 14px;padding:11px 14px;border-radius:10px;border:1px solid color-mix(in srgb,var(--bad) 35%,var(--line));color:var(--bad);font-size:14px;background:color-mix(in srgb,var(--bad) 6%,transparent)}
.stage{position:relative}
.win{border-radius:14px;overflow:hidden;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow)}
.win .bar{display:flex;align-items:center;gap:7px;height:34px;padding:0 12px;background:var(--win-bar);border-bottom:1px solid var(--line)}
.win .bar i{width:10px;height:10px;border-radius:50%;background:var(--line-2)}.win .bar i:nth-child(1){background:#ff5f57}.win .bar i:nth-child(2){background:#febc2e}.win .bar i:nth-child(3){background:#28c840}
.win .url{margin:0 auto;font:12px var(--mono);color:var(--muted);padding:3px 12px;border-radius:7px;background:var(--surface);border:1px solid var(--line);display:flex;gap:6px;align-items:center}.win .url svg{width:12px;height:12px;color:var(--good)}
.win picture,.win img{width:100%}
.float{position:absolute;left:-36px;bottom:-30px;width:300px;padding:14px 16px;border-radius:14px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow);font-size:13.5px}
.float .row{display:flex;align-items:center;gap:10px}
.sw{position:relative;width:38px;height:22px;border-radius:99px;background:var(--line-2);border:0;cursor:pointer;flex:none;transition:background .2s}.sw::after{content:'';position:absolute;left:3px;top:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .2s}
.sw[aria-checked=true]{background:var(--ink)}.sw[aria-checked=true]::after{transform:translateX(16px)}
.float b{font-weight:600}.float .t{margin-left:auto;font:12px var(--mono);color:var(--muted)}
.jobs{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.job{padding:8px 10px;border-radius:9px;border:1px solid var(--line);background:var(--bg)}
.job .n{display:flex;justify-content:space-between;gap:8px;font-size:12.5px}.job .n em{font-style:normal;font:11px var(--mono);color:var(--good)}
.job .p{margin-top:6px;height:3px;border-radius:2px;background:var(--line);overflow:hidden}.job .p span{display:block;height:100%;width:30%;background:var(--accent);border-radius:2px;transition:width 1.2s linear}
.where{margin-top:10px;font:12px var(--mono);color:var(--muted)}
.strip{border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-top:56px}
.strip .wrap{display:flex;align-items:center;gap:28px;height:64px;flex-wrap:wrap}.strip .l{font:12.5px var(--mono);color:var(--muted)}
.strip ul{display:flex;gap:24px;list-style:none;margin:0;padding:0;flex-wrap:wrap}.strip li{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:550}.strip li img,.strip li svg{width:18px;height:18px}
section.s{padding:96px 0 0}.num{font:13px var(--mono);color:var(--muted);letter-spacing:.06em;margin-bottom:14px}
h2.t{font-size:clamp(32px,4vw,46px);line-height:1.05;font-weight:700}h2.t span{color:var(--faint)}
.sub{margin-top:16px;font-size:17px;color:var(--ink-2);max-width:580px}
.steps{margin-top:40px;display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.step{padding:22px;border-radius:16px;background:var(--surface);border:1px solid var(--line)}
.step .k{width:34px;height:34px;border-radius:10px;display:grid;place-items:center;background:var(--bg);border:1px solid var(--line);font:600 14px var(--mono)}
.step h3{margin-top:16px;font-size:19px;letter-spacing:-.02em}.step p{margin-top:8px;color:var(--muted);font-size:15px}
.step .chips{margin-top:14px;display:flex;flex-wrap:wrap;gap:6px}.chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:8px;border:1px solid var(--line);font-size:12.5px;background:var(--bg)}.chip img,.chip svg{width:14px;height:14px}
.split{margin-top:40px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px;align-items:start}
.split .win{max-height:560px}.split .win picture img{object-fit:cover;object-position:top}
.points{display:flex;flex-direction:column;gap:22px}.pt h3{font-size:18px;letter-spacing:-.02em}.pt p{margin-top:6px;color:var(--muted);font-size:15px}
.band{margin-top:96px;background:var(--band);color:var(--band-ink);padding:88px 0}
.band .num{color:var(--band-muted)}.band h2.t span{color:#6b6b68}.band .sub{color:#b9b9b5}
.grid4{margin-top:40px;display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--band-line);border:1px solid var(--band-line);border-radius:16px;overflow:hidden}
.grid4 div{background:var(--band);padding:22px}.grid4 svg{width:20px;height:20px;color:#9fb3ff}.grid4 h3{margin-top:14px;font-size:16px;letter-spacing:-.01em}.grid4 p{margin-top:6px;font-size:14px;color:var(--band-muted)}
.band .cmd{margin-top:28px;display:inline-flex;gap:10px;align-items:center;font:13px var(--mono);padding:10px 14px;border-radius:10px;border:1px solid var(--band-line);color:var(--band-ink)}
.final{padding:96px 0;text-align:center}.final h2{font-size:clamp(34px,4.4vw,52px);font-weight:700;line-height:1.04}.final .join{margin:28px auto 0}
.foot{border-top:1px solid var(--line);padding:26px 0 40px;font-size:13px;color:var(--muted)}.foot .wrap{display:flex;gap:18px;flex-wrap:wrap}.foot a{text-decoration:none}.foot a:hover{color:var(--ink)}
.dark-only{display:none}@media (prefers-color-scheme:dark){.dark-only{display:block}.light-only{display:none}}
.narrow{max-width:420px;margin:0 auto;padding:80px 24px}
.card{padding:24px;border-radius:16px;background:var(--surface);border:1px solid var(--line);box-shadow:var(--shadow)}
label.f{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted);margin-top:14px}
.input{height:46px;border-radius:11px;border:1px solid var(--line-2);background:var(--bg);color:var(--ink);padding:0 14px;font:15px var(--sans)}
.input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
@media (max-width:920px){.hero .wrap,.split{grid-template-columns:1fr}.hero{padding-top:40px}.float{position:relative;left:auto;bottom:auto;width:auto;margin:-24px 16px 0}.steps,.grid4{grid-template-columns:1fr 1fr}.links{display:none}}
@media (max-width:600px){.steps,.grid4{grid-template-columns:1fr}.wrap{padding:0 20px}.nav .right .pill:not(.dark){display:none}}
.wait{pointer-events:none;opacity:.75}.wait::after{content:'';width:12px;height:12px;flex:none;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:wait-spin .7s linear infinite}@keyframes wait-spin{to{transform:rotate(360deg)}}
`;
