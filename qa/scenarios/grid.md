# wisp Grid scenarios

What to check before shipping a change that touches `grid/`, trusted-proxy mode
(`server/http/trust.js`), `GET /api/status`, cloud computers (`server/machines.js`,
`server/services/cloud.js`) or the page as it runs inside a cloud box.

Run the automated ones with `node qa/grid.mjs` (Node 22.13+, playwright-core in `/tmp/wisp-qa-pw`,
see `qa/lib.mjs`). It starts `wisp grid dev --fake-agents --port 8090 --idle 6` on a temp `--data`
dir (deleted afterwards; `QA_KEEP=1` keeps it), drives headless Chrome, and writes
`qa/out/grid.json` and `qa/out/grid-*.png`. `QA_GRID_PORT` picks another port.

Users are `ada@example.com` (handle `ada`) and `bob@example.com` (handle `bob`), via dev sign-in.

---

### GRID-01 · `grid dev --fake-agents` boots
*Automated: qa/grid.mjs*
- **Preconditions:** a checkout (the fake agents come from `test/fixtures`), an empty data dir.
- **Steps:** `node bin/wisp.js grid dev --fake-agents --port 8090 --data <tmp> --idle 6`.
- **Expected:** prints `◌ wisp Grid (dev) at http://wisp.localhost:8090`; `GET /healthz` → `{ ok: true }`;
  `<data>/fake-bin/claude` exists; `<data>/grid.json` and `secrets/master.json` are written.

### GRID-02 · Sign-in page, desktop and phone
*Automated: qa/grid.mjs* (screenshots `grid-signin-desktop.png`, `grid-signin-phone.png`)
- **Steps:** open `http://wisp.localhost:8090/` at 1440×900, then 390×844.
- **Expected:** 200, the landing page with **Continue with Dev sign-in (any email)**; no sideways
  scroll on the phone; no console errors.

### GRID-03 · Dev sign-in
*Automated: qa/grid.mjs*
- **Steps:** **Continue with Dev sign-in** → Email `ada@example.com`, Name `Ada` → **Sign in**.
- **Expected:** lands on the account page (*Hi Ada*); the top right shows the handle `ada`.

### GRID-04 · Home and Account
*Automated: qa/grid.mjs* (`grid-home-desktop.png`, `grid-home-phone.png`, `grid-account-desktop.png`, `grid-account-phone.png`)
- **Expected:** `/` is **Home**: the cloud wisp with a picture of the app, its state (*Asleep* before
  first open, **Sleep** when running, nothing moves between them), **Open** (`/go`), its address and
  machine; *Add a cloud machine* (Soon); on a new account the three first steps; *Your computers* as
  cards, with *Add a computer* always the last card (the whole row with no computers), which opens
  full width under them, moving no card: **In a terminal** (`npx wisp-agents computer on --grid wisp.localhost:8090`,
  copyable) and **With the app** (the three Machines steps), switching without a reload; *Published
  apps* when there are any; *What your grid can do*, whose tiles say what's already true (*4 published*,
  *Phone connected*). `/account` is **Account**, a tab in the header (the avatar goes there too):
  *Signed-in devices*, *How you sign in*, **Sign out**, **Sign out everywhere**, *Delete your account*.
  A live change (a computer comes online, the wisp wakes) keeps an open *Add a computer* and a
  half-typed confirm as they are. Both fit 390px with no sideways scroll.

### GRID-05 · Open → your own wisp
*Automated: qa/grid.mjs* (`grid-cloud-wisp-desktop.png`)
- **Steps:** click **Open**.
- **Expected:** `/go` → `ada.wisp.localhost:8090/_grid/auth?t=…` → wisp's page (the waking page
  first if the start is slow, which reloads itself). The launcher says *Cloud computer*; the
  sidebar says **Connect** (not Machines) under *New task*, and its foot shows you (your initial,
  name, handle and the grid) with the avatar's ring lit. No console errors.

### GRID-06 · A task in the cloud wisp
*Automated: qa/grid.mjs* (`grid-cloud-wisp-task.png`, `grid-cloud-wisp-phone.png`)
- **Steps:** type a prompt in the launcher (No folder), Enter.
- **Expected:** a card appears, runs on a fake agent, and ends in *Needs you* with a presentation
  (*Finished*) and a "… is ready" toast. Same at 390px.

