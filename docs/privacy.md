# Privacy policy

Last updated: 2026-10-22

This policy covers wisp: the `wisp-agents` app you run on your own computers, the wisp app for
Android (`dev.trywisp.mobile`), wisp Cloud (`grid.trywisp.dev`) and this site (`trywisp.dev`).
wisp is open source ([github.com/M0xoo/wisp](https://github.com/M0xoo/wisp)), so everything
below can be checked in the code. Questions or requests: **[hello@trywisp.dev](mailto:hello@trywisp.dev)**.

**The short version:** wisp runs on your computers. Your prompts, code, file paths, project names
and agents' output stay there and are never sent to us. wisp sends anonymous usage counts, which
you can turn off. wisp Cloud keeps the account details it needs to sign you in.

## What wisp never sends us

- Your prompts, your code or the agents' replies and reports.
- File paths, project or repository names, repository URLs.
- Passwords, SSH keys, or the sign-ins of your coding agents (Claude Code, Codex and the others).

## Anonymous usage stats

wisp (on your computer, on a wisp Cloud computer, and the page the Android app shows) sends
anonymous usage events to [PostHog](https://posthog.com) (US). They help us see which features are
used and what breaks.

- **What's in them:** wisp's version, your OS, CPU architecture and Node.js version, which coding
  agents are installed and their versions, and events such as a task starting or ending (agent,
  model, mode, how long it took, token counts and cost, how many files changed). Error reports
  include the error's type, message and stack trace with paths removed.
- **Who it's tied to:** a random ID made on install. No name, email or account, and PostHog keeps
  no person profile for it.
- **Turning it off:** Settings → Privacy → *Anonymous usage stats*, or run wisp with
  `WISP_TELEMETRY=0` or `DO_NOT_TRACK=1`. It's always off in CI.

## Feedback you send

When you rate a task or send feedback (`/feedback`, *Send feedback*), we receive your rating and
what you wrote (your home folder replaced by `~`), wisp's version and your OS. A rated task also
includes the agent, model, mode and how the task ended. Feedback has its own random ID and is never
linked to your usage stats. Run wisp with `WISP_FEEDBACK=0` to turn feedback off.

## The Android app

- **On your phone:** the computers you add (name, address, user, port), the app's SSH keys,
  the host keys of computers you've connected to, and for wisp Cloud a device token. They live in
  the app's private storage, are not backed up, and are deleted when you uninstall the app.
- **Passwords** are used once to add the phone's key to your computer, then forgotten.
- **Connections:** the app connects over SSH to the computers you add, and to wisp Cloud if you
  sign in. To start wisp there, your computer may download Node.js (nodejs.org) and wisp (npm).
  The app itself contains no analytics or ads. The wisp page it shows comes from your computer,
  and sends the usage stats above unless you turn them off there.
- **Permissions:** notifications (a task finished, asked something or needs approval) and a
  foreground service that keeps the connection to your computer open while you're connected.

## wisp Cloud

When you sign in to wisp Cloud with Google or GitHub, we store:

- **Your account:** email, name, profile picture URL, your Google or GitHub account ID and
  GitHub username, and the handle of your address (`<handle>.grid.trywisp.dev`). We ask Google
  for `openid email profile` and GitHub for `read:user user:email`.
- **Sign-ins and devices:** sessions (with the browser's user agent) and the devices you allowed,
  such as the Android app. Tokens are stored only as hashes. Sessions end after 30 days unused.
- **Your cloud computer:** your files, wisp's data, and the sign-ins of the agents you use there.
  They stay on your computer's disk and aren't read by the service, but whoever runs a server can
  technically access what's on it. Secrets wisp Cloud keeps for you are encrypted.
- **A record of account actions** (signing in, linking a sign-in method, allowing or removing
  a device) for security.

wisp Cloud runs on [Hetzner](https://www.hetzner.com) in Germany. It uses three cookies, only to
keep you signed in: `__Host-grid`, `__Host-wisp` (30 days) and `__Host-grid_oauth` (10 minutes,
during sign-in). It may also count events such as sign-ups, sign-ins and computers starting or
sleeping, with your account replaced by a one-way hash.

A wisp Cloud (a *wisp Grid*) run by someone else on their own server is theirs, under their
policy, not this one.

## Delete your wisp Cloud account

Delete it yourself at any time: at the bottom of your account page on
[grid.trywisp.dev](https://grid.trywisp.dev), choose **Delete your account** and type your handle.
That deletes at once your cloud computer and its files (your agents' sign-ins included), your
account, sign-ins, devices, stored secrets and the record of your account's actions. Your agents'
sign-ins stay valid at Anthropic, OpenAI or GitHub until you sign out of them there. Server backups
that still contain them are overwritten within 30 days.

Or email **[hello@trywisp.dev](mailto:hello@trywisp.dev)** from the address you sign in with and ask us to delete your account.
Within 30 days we delete your account, sign-ins, devices, stored secrets, your cloud computer and
its files, and the record of your account's actions, and we confirm by email. Server backups that
still contain them are overwritten within a further 30 days.

You can also remove devices and sign out everywhere yourself in wisp Cloud at any time.
Uninstalling the Android app deletes everything it stored on your phone.

## This site

trywisp.dev uses PostHog to count page views and clicks, such as copying the install command or
opening wisp Cloud. To show how many wisp Cloud seats are left, its pages ask grid.trywisp.dev for
the count; that request carries nothing about you. If you join the wisp Cloud waitlist, your email
is stored in PostHog so we can write to you when a seat is free; ask us to remove it at any time.

## Services wisp works with

These receive data only when you use them, under their own privacy policies:

- **Your coding agents** (Claude Code, Codex, opencode, Cursor, Grok, Antigravity) send your
  prompts and code to their makers with your own account. wisp starts them; it doesn't see that
  traffic.
- **Phone alerts** through [ntfy](https://ntfy.sh) or Telegram, if you set them up, carry task
  titles and summaries.
- **Google and GitHub** for signing in to wisp Cloud. **npm** for checking for wisp updates
  (`WISP_UPDATE_CHECK=0` turns that off).

## Children

wisp is a developer tool and isn't meant for children under 13. We don't knowingly collect their
data.

## Changes

We'll update this page when what wisp collects changes, and note it in the
[changelog](https://github.com/M0xoo/wisp/blob/main/CHANGELOG.md). Contact:
**[hello@trywisp.dev](mailto:hello@trywisp.dev)**.
