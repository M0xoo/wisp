# wisp Grid

wisp for many people on your own server. Each person signs in with Google, GitHub or your
company's OpenID Connect, and gets their own wisp at `<handle>.<your domain>`. It starts when they
open it, sleeps when nothing's going on, and wakes for their scheduled tasks. They reach it from any
browser, from wisp on their computer (**Settings → Cloud**, or **Machines** → *Reach this computer
from anywhere*) and from the phone app (**wisp Cloud** on its first screen). Signing in from
Machines (or `wisp computer on` in a terminal) also adds that computer to the grid: it holds a tunnel open (`tunnels.js`), and their phone
and other computers reach it at `<name>--<handle>.<domain>` with no SSH or open port. Their agents run with their
own subscriptions or keys, signed in from **Settings → Agents** (a link and a code, no terminal).

The hosted one is [grid.trywisp.dev](https://grid.trywisp.dev) (early preview). This folder is the
same code, for your own server.

It's part of wisp (MIT), with no extra dependencies: `wisp grid …`. It needs Node.js 22.13 or newer
(it uses the built-in SQLite).

## Try it on this computer

```sh
wisp grid dev --fake-agents        # from a checkout: node bin/wisp.js grid dev --fake-agents
```

Open http://wisp.localhost:8080, sign in with any email (dev sign-in), then **Open wisp**.
`--fake-agents` puts wisp's test agents on PATH, so tasks run without any account. Then sign in
from wisp on this computer: Settings → Cloud → `wisp.localhost:8080`.

The Android emulator reaches it with `adb reverse tcp:8080 tcp:8080`.

## Run it for real

**One small server is enough for a few people.** grid.trywisp.dev runs on a Hetzner CAX21 (4 Arm
vCPUs, 8 GB, about €12 a month) with Debian 13: enough for 4 people with agents running at once.
Copy the repo there and run, as root:

```sh
DOMAIN=wisp.example.com ./grid/deploy/install.sh
```

It installs Node.js 22, Docker with gVisor (`runsc`), Caddy and 4 GB of swap, builds the user image
([`deploy/image/Dockerfile`](deploy/image/Dockerfile): Node, git, `gh`, every agent wisp
runs (Claude Code, Codex, Cursor, Grok, Antigravity, opencode) and wisp), makes the `wisp` system
user, starts boxd (the root helper that runs the users' containers, see Isolation), writes the
grid's systemd unit, and sets up the firewall. Keep the repo root's (e.g. `/opt/wisp-grid`): boxd
runs its code as root. Then:

```sh
sudo -u wisp node bin/wisp.js grid init --domain wisp.example.com --data /var/lib/wisp-grid
```

`init` writes `grid.json` and a master key (`secrets/master.json`, mode 0600), then says what's
next:

1. **DNS.** Point `wisp.example.com` and `*.wisp.example.com` at the server.
2. **HTTPS.** Run [Caddy](https://caddyserver.com) with [`deploy/Caddyfile`](deploy/Caddyfile).
   It gets a certificate for each name the first time it's asked for, after checking with the grid
   that the name belongs to a user, so you don't need a DNS API.
3. **Sign-in.** Create the OAuth apps and paste their client ids into `grid.json`. Put each secret
   in its own file (`chmod 600`) and set `"enabled": true` for the providers you use.
   - **GitHub:** github.com → Settings → Developer settings → OAuth Apps. The callback URL is
     `https://wisp.example.com/auth/github/callback`.
   - **Google:** console.cloud.google.com → APIs & Services → Credentials → OAuth client ID (Web
     application). The redirect URI is `https://wisp.example.com/auth/google/callback`.
   - **Any OpenID Connect provider** (GitLab, Microsoft Entra, Keycloak, Authentik, …): add a
     provider such as `"oidc:corp": { "issuer": "https://sso.corp.com", "clientId": "…",
     "clientSecretFile": "secrets/corp", "label": "Corp SSO" }`.
4. **Check.** `wisp grid doctor --data /var/lib/wisp-grid` checks Node, the config, the key,
   providers and DNS.
5. **Isolate.** `init` already chose containers through boxd when boxd was running
   (`"hostd": { "driver": "container", "container": { "boxd": "/run/wisp-grid/box.sock" } }`). See
   Isolation below.
6. **Run.** `systemctl enable --now wisp-grid` (the unit `install.sh` made from
   [`deploy/wisp-grid.service`](deploy/wisp-grid.service)), or `wisp grid serve --data …` by hand.

### Who gets in

```json
"auth": {
  "signup": "open",
  "maxUsers": 50,
  "allow": { "emails": ["ada@corp.com"], "domains": ["corp.com"], "githubOrgs": ["corp"] },
  "admins": ["github:583231", "email:ops@corp.com"]
}
```

- **`signup`:** `closed` lets only existing users in.
- **`maxUsers`:** the first that many accounts get in, then new sign-ups are refused (existing
  users still sign in; deleting one frees a place). Leave it out for no limit. The sign-in page
  says when the grid is full (no count), and `GET /api/seats` answers `{ open, invite, max, left }`
  to any site that wants to know.
- **`maxUsers: "auto"`:** seats that grow with the host. It starts at `seats.min` and opens one
  more (at most every `seats.everyHours`, up to `seats.cap`) while every seat is taken and, over the
  last week, nothing had to wait for room and the most boxes up at once stayed under
  `seats.target` of what the host could run. It never takes seats away. Defaults:
  `"seats": { "min": 5, "cap": 20, "target": 0.7, "everyHours": 24, "holdDays": 7 }`.
- **Waitlist:** a sign-in the full grid turns away (with a verified email) and
  `POST /api/waitlist {"email"}` (trywisp.dev's form) go on it. A free seat is held for the oldest
  email on it for `seats.holdDays`, and whoever signs in with that verified email gets it.
  The grid sends no mail: `wisp grid waitlist` lists who's waiting and who has a seat held, to
  write to.
- **More machines:** each account has one cloud wisp. *Add a cloud machine* on the account page
  puts the user on a list for more machines, a bigger one or GPUs (`POST /machines/waitlist`,
  with what they'd run on it); `wisp grid waitlist` lists them too.
- **`allow`:** an account must match at least one rule. A verified email is required for email and
  domain rules. The allow list is checked again at every sign-in.
- **Linking accounts:** someone can connect both Google and GitHub to one account from their
  account page. Accounts are never joined just because the email matches: that would let anyone
  who can claim an address at some provider take over the account.

### Usage stats

Off unless `grid.json` has `"telemetry": true`. Then the grid sends wisp's PostHog project
anonymous counts: sign-ups (and refused ones: full or not invited), sign-ins, devices allowed or
revoked, accounts deleted, and boxes started (how long that took), stopped (why, and after how
long) or failed. Each user is a hash of their id: never a handle, email or address. Each user's
wisp then keeps its own usage stats on too (they can turn them off in Settings). `WISP_TELEMETRY=0`
or `DO_NOT_TRACK=1` in the grid's environment turns it all off.

On wisp's own hosted grid (`grid.trywisp.dev`) only, the sign-in page also loads PostHog like
trywisp.dev does, so the sign-up funnel reads: site → sign-in page → *Continue with GitHub*
(`grid_signin_clicked`) → off to GitHub (`grid_auth_started`) → back signed in or up
(`grid_auth_finished`, `signup: true|false`) or turned away (`grid_auth_failed`). The server's steps
use the page's anonymous PostHog id from its cookie, never the user. A self-hosted grid loads no
script, whatever `telemetry` says.

## How it fits together

```
browser / wisp desktop / phone app
      │ HTTPS (Caddy)
      ▼
wisp grid serve ── wisp.example.com           sign in, your account, approve a device, /api/device/*
               └── <handle>.wisp.example.com  the edge: checks the cookie or token, starts the
                    │                         user's wisp if it sleeps, proxies (HTTP + streams)
                    ▼
                 hostd ── one wisp per user, in trusted-proxy mode (WISP_TRUSTED_PROXY_SECRET)
                    │     with a clean environment: a process (dev), or
                    ▼
                 boxd (root) ── a gVisor container; its HOME, the only thing that persists, is
                                /var/lib/wisp-grid-boxes/<id>/home (root only, out of the grid's reach)
```

- **Sign-in.** OAuth 2 / OpenID Connect with state, PKCE (S256) and a nonce. ID tokens are checked
  against the provider's keys, issuer, audience and expiry. GitHub users are identified by their
  numeric id. Sessions and tokens are random values, and only their SHA-256 is stored.
- **Your own address.** `/go` creates a one-time ticket (60 s) that sets a cookie for your address
  only. Cookies never cover more than one subdomain, so one person's wisp page can't read or set
  another's. A POST to someone's wisp must come from their own address.
- **Devices.** wisp on a computer or a phone signs in with the device flow (RFC 8628). It shows a
  code, you allow it at `/activate`, and the device gets a `wgd_…` token. Your account page lists
  every device with a Remove button.
- **Deleting an account.** The account page has *Delete your account* (type your handle), and
  `wisp grid users --delete <handle> --yes` does the same for an admin. The account is disabled
  first (no session or device gets in), then its box stops and its files go (home, agent logins,
  the log), then its sessions, devices, sealed secrets and the account itself. The logins stay
  valid at Anthropic, OpenAI or GitHub until you revoke them there.
- **Idle.** Every few seconds hostd asks each wisp `GET /api/status`. When no turn is running, no
  page is open and nothing has happened for `hostd.idleMs`, it stops that wisp. It also notes when
  the wisp's next scheduled task is due and starts it for that. A desktop watching a cloud computer
  doesn't keep it awake: the stream it opens is marked `x-wisp-relay`.
- **Room.** A box starts while fewer than `hostd.maxRunning` are up and, with the container
  driver, the host has `admit.reserveMb + admit.boxMb` MiB available (`MemAvailable`; defaults
  1024 + 1024; `"admit": false` counts boxes only). When it doesn't, hostd stops the box that has
  been quiet longest the way idle does (nothing running, no page or terminal open, for
  `hostd.evictAfterMs`, 2 min; never one whose schedule is due within 5 min), so its home and tasks
  are kept. With nothing to stop, the start waits in line (*Waiting for room*) for
  `hostd.queueMs` (2 min), then says the grid is full. Scheduled wakes wait behind people, for up to
  30 min, and never stop anyone's box.

## Secrets

| What | Where |
|---|---|
| Master key | `secrets/master.json` (0600), or `GRID_MASTER_KEY` / `GRID_MASTER_KEY_FILE` |
| OAuth client secrets | files referenced by `clientSecretFile`, or `GRID_GITHUB_CLIENT_SECRET(_FILE)` / `GRID_GOOGLE_CLIENT_SECRET(_FILE)` |
| Per-user secrets the grid keeps (each wisp's proxy secret, …) | sealed in the database with AES-256-GCM, using a data key per user that is wrapped by the master key |
| A box's proxy secret on its way in | a 0600 env file for `docker run --env-file` (boxd's folder, or the user's), never the command line |
| Agent logins (Claude, Codex, …) | files in the box's `HOME`, the way each CLI keeps them (`~/.claude`, `~/.codex`, `~/.config/gh`, …), not encrypted. With boxd that home is in `/var/lib/wisp-grid-boxes/<id>` (root only), out of the grid user's reach. They never pass through the grid, and are deleted with the account |
| A device's token on a desktop | `~/.wisp/secrets.json` (0600), never `config.json` |

- **`wisp grid rotate-key`** makes a new master key, re-wraps every user's data key and retires the
  old master key.
- **Deleting a user** deletes their box and files, and their data key, so nothing sealed with it can
  be read again.
- **`wisp grid backup`** makes a consistent copy of the database. Keep it together with the master
  key.

Whoever runs the grid can read what it stores, the boxes' homes included; that is true of any
hosted service. Running your own grid is the answer for that. Someone who took over the grid
process itself couldn't read the homes from disk or become root (it has no Docker), but it holds
every box's proxy secret, so it could still drive a user's wisp.

## Isolation: read this before you invite people

Agents run with real permissions, so every user's wisp needs a wall around it.

- **`container` (use this):** one Docker container per user with gVisor's `runsc` runtime, a
  user-space kernel between the agents and the host's. Each gets only its own home folder, runs
  as uid 1000 with no capabilities and `no-new-privileges`, with limits on memory (1.5 GB + swap),
  CPU and processes, and is published on the host's loopback only.
- **boxd** ([`boxd.js`](boxd.js), [`deploy/wisp-grid-boxd.service`](deploy/wisp-grid-boxd.service)):
  whoever can run `docker` is root, so the grid doesn't. boxd, a small root service with no
  dependencies, runs, stops and deletes the containers for it over `/run/wisp-grid/box.sock`
  (0660, group `wisp`). It builds `docker run` from its own settings (image, runtime, network,
  mounts, uid; `--image`, `--runtime`, … on its command line), and only takes a user id, a port,
  limits and the box's environment from the grid. The boxes' homes live in its folder,
  `/var/lib/wisp-grid-boxes` (root, 0700). Without `hostd.container.boxd`, hostd runs `docker`
  itself, the homes stay in `data/users/<id>/home`, and the grid's user needs the `docker` group:
  `wisp grid doctor` says so.
  [`deploy/firewall.sh`](deploy/firewall.sh) puts the containers on their own bridge, with no
  traffic between them and none to the host, to the cloud metadata service, or to mail servers.
  Each gets its own resolv.conf, because Docker's built-in DNS can't be reached from gVisor.
- **`process` (dev only):** every user's wisp runs as the same OS user. Fine for `wisp grid dev`
  and for yourself; it doesn't keep users apart.
- **`firecracker` (next):** a microVM per user, for hosts with KVM (bare metal). It plugs into the
  same hostd interface (`grid/hostd.js`).

### Moving an existing grid to boxd

Grids set up before boxd run `docker` as the `wisp` user and keep homes in `data/users/<id>/home`.
As root, from a root-owned checkout at `/opt/wisp-grid`:

```sh
cp grid/deploy/wisp-grid-boxd.service /etc/systemd/system/
mkdir -p /etc/systemd/system/wisp-grid.service.d     # the grid starts after boxd
printf '[Unit]\nAfter=wisp-grid-boxd.service\nWants=wisp-grid-boxd.service\n' > /etc/systemd/system/wisp-grid.service.d/boxd.conf
systemctl daemon-reload && systemctl enable --now wisp-grid-boxd
systemctl stop wisp-grid                        # stops every box
node /opt/wisp-grid/grid/boxd.js migrate        # data/users/<id>/home → /var/lib/wisp-grid-boxes/<id>/home
# grid.json: "hostd": { "driver": "container", "container": { "boxd": "/run/wisp-grid/box.sock" }, … }
gpasswd -d wisp docker
systemctl start wisp-grid
sudo -u wisp node /opt/wisp-grid/bin/wisp.js grid doctor --data /var/lib/wisp-grid
```

A box whose home is still at the old place won't start through boxd (it says to run `migrate`), so
nobody gets an empty home by mistake.

## Commands

```
wisp grid dev [--port 8080] [--fake-agents] [--idle 120] [--data DIR]
wisp grid init --domain D [--data DIR] [--force]
wisp grid serve [--data DIR]
wisp grid doctor [--data DIR]
wisp grid rotate-key | backup [file] | users [--data DIR]
wisp grid users --delete HANDLE --yes [--data DIR]
node grid/boxd.js serve | migrate [--data DIR] [--boxes DIR]   (as root)
```

The data folder is `--data DIR`, or `GRID_DATA`, or `~/.wisp-grid` (`~/.wisp-grid-dev` for `dev`).