### GRID-07 · One user can't reach another's wisp
*Automated: qa/grid.mjs*
- **Steps:** sign in `bob` in a second browser. In Ada's browser open `bob.wisp.localhost:8090`.
  Send Ada's `wisp_grid` cookie to Bob's `/api/sessions`. POST to Ada's own `/api/sessions` with
  her cookie and `Origin: http://evil.example`.
- **Expected:** Ada's browser ends at her own wisp, never Bob's; Ada's wisp cookie is host-only
  (`ada.wisp.localhost`); Bob's API → 401; the cross-origin POST → 403.

### GRID-08 · Public seats, box status
*Automated: qa/grid.mjs*
- **Expected:** `GET /api/seats` → 200 `{ open, invite, max, left }` with
  `access-control-allow-origin: *`; inside the box `GET /api/status` →
  `{ live, sides, clients, lastActivityAt, nextWakeAt, version }`.

### GRID-09 · Device sign-in (RFC 8628)
*Automated: qa/grid.mjs* (`grid-activate.png`)
- **Steps:** `POST /api/device/code {name:"QA phone"}`; poll `POST /api/device/token` (→ 400 while
  pending); open `verification_uri_complete` signed in as Ada → **Allow**; poll again.
- **Expected:** *Device connected*; the token (`wgd_…`) works for `GET /api/me`, Ada's edge
  (`Authorization: Bearer`) and `POST /api/device/link` (a `/_grid/auth?t=` URL); on Bob's edge → 401.

### GRID-10 · Idle stop and wake
*Automated: qa/grid.mjs*
- **Steps:** close every page of Ada's wisp; wait `--idle` (6s) + a hostd check (5s).
- **Expected:** `/_grid/state` → `stopped`. The next request wakes it (`running`) and the task from
  GRID-06 is still there (home persists across sleep).

### GRID-11 · Remove a device
*Automated: qa/grid.mjs*
- **Steps:** account page → *Devices* → **Remove** on *QA phone*.
- **Expected:** *Device removed.*; the token now gets 401 on `/api/me` and on the edge.

### GRID-12 · Admin CLI on the data dir
*Automated: qa/grid.mjs*
- **Steps:** `wisp grid doctor|users|backup <file> --data <tmp>` while the grid runs.
- **Expected:** doctor: ✓ Node, ✓ config, ✓ master key 0600, ✓ `*.wisp.localhost → loopback`. Its
  one ✗ on a dev data dir is *no provider enabled* (dev sign-in is a `grid dev` flag, not in
  grid.json), so doctor exits 1 there. `users` lists `ada` and `bob`; `backup` writes a non-empty db.

### GRID-13 · Delete your account
*Automated: qa/grid.mjs* (`grid-deleted.png`)
- **Steps:** as Bob (box started once), type `bob` in *Delete your account* → **Delete**.
- **Expected:** *Account deleted*; `grid users` no longer lists bob; `bob.wisp.localhost` → 404
  *No such wisp*; Bob's folder under `<data>/users` is gone.

### GRID-14 · No console errors
*Automated: qa/grid.mjs* — no page error or console error on any grid or cloud-wisp page above.

---

## Manual

### GRID-20 · Desktop wisp signs in to a grid
*Manual*
- **Steps:** with GRID-01 running, wisp on this computer (`npm run dev:web`) → Settings → Cloud →
  `wisp.localhost:8090` → Sign in → Allow in the browser. Then Machines → *Reach this computer from
  anywhere*.
- **Expected:** the cloud computer shows under Machines (`kind: 'grid'`) and opens; this computer
  is listed on the account page under *Your computers* as online, and **Open** reaches it at
  `<name>--ada.wisp.localhost:8090` through the tunnel. **Remove** takes it off.

### GRID-21 · Phone app signs in to a grid
*Manual* (see `qa/scenarios/mobile.md`)
- **Steps:** emulator, `adb reverse tcp:8090 tcp:8090`; first screen → wisp Cloud → address
  `wisp.localhost:8090` → Sign in → Allow (`/activate?app=android`).
- **Expected:** *Back to the wisp app*; the cloud computer is listed and opens wisp.

### GRID-22 · Real OAuth providers
*Manual* (on a staging grid with HTTPS)
- **Expected:** **Continue with GitHub** / **Google** / OIDC round-trip; a second provider can be
  connected from the account page and **Disconnect**ed; `signup: closed`, `allow` rules and
  `maxUsers` (full → waitlist message, no count) behave as in `grid/README.md`.

