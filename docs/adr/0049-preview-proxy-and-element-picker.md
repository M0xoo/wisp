# ADR-0049: Preview's proxy, and the element picker it adds to the app's pages

- Status: accepted
- Date: 2026-11-12
- Source: the owner's round-27 queue ("Preview's element picker: Rust proxy injecting v1's pick script, edge cases in an
  ADR if it's a new kind of route"); v1 server/runs.js `#proxy`, `frameable`, `withPicker`, `PICK_JS`; web/js/features
  run.js (Pick) and panel.js (addToReply). With ADR-0003 (everything is a plugin), ADR-0036 (untrusted UI in a frame).

## Context

The side panel's Preview runs the task's app from its folder (wisp.terminal's `run` kind, `PORT` set) and shows it in a
frame. v1 showed it through a small proxy so that it could be framed (many dev servers send `X-Frame-Options` or a CSP
`frame-ancestors`) and so that one script could go into its pages: Pick element, which outlines what's under the
pointer and, on a click, describes the element (tag, text, selector, trimmed HTML, key styles) into the task's reply
box. v2 had the frame but no proxy, so Pick was missing and some apps refused to be framed.

This is a new kind of listener for wisp.terminal (a plugin answering HTTP on a port of its own, not through the edge).
It isn't new for wisp: wisp.stuff serves launched apps the same way (ADR-0036).

## Decision

1. **One proxy per running Preview, in wisp.terminal**, on `127.0.0.1:42000 + hash(task id) % 900` (v1 `PROXY_BASE`;
   the app's own port is 41000 + the same hash, so never the same port). It starts with the run (`terminal.run.start`)
   and stops when the run is closed (`terminal.close` of kind `run`), and with the plugin's scope. A restart keeps it.
   Its port is in `RunInfo.proxy` / `RunStarted.proxy` (additive); none means "show the app itself, without Pick".
2. **What it forwards to:** the port the app's own output prints first (v1 `urlIn`, over the run's kept screen, ANSI
   stripped), else the `PORT` it was given.
3. **What it changes, and nothing else** (`wisp_terminal_core::pick`, pure, tested): `X-Frame-Options` dropped; CSP's
   `frame-ancestors` dropped (every other directive kept; a CSP left empty dropped); a GET's `text/html` answer of at
   most 8 MB gets `<script src="/__wisp/pick.js"></script>` right after `<head …>` (else `<html …>`, else first), once;
   `/__wisp/pick.js` is v1's script, verbatim. The app is asked without `Accept-Encoding` (plain over loopback); one that
   compresses anyway is read back (gzip, deflate, br) before the script goes in, and `Content-Encoding`,
   `Content-Length` and `ETag` go with the old body. A websocket (live reload) is piped both ways untouched.
4. **The page and wisp talk only by `postMessage` with `{ wisp: 'pick' }`:** the panel says `hello` after each load,
   the script answers `ready` (Pick turns on), `on`/`off` with the accent colour, and `picked` with the element. A pick
   counts only while the panel is picking; what the page sends is cut to one line per part, a pick well under 2,000
   characters. It goes under what's in the reply box, the caret on a line of its own; nothing sends it but you.

## Consequences

- Pick works as in v1, and apps that refuse framing show in Preview.
- The proxy is the app's own origin as far as the browser cares (another port): the app gets no reach into wisp's API or
  storage through it. The script it adds talks to the frame's parent only.
- Through a wisp Grid or another machine the proxy's `localhost` address isn't the viewer's: there the frame shows the
  app's own address as before and Pick isn't offered (v1 `far`).

## Edge cases

| Case | What happens | Test |
|---|---|---|
| A request whose `Host` isn't this computer's loopback (DNS rebinding: a site reaching the port by a name pointing here) | 403, nothing forwarded | `proxy.rs` `the_proxy_frames_the_app_adds_the_picker_and_refuses_a_foreign_host` |
| The app sends `X-Frame-Options: DENY` and `frame-ancestors 'none'` | both gone, its other CSP rules kept | same; `pick.rs` `the_preview_proxy_frames_the_app_and_adds_the_picker_as_v1` |
| A CSP that was only `frame-ancestors` | the header goes | `pick.rs` |
| A page that already has the script (a cached copy, a page that includes it) | not added twice | `pick.rs` |
| `<header>` but no `<head>` | not mistaken for the head: the tag goes first | `pick.rs` |
| A page over 8 MB, a POST, JSON, an image | through as they came, no script | `pick.rs` `takes_picker` cases |
| The app compresses despite no `Accept-Encoding` (gzip, deflate, br) | read back, the script added, the encoding headers dropped | `proxy.rs` `a_compressed_page_is_read_back_and_an_unreadable_one_goes_as_it_came` |
| An encoding it can't read (zstd), or bytes that aren't text | through as they came, without the script | same |
| The app colours its address (`http://localhost:\x1b[1m5173`), or listens on `[::1]` | the colours stripped, the bracketed host read | `pick.rs` `the_app_s_address_is_the_first_local_one_it_prints` |
| The app prints a remote address first (`Network: http://192.168…`) | only a local one counts | same |
| Nothing answers on the port yet | a "Nothing answers on port N yet" page in the frame, not an error | by inspection (`failed_page`) |
| The proxy's port is taken (another program) | the run starts anyway; `proxy` is absent; the frame shows the app itself without Pick | by inspection (`Proxies::start` → false) |
| The run is stopped | the proxy stops and its port is free again | `proxy.rs` (stop frees the port) |
| The page posts `picked` while you aren't picking | ignored | `shell-task/ui/test/pick.test.ts` |
| The page posts a malformed pick (a selector that isn't a string) | ignored | same |
| The page's text is huge | each part cut to one line, a few hundred characters | same |
| Escape in the page, or in wisp while picking | picking ends; from the page, the focus goes back to Pick | by inspection (v1's) |
