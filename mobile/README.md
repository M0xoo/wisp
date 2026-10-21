# wisp for Android (prototype)

wisp on your phone, for machines you reach over SSH. Save your computers and servers, pick one,
and use the same wisp page you use on the desktop. The agents keep running there when the phone
sleeps.

It reuses wisp's code instead of copying it:

- **The page is wisp's own.** The phone forwards `127.0.0.1:<port>` over SSH to wisp on the
  machine, and the WebView loads `http://127.0.0.1:<port>/` from there. Every feature, spell and
  fix in `web/` shows up on the phone, matched to the wisp version running on that machine.
- **wisp starts with the desktop's own script.** `server/machines/bootstrap.js` is the script
  that desktop *Machines* sends over `ssh … sh -s`. It finds Node 20+, starts
  `npx -y wisp-agents` (or reuses a running wisp) and reports each `STEPS` entry back as an
  `@@wisp …` line. `npm run shared` copies it into `www/shared/`.
- **`web/` knows when it runs in the app.** The WebView adds `wispMobile` to its user agent.
  `MOBILE` in `web/js/core/state.js` then hides what a phone can't do: Take over in a terminal,
  opening an editor, keyboard hints.

```
www/                 the machines screen (vanilla JS, no build), mock.js for the browser preview
scripts/shared.mjs   copies server/shq.js, server/machines/bootstrap.js, web/css/tokens.css
android/app/src/main/java/dev/trywisp/mobile/
  Tunnel.java        SSH (sshj), runs the script, forwards the port, reconnects (plain Java)
  Keys.java          the phone's keys: Ed25519 made here, or imported OpenSSH/PEM/PuTTY
  WispSshPlugin.java the Capacitor plugin the page calls
  TunnelService.java keeps the app running while connected (foreground service)
  MainActivity.java  window.wispAndroid: notifications for wisp's page; Alerts.java posts them
```

## Use it

1. **Add a machine:** `you@host` (or `you@host:2222`), plus an optional name. To reach it from
   anywhere, put the phone and the machine on [Tailscale](https://tailscale.com) and use its
   tailnet name (`you@devbox.tail1234.ts.net`). With Tailscale SSH on a Linux machine
   (`sudo tailscale set --ssh`), no key is needed: the app tries that first.
2. **Let the key in.** Each machine uses one of the phone's keys. The sheet shows the
   `authorized_keys` command for it; run it once on the machine. You can also import a key the
   machine already trusts, or type a password under *Advanced* (used for that connection only,
   never saved).
3. **Connect.** The card shows the same steps as desktop Machines, then opens wisp. Android's
   back button returns to your machines. Connecting another machine switches to it, and wisp
   keeps running on both.

**Notifications.** When a task finishes, asks or needs approval while the app is off screen,
you get an Android notification; tapping it opens that task. The WebView has no Notification
API, so `MainActivity` gives wisp's page a `wispAndroid` bridge (`web/js/features/notify.js`
uses it). While a machine is connected, `TunnelService` (a foreground service with a quiet
*Connected to …* notification) keeps the app, the tunnel and the page running in the background.

The machine needs an SSH server, Node.js 20+ and the harness CLIs, signed in, just as with
desktop Machines. With wisp installed there, Settings → Machines → *This computer* checks each
one. Step by step: https://trywisp.dev/guides/connect-machines-with-tailscale.html

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