### GRID-23 · Containers through boxd (gVisor)
*Manual* (Linux host with Docker + runsc)
- **Expected:** `wisp grid doctor` shows `✓ boxd at /run/wisp-grid/box.sock … runtime runsc`; a
  user's box is a `runsc` container on loopback; its home lives in `/var/lib/wisp-grid-boxes/<id>`;
  deleting the account removes it; `node grid/boxd.js migrate` moves old homes.

### GRID-27 · A preview of a page in the box
- **Preconditions:** `wisp grid dev` (previews on), signed in as `ada`, her wisp open.
- **Steps:** start a task that runs a dev server in the box (`npx vite --port 5173`) and ends with
  a `preview` block for `http://localhost:5173`; open the task.
- **Expected:** the frame shows the box's page (not your own `localhost:5173`), loaded from
  `p5173--ada.<domain>`; the address bar says `localhost:5173`, with no *points at the agent's
  computer* note; editing a file there reloads the frame (websocket). Signed out, or as `bob`,
  `p5173--ada.<domain>` asks you to sign in or refuses. With the box asleep, it says so.

### GRID-28 · A preview of a page on a computer added to the grid
- **Preconditions:** `wisp grid dev`; a desktop wisp signed in as `ada` with *Add to grid* on.
- **Steps:** Settings → Machines: under *This computer*, **Show local pages in previews** is off;
  run `npx vite --port 5173` on the desktop and a task there ending with a `preview` of
  `http://localhost:5173`; open that task from another browser through `<name>--ada.<domain>`.
- **Expected:** off: the frame says the computer doesn't show its local pages, naming the switch.
  Switch it on (instant, rolled back with a toast if refused): the frame loads the desktop's page
  from `p5173--<name>--ada.<domain>`, live reload works; on the desktop itself it still loads
  `localhost:5173`. Off again: refused at once. The row fits 390px, light and dark.

### GRID-29 · /sandbox: a task in a box of its own
- **Preconditions:** a grid with containers and gVisor (a scratch grid beside production works: its
  own boxd socket, image tag and port, reached over `ssh -L`); a desktop wisp signed in to it; a git
  project with an uncommitted change and a `.wisp/sandbox.sh`.
- **Steps:** Settings → Cloud → **Sandboxes**: *Sign in with Claude*, open the link, paste the code;
  add an env var. In New task type `/sandbox install cowsay with apt and open example.com` and send
  it. Open the task's side panel → **Browser**. Delete the task.
- **Expected:** before signing in, the launch is refused with a toast whose **Sign in** opens the card
  with the sign-in started. The placeholder card goes *Making a sandbox* → *Starting the sandbox* →
  *Copying your project* → *Starting the agent*, with a **Sandbox** pill. In the box: the project
  with its uncommitted change, `setup.log` from the script, the env var, `sudo apt-get` works.
  The Browser tab shows Chromium live, and you can click in it. Stop the box (`docker stop`) and wake
  it: cowsay is back and the browser starts again. Deleting the task removes the box and its home.
  The card and the tab fit 390px, light and dark. A delegate placed on **Sandbox** and a crew member
  on **A sandbox of their own** each get one; deleting the lead or the member removes it.

### GRID-30 · API keys: scripting a cloud wisp
*Automated in `test/grid.test.js`; the card by hand*
- **Preconditions:** a grid; a user signed in to their cloud wisp, and a desktop wisp signed in to
  the same grid.
