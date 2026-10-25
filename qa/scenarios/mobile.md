# Android app scenarios

The app (`mobile/`) is a Capacitor shell: its own *computers* screen (`mobile/www`), then wisp's
own page from the computer it connects to, with `wispMobile` in the user agent (`MOBILE` and
`COMPUTER` in `web/js/core/state.js`). So most of it can be checked in Chrome with a phone
viewport; the native parts need Gradle or the emulator.

**How each one runs**

- `qa/mobile.mjs`: Chrome with a phone viewport, touch and the app's user agent, against an
  isolated wisp with fake agents (`node qa/mobile.mjs`, after `npm install` in `mobile/`).
- `Gradle`: `cd mobile && npm run build`, then `cd android && ./gradlew testDebugUnitTest`
  (`JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"`).
- `Emulator`: the debug APK on an emulator (`emulator -avd <avd> -no-window -no-audio`), a dev grid
  on the host reached with `adb reverse`, the WebView driven over CDP
  (`adb forward tcp:9233 localabstract:webview_devtools_remote_<pid>`).
- `Manual`: needs a real phone, a real computer over SSH, or the Play Console.

Never send builds to someone's own phone as part of QA.

---

### MOB-01 Debug APK builds
- **Run:** Gradle
- **Steps:** `cd mobile && npm install && npm run build`
- **Expected:** `BUILD SUCCESSFUL`; `android/app/build/outputs/apk/debug/app-debug.apk` exists;
  `www/shared/` holds `shq.js`, `machines/bootstrap.js`, `css/tokens.css`, `capacitor-core.js`.

### MOB-02 Unit tests
- **Run:** Gradle
- **Steps:** `./gradlew testDebugUnitTest`
- **Expected:** `KeysTest` (make, list, delete, import keys; fingerprints match `ssh-keygen -lf`) and
  `LetInTest` pass. `TunnelTest` is skipped unless `WISP_SSH_TEST` is set (see MOB-14).

### MOB-03 Computers screen on first start
- **Run:** `qa/mobile.mjs` (390×844 and 412×915), Emulator
- **Preconditions:** nothing saved (fresh install / empty localStorage).
- **Steps:** open the app (or `npm run preview`).
- **Expected:** *wisp, on your phone*; the **wisp Cloud** card comes first with
  `grid.trywisp.dev` filled in and **Sign in**; *Connect over SSH instead* is folded at the
  bottom; no sideways scroll; no page errors.

### MOB-04 The app opens on the computers list, never inside the last computer
- **Run:** `qa/mobile.mjs` (a saved computer used a moment ago), Emulator (force-stop and cold
  start after using a cloud computer)
- **Expected:** *Your computers* lists it with **Open**; the app does not navigate to its wisp by
  itself. The one used last is at the top.

### MOB-05 wisp's page in the app
- **Run:** `qa/mobile.mjs` (390 and 412 wide), Emulator
- **Steps:** open `http://<wisp>/?m=Studio` with `wispMobile` in the user agent.
- **Expected:** `body.wisp-mobile`; the top bar's Machines button reads the computer's name
  (*Studio*), not *Machines*; nowhere says *This computer*; the task list fills the screen
  (stacked split view) with a floating **New task** button and no New task row; no sidebar switch,
  no keyboard hints (`kbd`), no tips; no sideways scroll; no page errors.

### MOB-06 Desktop-only actions are gone; Computers goes back to the list
- **Run:** `qa/mobile.mjs`, Emulator
- **Steps:** open a finished task → **More**; press the phone's Back; then tap the computer
  button in the top bar.
- **Expected:** the task opens as a page of its own (Back, its title, the task), not in place in the
  list. The menu has no *Open project in editor* (still has Delete task). Back closes the page
  (the menu first, if open), back on the list where it was scrolled. The top-bar
  button goes to `https://localhost/?from=<computer>`, the app's own list. Take over runs in the
  in-page terminal (inline), never a terminal app.

### MOB-07 Start a task from New task
- **Run:** `qa/mobile.mjs` (fake agents), Emulator (cloud wisp on a dev grid)
- **Steps:** tap **New task**, type a prompt, tap send.
- **Expected:** home opens as a page (Back, the prompt box focused, Needs you under it); sending
  goes back to the list, where the task's row shows up, finishes, and opens with its presentation
  (hero, stats, files) rendered without sideways scroll.

