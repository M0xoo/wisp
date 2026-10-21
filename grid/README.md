# wisp Grid

wisp for many people on your own server. Each person signs in with Google, GitHub or your
company's OpenID Connect, and gets their own wisp at `<handle>.<your domain>`. It starts when they
open it, sleeps when nothing's going on, and wakes for their scheduled tasks. They reach it from any
browser, from wisp on their computer (**Settings → Cloud**) and from the phone app (**Sign in to
wisp Cloud**). Their agents run with their own subscriptions or keys.

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

```sh
wisp grid init --domain wisp.example.com --data /var/lib/wisp-grid
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
5. **Run.** `wisp grid serve --data /var/lib/wisp-grid`, or as a service with
   [`deploy/wisp-grid.service`](deploy/wisp-grid.service).

### Who gets in

```json
"auth": {
  "signup": "open",
  "allow": { "emails": ["ada@corp.com"], "domains": ["corp.com"], "githubOrgs": ["corp"] },
  "admins": ["github:583231", "email:ops@corp.com"]
}
```

- **`signup`:** `closed` lets only existing users in.
- **`allow`:** an account must match at least one rule. A verified email is required for email and
  domain rules. The allow list is checked again at every sign-in.
- **Linking accounts:** someone can connect both Google and GitHub to one account from their
  account page. Accounts are never joined just because the email matches: that would let anyone
  who can claim an address at some provider take over the account.

## How it fits together

```
browser / wisp desktop / phone app
      │ HTTPS (Caddy)
      ▼
wisp grid serve ── wisp.example.com           sign in, your account, approve a device, /api/device/*
               └── <handle>.wisp.example.com  the edge: checks the cookie or token, starts the
                    │                         user's wisp if it sleeps, proxies (HTTP + streams)
                    ▼
                 hostd ── one wisp per user (process driver), WISP_HOME and HOME in data/users/<id>/
                          trusted-proxy mode (WISP_TRUSTED_PROXY_SECRET), a clean environment
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
- **Idle.** Every few seconds hostd asks each wisp `GET /api/status`. When no turn is running, no
  page is open and nothing has happened for `hostd.idleMs`, it stops that wisp. It also notes when
  the wisp's next scheduled task is due and starts it for that. A desktop watching a cloud computer
  doesn't keep it awake: the stream it opens is marked `x-wisp-relay`.

## Secrets

| What | Where |
|---|---|
| Master key | `secrets/master.json` (0600), or `GRID_MASTER_KEY` / `GRID_MASTER_KEY_FILE` |
| OAuth client secrets | files referenced by `clientSecretFile`, or `GRID_GITHUB_CLIENT_SECRET(_FILE)` / `GRID_GOOGLE_CLIENT_SECRET(_FILE)` |
| Per-user secrets the grid keeps (each wisp's proxy secret, …) | sealed in the database with AES-256-GCM, using a data key per user that is wrapped by the master key |
| Agent logins (Claude, Codex, …) | the user's own folder: their wisp's `HOME`. They never pass through the grid |
| A device's token on a desktop | `~/.wisp/secrets.json` (0600), never `config.json` |

- **`wisp grid rotate-key`** makes a new master key, re-wraps every user's data key and retires the
  old master key.
- **Deleting a user** deletes their data key, so nothing sealed with it can be read again.
- **`wisp grid backup`** makes a consistent copy of the database. Keep it together with the master
  key.

Whoever runs the grid can read what it stores; that is true of any hosted service. Running your
own grid is the answer for that.

## Isolation: read this before you invite people

hostd's `process` driver runs every user's wisp as the same OS user, on the same machine. It gives
each one its own folder and environment, but agents can run any command. So it's for you and people
you trust: a household, a small team. It doesn't keep users apart.

The `container` driver (gVisor or nspawn on a ZFS dataset per user) and the `firecracker` driver
(a microVM per user) are next. They plug into the same hostd interface (`grid/hostd.js`).

## Commands

```
wisp grid dev [--port 8080] [--fake-agents] [--idle 120] [--data DIR]
wisp grid init --domain D [--data DIR] [--force]
wisp grid serve [--data DIR]
wisp grid doctor [--data DIR]
wisp grid rotate-key | backup [file] | users [--data DIR]
```

The data folder is `--data DIR`, or `GRID_DATA`, or `~/.wisp-grid` (`~/.wisp-grid-dev` for `dev`).
