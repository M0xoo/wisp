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

### GRID-04 · Account page
*Automated: qa/grid.mjs* (`grid-account-desktop.png`, `grid-account-phone.png`)
- **Expected:** *Cloud wisp* row with **Open** (`/go`) and its state (*Asleep* before first open,
  **Sleep** when running); *Add a cloud machine* (Soon); *Your computers* with the three steps;
  *Devices*; *Delete your account*; **Sign out everywhere**. Fits 390px with no sideways scroll.

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
