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
- **Steps:** open the app (or `npm run preview`); tap **Continue with GitHub**; close the sheet;
  tap **Use your own wisp Grid**.
- **Expected:** three sample tasks (working, asking, shipped), *Your agents, in your pocket*, then
  **Continue with GitHub** and **Continue with Google**; no address field; *Connect over SSH
  instead* is folded at the bottom. GitHub opens the browser at
  `grid.trywisp.dev/auth/github/start` (return `/activate?code=…&app=android`), and the sheet shows
  the code and waits; after signing in, the browser asks to Allow that code. *Use your own wisp
  Grid* opens the sheet with an empty address. No sideways scroll; no page errors.

### MOB-03b Tips under your computers
- **Run:** `npm run preview` (390×844 and 360 wide, light and dark), Emulator
- **Preconditions:** signed in to wisp Cloud, nothing opened yet, notifications never asked.
- **Steps:** look under the list; tap **More tips**; tap a line; tap each card's button.
- **Expected:** *Tips* with *Step in to start* first (ring, solid button naming the computer),
  then *Hear when an agent needs you* and, with no computer of your own on the grid, *Bring your
  own computer*, quieter; then three lines. More tips shows the next three. A line opens its
  trywisp.dev guide in the browser. Start opens the first computer; Allow asks Android once and
  the card goes whatever the answer; How opens the guide at *Add the computer*. After a computer
  has been opened, *Step in to start* is gone. No sideways scroll; no page errors.

### MOB-04 The app opens on the computers list, never inside the last computer
- **Run:** `qa/mobile.mjs` (a saved computer used a moment ago), Emulator (force-stop and cold
  start after using a cloud computer)
- **Expected:** *Your computers* lists it with **Open**; the app does not navigate to its wisp by
  itself. The one used last is at the top.

### MOB-05 wisp's page in the app
- **Run:** `qa/mobile.mjs` (390 and 412 wide), Emulator
- **Steps:** open `http://<wisp>/?m=Studio` with `wispMobile` in the user agent.
- **Expected:** `body.wisp-mobile`; the avatar menu's row reads *Computers* with the computer's
  name after it (*Studio*), not *Machines*; nowhere says *This computer*; the task list fills the screen
  (stacked split view) with a floating **New task** button and no New task row; no sidebar switch,
  no keyboard hints (`kbd`), no tips; no sideways scroll; no page errors.

### MOB-06 Desktop-only actions are gone; Computers and the logo go back to the list
- **Run:** `qa/mobile.mjs`, Emulator
- **Steps:** open a finished task → **More**; press the phone's Back; then tap the avatar in the
  top bar and the computer's row in its menu; then tap the wisp logo.