### MOB-08 Long URLs wrap
- **Run:** `qa/mobile.mjs`
- **Steps:** open a task whose prompt holds a ~400-character URL.
- **Expected:** the URL wraps in the prompt and the answer; the page doesn't get wider than the
  screen.

### MOB-09 Notifications go through the app
- **Run:** `qa/mobile.mjs` (a stub `window.wispAndroid` with `foreground() → false`), Emulator
- **Steps:** first visit; then start a task and send the app to the background (Home) while it runs;
  tap the notification.
- **Expected:** the first visit asks for the notification permission (Android dialog). A task that
  finishes while the app is in the background posts an Android notification
  (`<project>: <title>`, the preview as text) via `wispAndroid.notify`; none while the task is on
  screen (a toast instead). Tapping it opens that task (`window.wispOpen`).

### MOB-10 Cached first paint and offline reopen
- **Run:** `qa/mobile.mjs`
- **Steps:** open the page twice (service worker installed and controlling), go offline, reload.
- **Expected:** `/sw.js` registers only in the app; the page and the last tasks paint from the
  cache at once, offline (no Chrome error page). The API is never cached.

### MOB-11 Sign in to wisp Cloud and open the cloud computer
- **Run:** Emulator
- **Preconditions:** `node bin/wisp.js grid dev --fake-agents --port 4544 --data <tmp>`;
  `adb reverse tcp:4544 tcp:4544`.
- **Steps:** type `wisp.localhost:4544` in the wisp Cloud card → **Sign in**; on the host open
  `/auth/dev/start?return=/activate?code=<code>&app=android`, sign in with any email, **Allow**.
- **Expected:** the app shows a `XXXX-XXXX` code; the grid page says *Device connected*; the app
  opens `http://<handle>.wisp.localhost:4544/?m=wisp Grid (dev)` with *Welcome to wisp*. Back on the
  list the cloud computer shows as *Cloud* with **Open** and an online dot.

### MOB-12 http only for a grid on the phone's loopback
- **Run:** Manual (or Emulator)
- **Steps:** enter `http://grid.example.com` as the grid.
- **Expected:** refused: *Use https:// for a grid*. `http://…localhost` is accepted.

### MOB-13 Connect over SSH (real computer)
- **Run:** Manual
- **Steps:** *Connect over SSH instead* → add `you@host` and the password → **Connect**.
- **Expected:** steps SSH, Node.js, wisp, tunnel tick off; the password is used once (the phone's
  key is added: `@@wisp keyed`) and not stored; wisp opens. A computer without Node.js gets it in
  `~/.wisp/node`. A changed host key is refused with *Forget and reconnect*.

### MOB-14 Tunnel against a throwaway sshd
- **Run:** Gradle (`TunnelTest`, see mobile/README.md → Test)
- **Expected:** connects, runs the bootstrap script, forwards the port and loads wisp's page through
  it; a dropped connection comes back; wisp stopping on the computer is started again; an unknown
  key and a changed host key fail with a clear message.
- **Note:** `startsWispAgainWhenItStops` kills the wisp it found, so the README's
  `command: 'false'` script can't start it again and the next test finds nothing: give the script a
  real start command (e.g. `env WISP_HOME=… node <repo>/bin/wisp.js`). On macOS a sshd run as a
  normal user has no audit session, and `nohup` there fails (*can't detach from console*), so the
  restart can only be checked against a real sshd (Remote Login) or Linux.

### MOB-15 Tailscale names
- **Run:** Manual
- **Expected:** a computer added by its Tailscale name connects from outside the home network; with
  Tailscale SSH on a Linux computer no key or password is asked.

### MOB-16 Notifications in the background over time
- **Run:** Manual
- **Expected:** while connected over SSH the *Connected to …* foreground notification stays and task
  notifications keep arriving with the screen off. Swiping the app away disconnects (documented).

### MOB-17 Play bundle
- **Run:** Manual (release only)
- **Steps:** bump `versionCode`/`versionName`, `npm run sync && cd android && ./gradlew bundleRelease`.
- **Expected:** a signed `app-release.aab`; the adaptive and themed icons look right on the launcher.
