<!-- answer 0 -->
## Login now rate-limited

**✅ Done** — Added a sliding-window limiter to /login. 5 attempts per minute per IP.

**`src/auth/login.ts`** — the limiter runs first

```diff
 export function login(req) {
+  limit(req.ip);
   return check(req);
 }
```

**Tests** `npm test` — 48 passed, 1 failed, 2 skipped (4.1s)
- ❌ auth > rejects expired token: expected 401, got 500 (`test/auth.test.ts:42`)

> **⚠️ Assumption**
> Behind a proxy, so I read the IP from X-Forwarded-For.
> Check the proxy sets it.

**Actions**
- **Commit and open a PR** — _Commit this and open a PR_
- **Run tests** — `$ npm test`
- Ship it

**Next**
- Make the limit configurable
- Add the same limiter to /reset-password

<!-- answer 1 -->
## Migrated 14 files to the new API

**🟡 Partly done** — Every call site of fetchJson now goes through client.get.

**What I did**

1. ✔︎ **Found call sites** — rg fetchJson: 14 files
2. ✔︎ **Rewrote them**
3. ⏭️ **Ran e2e** — needs a browser
4. ❌ **Typecheck**

- **files changed:** 14
- **bundle:** 118 KB (-6)

- `A` `src/api/client.ts` — the new client
- `D` `src/old.ts`
- `M` `src/a.ts`
- `R` `src/b.ts` — from c.ts
- `M` `src/d.ts`

```console
$ npx tsc --noEmit
src/a.ts(3,1): error TS2304: Cannot find name 'x'.
[exit 2]
```

<!-- answer 2 -->
## Two commits on feat/limit

**✅ Done**

**Branch** `feat/limit`

- `a1b2c3d` feat(auth): add rate limiter (+120/−8)
- `f00ba12` test: limiter

**Refresh sessions in auth** #128 · open → `main` (conflict)

- `d29f50a` Add refresh tests [feat/refresh] — You, now
- ⚠️ `5be27d1` Rotate keys [main] — Lena, 6m

**Conflicts**
1. `src/auth.ts:42` — Both sides rewrote getSession()
   - ours: `refresh(token)`
   - theirs: `rotate(key)`
   - ✔︎ Rotate first, then refresh
2. `README.md`

✅ Tests 42 passed · ❌ Lint · ⏳ Build

<!-- answer 3 -->
## New limiter module

**ℹ️ Report**

**Layout**

- `src/auth/limiter.ts` (added) — sliding window
- `src/auth/index.ts`

**`src/auth/limiter.ts:10`** — the new API

````ts
export function limit(ip: string): void {
  // ```not a fence```
}
````

**Before**
- 12 req/s
- no limit

**After**
- 5 req/min per IP

**Request path**

- Request → Limiter
- Limiter → Handler

- A → B _(calls)_
- B → x

**p99**

- before: 420ms
- after: 95ms

<!-- answer 4 -->
## Released 2.4.0

**✅ Done**

**Release**

- [x] merged
- [x] version bumped
- [ ] published to npm

🖼️ `shots/desktop.png` — Settings at 1280px

🎬 `demo.mp4`

🌐 http://localhost:5173/settings (mobile) — Settings

<!-- answer 5 -->
## Three stops

**ℹ️ Report**

**📍 Coffee run** · [Route](https://www.google.com/maps/dir/?api=1&origin=66%20Mint%20St%2C%20San%20Francisco%2C%20CA%2094103&destination=37.8%2C-122.4&waypoints=1%20Ferry%20Building%2C%20San%20Francisco)
1. **Blue Bottle Coffee** — [66 Mint St, San Francisco, CA 94103](https://www.google.com/maps/search/?api=1&query=66%20Mint%20St%2C%20San%20Francisco%2C%20CA%2094103) — Opens 7am
2. [1 Ferry Building, San Francisco](https://www.google.com/maps/search/?api=1&query=1%20Ferry%20Building%2C%20San%20Francisco)
3. **Pier** — [37.8,-122.4](https://www.google.com/maps/search/?api=1&query=37.8%2C-122.4)

In this order

📄 **Plan** `docs/plan.md` — the rollout

<details><summary>Show the file</summary>

# Plan

- one
- two

</details>

🔗 **Leads list** (wisp task `8e64708d4b75`) — request 37

📦 **Something in My Stuff** (My Stuff `0bac5acb43c9`) — the logo

<!-- answer 6 -->
## Which approach?

**⛔ Blocked**

**❓ Keep the old endpoint?**
1. Keep it
2. Drop it
3. Let me pick

**🔒 Blocked by permissions**
- shell: `npm publish` — needs network access
- write

<!-- answer 7 -->
## A small tuner

**✅ Done**

**🧩 Curve** _(interactive: open it in wisp)_

**❓ Which curve?**
1. ease
2. linear

```json
{
  "type": "deploy",
  "target": "prod",
  "url": "https://x.dev"
}
```

**Done.** See `src/x.ts`.

<!-- answer 8 -->
Not yet: #728 is open.

<!-- answer 9 -->
13

<!-- answer 10 -->
## Fixed the build

**✅ Done**

**Next**
- Ship it

<!-- answer 11 -->
## Explained

**ℹ️ Report**

Run:

```sh
npm test
```

then look.

<!-- answer 12 -->
## Ran it

**✅ Done**

**Next**
- Again

> **⚠️ 1 block skipped**
> Part of the agent's answer was malformed JSON and could not be shown.

<!-- answer 13 -->
## Cut off

**🟡 Partly done**

> **⚠️ 1 block skipped**
> Part of the agent's answer was malformed JSON and could not be shown.

<!-- answer 14 -->
## Final

**✅ Done**

<!-- answer 15 -->
Here it is.

`````json
{"blocks": oops not json
`````