- **Expected:** the task opens as a page of its own (Back, its title, the task), not in place in the
  list. The menu has no *Open project in editor* (still has Delete task). Back closes the page
  (the menu first, if open), back on the list where it was scrolled. The computer's
  row and the logo go to `https://localhost/?from=<computer>`, the app's own list, which has no
  Back button of its own (the phone's Back returns). Take over runs in the
  in-page terminal (inline), never a terminal app.

### MOB-07 Start a task from New task
- **Run:** `qa/mobile.mjs` (fake agents), Emulator (cloud wisp on a dev grid)
- **Steps:** tap **New task**, type a prompt, tap send; when it finishes, open it and tap **Mark done**.
- **Expected:** home opens as a page (Back, the prompt box focused, Needs you under it); sending
  goes back to the list with a *Sent to Claude* toast (**Open** opens the task) and the new row
  scrolled to the middle, clear of New task. It finishes, and opens with its presentation
  (hero, stats, files) rendered without sideways scroll. **Mark done** goes back to the list, not
  to New task.

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
  notifications keep arriving with the screen off. The same for a cloud computer (wisp Cloud, or
  your computer through a grid): *Connected to <name>* shows once it opens, and goes when Back
  returns to the computers list. Swiping the app away disconnects (documented).

### MOB-17 Play bundle
- **Run:** Manual (release only)
- **Steps:** bump `versionCode`/`versionName`, `npm run sync && cd android && ./gradlew bundleRelease`.
- **Expected:** a signed `app-release.aab`; the adaptive and themed icons look right on the launcher.

### MOB-18 Menus with the keyboard up, and a long computer name
- **Run:** `qa/mobile.mjs` (the keyboard as a window that shrinks while a text box has focus), Emulator
- **Steps:** connect to a computer with a long name (`Mokhless-MacBook-Pro-Studio-Workstation`);
  New task, type in the prompt so the keyboard is up, then tap the harness/model button, the place
  button and the mode button in turn. Open the avatar menu.
- **Expected:** each menu opens whole on screen: tapping its button puts the keyboard away and the
  menu sits above or below the button, scrolling inside when it's taller than the room. Picking
  doesn't bring the keyboard back. The place button ends the name in `…` and the bar's other
  buttons keep their room; *Run on* ends long names in `…` with *only* shown on every row. The
  avatar menu shows the name with the row's width.

### MOB-19 Grid sign-in through a grid restart, and Connect then Disconnect at once
- **Run:** `qa/mobile.mjs` (a fake grid through Playwright routes), Emulator
- **Steps:** sign in to a grid; while the app waits for **Allow**, the grid answers `/api/device/token`
  with a 502 (a deploy restarting it), then with the token. Sign in again and close the sheet.
  On the emulator: Connect to an SSH computer and Disconnect at once, 20 times
  (`Capacitor.Plugins.WispSsh.connect(…)` then `disconnect()` over the WebView's DevTools).
- **Expected:** the app keeps asking through the 502 and signs in when the grid is back; once the
  sheet is closed it stops asking. Connect then Disconnect never closes the app (Android kills an
  app that stops its foreground service before `startForeground`).

### MOB-20 Delete your account from the app
- **Run:** `npm run preview` in `mobile/` (the mock opens links in a new tab), Emulator
- **Steps:** signed in to a grid, tap *⋯* on its cloud row; tap *Delete your account* under *Sign out*.
- **Expected:** a quiet red link, 48px tall, never a filled button; it opens `<grid>/account#delete`
  in the browser, scrolled to *Delete your account* below the sticky header. Not shown before
  sign-in.

### MOB-21 A notification tap opens its task after the screen was off
- **Run:** Emulator (a stub page on `adb reverse tcp:4599` that sets `window.wispOpen`, driven over
  the WebView's DevTools)
- **Steps:** post a task notification (`wispAndroid.notify`). (a) On the computers list, tap it,
  then open wisp's page. (b) On wisp's page, tap it. (c) Home, `adb shell am kill dev.trywisp.mobile`,
  tap it, then open wisp's page. Reload wisp's page once after each.
- **Expected:** (a) and (c) land on the list and open the task as soon as wisp's page has loaded;
  (b) opens it at once. A reload doesn't open it again.

### MOB-22 One unreadable key doesn't hide the others
- **Run:** `./gradlew testDebugUnitTest` (`KeysTest.skipsAKeyThatDoesNotLoad`)
- **Steps:** three keys; truncate one's `.pub`, give another an unknown `alg`; list them.
- **Expected:** the good key lists; the other two are named in `unreadable` and the app says which
  it couldn't read (a toast that stays). With none readable, a fresh *This phone* key is made and
  the damaged files stay on disk.

### MOB-23 Swipe a row to mark it done or save it for later
- **Run:** Manual on the Pixel (debug APK); `qa/mobile.mjs`'s page can drive it with CDP touch events.
- **Steps:** on the list, swipe a finished task right past a third of the row and let go; swipe
  another left and tap *Undo*; flick a row a short way fast; pull a row a little and let go; swipe
  from the screen's very edge; scroll the list up and down over the rows. With a spell setting
  `card.swipeLeft` to `delete`: swipe a row left and wait for the toast to go.
- **Expected:** the band names the action (*Mark done*, *Save for later*) and fills (the phone ticks) once
  it would act; the row's time and buttons move with it. Letting go, or the flick, flies the row
  off and the gap closes. *Marked done* and *Saved for later* toasts, each with Undo, which puts the row
  back. A swiped delete says *Task deleted* and reaches the computer only once its toast has gone
  (or the app goes to the background). A short pull springs back. A running
  task's row only gives a little to the right, with no band. The edge swipe is Android's Back, and
  scrolling never swipes a row.

### MOB-24 Launch a My Stuff app in the app
- **Run:** Manual on the Pixel (debug APK). The grid side is in `test/grid.test.js` (`/_grid/preview`).
- **Steps:** connected to the cloud computer (and again to a computer *via grid* with **Show local
  pages in previews** on), open My Stuff and tap an app's **Launch**; Reload, Stop, Back. Then
  over SSH, tap **Launch** again.
- **Expected:** through the grid the app opens inside the app, full screen under its bar at
  `p<port>--…`, with no sign-in page in the frame and no *New tab*; Back closes it. Over SSH a
  toast says apps open there through wisp Cloud, or in a browser on that computer.

### MOB-25 Swipe a task page for its side panel
- **Run:** Manual on the Pixel (debug APK); `qa/mobile.mjs`'s page can drive it with CDP touch events.
- **Steps:** open a task; drag the page slowly to the left past half way and let go; drag the
  panel to the right; drag a little and let go; flick a short way fast both ways; open a file's
  diff with a long line and swipe on it both ways; pick Shell, go back, swipe again; scroll the
  task up and down; press the phone's Back once the panel is in. In light and dark.
- **Expected:** the panel tracks the finger with no hitch at the start or at 60fps through the
  drag, the task sliding and dimming under it; past 40% or on a flick it finishes, short of it it
  springs back. The diff scrolls first and only then does a right swipe go back. The swipe reopens
  Shell without the keyboard. Scrolling never moves the panel; Back returns to the task, then the
  list. A tap after a swipe doesn't press what was under the finger.

### MOB-26 Swipe a crew member's thread for its About page
- **Run:** Manual on the Pixel (debug APK); `qa/mobile.mjs`'s page can drive it with CDP touch events.
- **Steps:** open a crew member; drag the thread slowly to the left past half way and let go; scroll
  the About page; drag it to the right; drag a little and let go; flick both ways; open About again
  and tap its Back, then again and press the phone's Back; open About and tap one of its *Part of*
  tasks. In light and dark.
- **Expected:** the About page (facts, actions, notebook, brief, kit) tracks the finger with the
  thread sliding and dimming under it; past 40% or on a flick it finishes, short of it it springs
  back. Scrolling never moves it. Back (its own or the phone's) returns to the thread, a second Back to
  the list. A task opened from it opens normally and Back from it doesn't land on a stale About page.
  The reply box never takes the swipe.

### MOB-27 Download a picture, a video or a My Stuff file
- **Run:** Emulator or the Pixel (debug APK); `adb reverse` a local wisp and drive its page over CDP.
- **Steps:** in an answer with a picture (a fake agent's `SHOWCASE`) tap the picture's Download; open
  it full screen and tap Download there; tap Download on a video; in My Stuff, Download a file from
  its row and from its ⋯ menu. Tap the same picture's Download twice. Ask for a path that's gone.
  On Android 8 or 9, tap Download once.
- **Expected:** one tap saves it: a toast *Saved to Pictures/wisp* (videos *Movies/wisp*, other files
  *Download/wisp*), and the gallery shows it with no permission asked. A second save of the same file is
  named `… (1)`. A file that's gone says *Couldn’t save … the computer answered 404*. On Android 8 and 9
  the share sheet opens with the file instead. An app older than the computer's wisp shows no Download.

### MOB-28 Pull the computers list down to refresh it
- **Run:** Emulator, or `npm run preview` in `mobile/` with touch emulation (route the grid's
  `/api/computers`).
- **Preconditions:** signed in to a grid with one of your computers listed *Offline*.
- **Steps:** bring that computer online; at the top of *Your computers*, pull down a little and let go;
  then pull down past the point where the circle's arc is full (it turns accent) and let go. Pull with a
  sheet open, and pull from halfway down a long list.
- **Expected:** the short pull springs back and asks nothing. The long one spins the circle until the grid
  answers (at least half a second) and the row turns *Online* without waiting for the 10 s refresh. The
  page itself doesn't stretch or glow. A sheet, a scroll that isn't at the top, or a sideways swipe never
  starts a pull.

### MOB-29 Take a photo or record a video for a prompt
- **Run:** Emulator (its virtual camera) or the Pixel (debug APK).
- **Steps:** in New task tap the paperclip; the menu reads *Take photo*, *Record video*, *Choose files*.
  Tap *Take photo*, shoot, accept. Tap the paperclip → *Record video*, record a few seconds, accept.
  Tap the paperclip → *Take photo* and back out of the camera. Send the prompt. Open a task and do the
  same from its reply box. Tap the paperclip twice.
- **Expected:** the camera opens with no permission asked; an accepted photo shows in the tray with
  its thumbnail (`photo-<date>.jpg`), a video with the video icon (`video-<date>.mp4`), each uploads
  and goes with the message (the photo shows in the turn). Backing out adds nothing and the next pick
  still works. A second tap on the paperclip closes the menu. In a browser the paperclip still opens
  the file picker straight away.

### MOB-30 Dictate a prompt
- **Run:** Emulator with Google's speech service (its virtual mic) or the Pixel (debug APK).
- **Steps:** in New task type a few words, tap the mic next to the paperclip. The first time, answer the
  microphone question with *Don't allow*; tap the mic again and allow it. Say a sentence, pause, say
  another, tap the mic. Open a task, tap the mic in its reply box (folded), speak, tap Send while it
  still listens. Leave the app while it listens and come back.
- **Expected:** refused, a red toast says how to allow it (after a second refusal: Android Settings →
  Apps → wisp → Permissions). Allowed, the mic turns accent while it listens and the words appear in
  the box as you speak, after the typed words with one space; tapping it stops and keeps the text.
  The reply box opens up when the mic starts. Sending clears the box and nothing comes back into it.
  Leaving the app stops listening. In a browser and the desktop app there is no mic.

### MOB-31 The reply box stays one row at any state
- **Run:** `qa/mobile.mjs`
- **Steps:** on a task at 412 and 360px, light and dark: open the reply box idle, running, waiting and under a live transcript; Queue on and off; type `/btw …` and clear it; type `tomorrow at 9am run the linter`; attach a file with a long name; paste a long message; a task with 6+ delegates.
- **Expected:** the buttons are one row, each 44px, and the bar scrolls sideways with Send pinned. What the box says (*Side question · …*, a read time) is one line above the buttons, ending in `…`, never a wrapped column. Toggling `/btw` moves neither Send nor the input sideways; the buttons step back but stay readable. Under a transcript the working panel's orb, status and Stop are centred on one row.

### MOB-32 The reply box in a phone browser
- **Run:** `qa/mobile.mjs`
- **Steps:** in a plain browser (no app) at 412 and 360px, light and dark: open a task's reply box; type `/btw …` and clear it; type `tomorrow at 9am run the linter`. Widen the window past 720px with `/btw` still typed, and narrow it again.
- **Expected:** as MOB-31, with the browser's 30px buttons: none squeezes, the hint is one line above them ending in `…`, and neither Send nor the input moves sideways. Past 720px the hint is back inside the bar, as on a desktop.

### MOB-33 Share to wisp from another app
- **Run:** `Gradle` (`SharedTest`), `Emulator` for the intents; a real share sheet is `Manual`.
- **Steps:** with no computer open, share a link from another app to wisp. Then open a computer. With wisp's page up, share a picture, then three pictures, then 11 files, then text with a task open. Kill the app holding a share and open it again. Tap a task notification, and follow the grid's `dev.trywisp.mobile://` link.
- **Expected:** the list says *What you shared is waiting*; opening a computer lands it in New task. Files show as chips at once, *Shared from outside wisp* above them, and upload only on Send; Send tapped while they're still read waits for them. A second share during a read fails the first's chips with a toast (its folder gone), never a cut file. Over the caps a toast says what was left out. A file:// URI or wisp's own provider (also as `content://0@dev.trywisp.mobile.fileprovider/…`) is left out too. Nothing starts by itself. A frame on the page (a task's preview) calling `takeShare`, `shareChunk` or `shareDone` with no token or a wrong one gets nothing and doesn't use the share up; the token only arrives in the main frame's `wisp-share` event, and only on the open computer's exact origin: a preview opened in a new tab (`p5173--<handle>`), another port on 127.0.0.1 or another handle gets an event with no token. After it's taken the app's `cache/shared` folder is empty, and a killed app's is emptied on the next open. From Recents the old share doesn't come back. A computer on an older wisp keeps it and says so after 20 seconds. Notifications and the link back open as before.
- **Emulator**, **Manual** (Play's build on a real phone)