- **Steps:** in the cloud wisp, Settings → Connect → **API keys** (the browser asks the grid at
  `/_grid/keys`; the box isn't involved): name one and **Create key**; **Copy**, **Done**.
  `curl -H "Authorization: Bearer wgk_…" https://<handle>.<domain>/api/sessions`. Open Settings →
  Cloud → **API keys** on the desktop (it asks through `/api/cloud/keys` with its device sign-in).
  Try the key on `<computer>.<domain>`, `sb-<id>--<handle>.<domain>`, the grid's `/api/me`, and on
  its own wisp's `/api/cloud/keys` and `/_grid/keys`. **Revoke** it and run the first `curl` again.
- **Expected:** the box empties at once and the row shows before the key arrives; the key shows once,
  and is gone after Done, after leaving the pane or closing Settings, and on reload. The `curl`
  answers and *Last used* moves; the desktop lists the same key. The computer, the sandbox and
  `/api/me` answer 401, `/api/cloud/keys` 403 (*An API key can’t manage API keys.*), `/_grid/keys`
  403 (*API keys are made from Settings, in a browser.*). After Revoke, which asks first, the `curl`
  is 401. From a shell on the box, the Box secret on the grid's `/api/keys` is 401 and
  `localhost:<port>/api/cloud/keys` makes nothing (`grid: null`, 409 on POST), and a preview link's
  `/_grid/auth?t=…` opens only its preview address, never `<handle>.<domain>`. A desktop signed in to
  no grid, a sandbox's page and an older grid show no card, and the phone app never does. The card
  fits 390px, light and dark. A preview link's ticket and cookie open only that box's or computer's
  preview addresses, and an uploaded page doesn't run (`/api/uploads/<id>`: `content-security-policy:
  sandbox`) while images, text and PDFs still show.
- **Risk:** a key is everything you can do in your wisp, running tasks included. Revoking stops the
  key, not what it started: if a leaked key was used, treat the box as compromised. A page the box
  serves to a signed-in person can reach `/_grid/keys`.

### GRID-31 · A Telegram message reaches a sleeping box
*`qa/grid.mjs`* (fake Telegram, `channels` in the dev grid's `grid.json`); `test/channel-inbound.test.js`
for the rest
- **Steps:** turn Telegram on in a cloud wisp; let the box sleep; call the webhook URL it set with the
  `secret_token` it set, sending the link code.
- **Expected:** `setWebhook` to `<handle>.<domain>/_in/<token>`, no `getUpdates`; the 200 comes back
  before the box is up; it wakes, links, and answers once; it sleeps again by itself. A wrong token
  at that address is a 404. Without `channels` in `grid.json`, `/_in/` is a 404 and the box polls. A
  stranger's message is refused by the box with a 403 and no answer; three wakes like that and the next
  is low priority, one per 10 minutes. `POST /api/channels/rotate` moves the webhook to a new URL with
  the same secret, and the old URL is a 404.
- **Against production:** only when the owner deploys: a throwaway account, one real Telegram bot.

### GRID-32 · A Slack message reaches a sleeping box
*`qa/grid.mjs`* (fake Slack, `channels` in the dev grid's `grid.json`); `test/channel-inbound.test.js`
for the rest
- **Steps:** on a cloud wisp, copy the Slack manifest; turn Slack on with a signing secret and a bot
  token (no app token); send Slack's `url_verification` to the manifest's `request_url`; let the box
  sleep; send it again; then call that URL with a signed DM holding the link code.
- **Expected:** the manifest has `request_url` at `<handle>.<domain>/_in/<token>` and
  `socket_mode_enabled: false`; the URL check gets its challenge back with the box up and a 503 with it
  asleep, and that doesn't wake it. A signed DM gets its 200 before the box is up; it wakes, links, and
  answers once; a retry signed anew changes nothing; it sleeps again by itself. A bad signature, or a
  timestamp over 5 minutes older than the grid's own arrival time, is refused by the box with a 403 and
  no answer, and so is a stranger; a message held longer than that for a wake still runs. An edit or a
  bot's message isn't held: no row, no wake, no strike. Without
  `channels` in `grid.json` the manifest route is a 409 and Slack says it can't reach the computer.
- **Against production:** only when the owner deploys: a throwaway account and a real Slack app. This
  is the only way to see Slack's own URL check and retries.

### GRID-24 · Caddy on-demand TLS and DNS
*Manual*
- **Expected:** a new handle gets a certificate on first visit; an unknown name is refused (Caddy's
  `ask` → the grid); `__Host-` cookies are used over HTTPS.

### GRID-25 · Room, eviction and waitlist
*Manual* (or `test/grid-hostd.test.js` for the logic)
- **Expected:** with `maxRunning` reached, the quietest box is stopped (not one with a schedule due
  within 5 min); with nothing to stop, *Waiting for room*, then "grid is full" after `queueMs`.
  `POST /api/waitlist {email}` and `wisp grid waitlist` list who waits.

### GRID-26 · Deploy to grid.trywisp.dev
*Manual* — the `deploy-wisp-grid` skill (`--no-image` for code-only changes); then
`journalctl -u wisp-grid`, `/healthz`, and the version a user's box reports in `/api/status`.
