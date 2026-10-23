# wisp for Android (prototype)

wisp on your phone, for your own computers. Sign in to wisp Cloud once and every computer you
added to it (from Machines on that computer) is listed; or add one over SSH (its address and your
password). Tap it and you're in that computer's wisp: start tasks, answer your agents, read the reports. The
agents keep running there when the phone sleeps. **Computers** in wisp's top bar brings you back
to the list, to switch to another one or add one.

*Computers* is the app's word for what it connects to; *Machines* stays the desktop feature that
reaches other computers over SSH (it isn't shown in the app).

It reuses wisp's code instead of copying it:

- **The page is wisp's own.** The phone forwards `127.0.0.1:<port>` over SSH to wisp on the
  machine, and the WebView loads `http://127.0.0.1:<port>/` from there. Every feature, spell and
  fix in `web/` shows up on the phone, matched to the wisp version running on that machine.
- **wisp starts with the desktop's own script.** `server/machines/bootstrap.js` is the script
  that desktop *Machines* sends over `ssh … sh -s`. It finds Node 20+ (or
  installs it into `~/.wisp/node`), starts `npx -y wisp-agents` (or reuses a running wisp) and reports each `STEPS` entry back as an
  `@@wisp …` line. `npm run shared` copies it into `www/shared/`.
- **`web/` knows when it runs in the app.** The WebView adds `wispMobile` to its user agent.
  `MOBILE` in `web/js/core/state.js` then hides what a phone can't do (Take over in a terminal,
  opening an editor, keyboard hints, Machines), turns the Machines button into **Computers**
  (back to the app's list) and calls the computer by its name instead of *This computer*
  (`COMPUTER`, passed by the app as `?m=`).

```
www/                 the computers screen (vanilla JS, no build), mock.js for the browser preview
scripts/shared.mjs   copies server/shq.js, server/machines/bootstrap.js, web/css/tokens.css
android/app/src/main/java/dev/trywisp/mobile/
  Tunnel.java        SSH (sshj), runs the script, forwards the port, reconnects (plain Java)
  Keys.java          the phone's keys: Ed25519 made here, or imported OpenSSH/PEM/PuTTY
  WispSshPlugin.java the Capacitor plugin the page calls
  TunnelService.java keeps the app running while connected (foreground service)
  MainActivity.java  window.wispAndroid: notifications for wisp's page; Alerts.java posts them
```

## wisp Cloud

No computer to keep on? The first screen starts with **wisp Cloud**: the address
(`grid.trywisp.dev`, or your own grid's) is filled in, **Sign in** shows a code, you allow it in
the browser (signed in with GitHub or Google), and your cloud computer joins the list. Tap it and
you're in its wisp: no SSH, no tunnel.

Your own computers come along: each one you added to the grid (wisp on it: Machines → *Reach this
computer from anywhere*) is listed under the cloud one, marked *Your computer · via grid*, with
**Open** while it's online. The list comes from `GET /api/computers` with the device token (the
last one is kept, so the screen paints at once), and Open asks for a one-time link to that
computer (`/api/device/link` with `computer`). It holds a tunnel open to the grid, so this
reaches it from anywhere with no SSH. Over SSH (below) is folded under *Connect over SSH instead*. The app keeps a device token for it and asks the grid for a
one-time link each time it opens; `Grid.java` lets the grid's pages load in the app, and the page's
service worker leaves the grid's own `/_grid/…` links alone. Sign in to Claude Code, Codex or
GitHub there in Settings → Agents. See [grid/README.md](../grid/README.md).

## Use it over SSH

1. **Get a computer ready.** Turn on SSH there: on a Mac, System Settings → General → Sharing →
   *Remote Login*; on Linux, `openssh-server`. That's all it needs.
2. **Add it in the app:** its address (`you@its-name`, or `you@its-name:2222`) and your password
   on it. The password is used once: the app signs in with it, adds the phone's own key there
   (`@@wisp keyed`) and forgets it. Prefer a key? *Use a key instead* shows the
   `authorized_keys` command, or import one under *Keys on this phone*. With Tailscale SSH on a
   Linux computer (`sudo tailscale set --ssh`) nothing is needed: the app tries that first.
3. **Connect.** The card shows the steps (SSH, Node.js, wisp, tunnel); a computer without Node.js
   gets it in `~/.wisp/node`, and wisp comes from `npx`. Then wisp opens. Pick a coding agent there
   (Settings → Agents: opencode installs in one click).
4. **Switch:** **Computers** in wisp's top bar (or Settings → Computers) goes back to the list.
   The app opens the last computer used each time it starts.

Away from home, put the
computers and the phone on [Tailscale](https://tailscale.com) and use the names it gives. Step by
step: https://trywisp.dev/guides/connect-machines-with-tailscale.html

**When wisp stops there.** SSH can stay up after wisp itself stopped on the computer (quit,
crashed). While connected, `Tunnel` asks wisp's `/api/health` every 15s. After two misses, if sshd
also refuses a channel to wisp's port, it runs the bootstrap script again, which starts wisp. A
page that still fails to load sends the WebView back to the list (`MainActivity`, `?reopen`),
which reopens wisp once the tunnel says `open`, so Chrome's error page never shows.

**Notifications.** When a task finishes, asks or needs approval while the app is off screen,
you get an Android notification; tapping it opens that task. The WebView has no Notification
API, so `MainActivity` gives wisp's page a `wispAndroid` bridge (`web/js/features/notify.js`
uses it). While a machine is connected, `TunnelService` (a foreground service with a quiet
*Connected to …* notification) keeps the app, the tunnel and the page running in the background.

## Build

Needs Node 20+, a JDK 21 (Android Studio's bundled one works) and the Android SDK (platform 36).

```sh
cd mobile
npm install
npm run build        # shared files → cap sync → ./gradlew assembleDebug
# → android/app/build/outputs/apk/debug/app-debug.apk
npm run open         # or open it in Android Studio
npm run preview      # the machines screen in a desktop browser, with a fake plugin
```

Without `JAVA_HOME` set: `export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`.

## Google Play

The launcher icon is wisp's logo (`docs/assets/icon.svg`) as an adaptive icon: vector layers in
`res/drawable/ic_launcher_{background,foreground,monochrome}.xml` (the last one is Android 13's
themed icon). The store art is in `store/`: `icon.png` (512×512) and `feature-graphic.png`
(1024×500), drawn from the `.svg` next to each. `node scripts/logo.mjs` writes all of these vectors.

1. **Make an upload key**, once, and keep it out of git (backed up: losing it means asking Google
   to reset it):
   ```sh
   keytool -genkeypair -keystore ~/wisp-upload.jks -alias upload -keyalg RSA -keysize 2048 -validity 10000
   ```
   and write `android/keystore.properties` (gitignored):
   ```
   storeFile=/Users/you/wisp-upload.jks
   storePassword=…
   keyAlias=upload
   keyPassword=…
   ```
2. **Bump** `versionCode` (every upload needs a higher one) and `versionName` in
   `android/app/build.gradle`.
3. **Build the bundle:** `npm run sync && cd android && ./gradlew bundleRelease`
   → `android/app/build/outputs/bundle/release/app-release.aab`.
4. **In the Play Console** (a developer account is a one-time $25): *Create app*, name `wisp`,
   app, free. Then *Release → Testing → Internal testing → Create release*, opt in to Play App
   Signing and upload the `.aab`. Fill the store listing with `store/icon.png`,
   `store/feature-graphic.png` and 2+ phone screenshots.
5. **App content** asks for:
   - *Privacy policy:* https://trywisp.dev/privacy.html (`docs/privacy.md`).
   - *Data safety:* the app's own code collects nothing. The wisp page it shows sends
     anonymous usage stats (app info and performance, crash logs; optional, Settings → Privacy)
     and, when you send it, feedback. wisp Cloud sign-in collects email, name and user IDs for
     account management. Everything is encrypted in transit.
   - *Account deletion:* https://trywisp.dev/privacy.html#delete-your-wisp-cloud-account.
   - *Foreground service:* `specialUse` keeps the user's SSH tunnel open. Play wants a short
     video of the *Connected to …* notification.
   - *Target audience:* not for children. *App access:* reviewers need a way in, such as a wisp
     Cloud test account.
6. **Go public:** a new personal developer account has to run a closed test with 12+ testers for
   14 days before *Production* unlocks; organisation accounts can promote straight from internal
   testing.

## Test

```sh
cd mobile/android && ./gradlew testDebugUnitTest
```

`KeysTest` always runs: it makes, lists, deletes and imports keys, and checks fingerprints
against `ssh-keygen -lf`. `TunnelTest` needs a real sshd and wisp, so it runs only when asked:

```sh
# a throwaway sshd on 127.0.0.1:2299 that accepts /tmp/wsshd/client, and wisp on 4733
node -e "import('../../server/machines/bootstrap.js').then(m => process.stdout.write(m.bootstrapScript({ port: 4733, command: 'false', apiVersion: 'any' })))" > /tmp/wsshd/script.sh
WISP_SSH_TEST=$USER@127.0.0.1:2299 WISP_SSH_KEY=/tmp/wsshd/client \
WISP_SSH_SCRIPT=/tmp/wsshd/script.sh WISP_SSH_PORT=4733 ./gradlew testDebugUnitTest
```

That test connects, runs the script, opens the tunnel and loads wisp's page through it. It also
drops the connection and checks that it comes back, and checks that an unknown key and a
changed host key both fail with a clear message.

## Not yet

- **Closed app, deep sleep.** Notifications come from wisp's page, so they stop when the app is
  swiped away (that also disconnects) or Android kills it, and deep Doze can delay them. Use
  wisp's Phone settings (ntfy / Telegram) for alerts that don't depend on the app.
- **Key storage.** Keys are files in the app's private storage with backups off. They are not
  in the Android Keystore yet.
- **Host keys** are trusted on first use, per `host:port`. A changed key is refused until you
  tap *Forget saved key*.
- **One machine at a time.** The phone's `127.0.0.1:<port>` leads to one wisp. To see every
  machine at once, connect to one that has the others under its own Machines.
- **iOS**: the same `www/` and plugin API, with an SSH library (Citadel) behind it.
