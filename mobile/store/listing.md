# Google Play listing

Paste-ready text for the Play Console (*Grow → Store presence → Main store listing* and *Policy →
App content*). Keep it in step with `docs/privacy.md` and `mobile/README.md` → Google Play.

## Main store listing

**App name** (≤30): `wisp: coding agents on the go`

**Short description** (≤80):

```
Start, answer and review your AI coding agents from your phone.
```

**Full description** (≤4000):

```
wisp runs AI coding agents like Claude Code, Codex, opencode and Cursor in parallel, each in its
own git worktree, and hands back a one-screen report instead of a transcript. The app puts that
wisp in your pocket.

• Start tasks from your phone. Type a prompt, pick the agent and the project, and go. The agents
  run on your computer or your cloud computer, not on the phone, so they keep working when the
  screen is off.
• Answer when they ask. Questions and approvals come in as notifications; tap one to reply.
• Read the report, not the transcript. Diffs, test results, commits and decisions, laid out for a
  phone.
• Your computers, one tap away. Sign in with GitHub or Google and every computer you added to wisp
  Cloud is listed. Or add one over SSH: its address and your password once, and the app uses its
  own key from then on.
• wisp Cloud. No computer to leave on? Get a cloud computer with wisp ready to go.

Private by design: your prompts, code and the agents' replies stay on your computers. The app has
no ads and no analytics of its own.

wisp is free and open source: github.com/M0xoo/wisp
You need a coding agent account (Claude Code, Codex, …) to run tasks.
```

**Category:** Tools. **Tags:** Developer tools, Productivity.
**Contact email:** hello@trywisp.dev. **Website:** https://trywisp.dev
**Privacy policy:** https://trywisp.dev/privacy.html

**Graphics:** `icon.png` (512×512), `feature-graphic.png` (1024×500), and 2–8 phone screenshots
(1080×1920 or larger, 9:16): the computers list, a task's report, the prompt box, a question
notification. Take them from a debug build on a phone in light mode, with real-looking demo tasks
(no personal paths or emails).

## App content

| Question | Answer |
|---|---|
| Privacy policy | https://trywisp.dev/privacy.html |
| Ads | No ads |
| App access | Some features need sign-in: give reviewers a wisp Cloud test account (GitHub or Google sign-in with no 2FA prompt, or a grid account they can reach), with steps: *Continue with GitHub → Allow → tap the cloud computer*. |
| Content rating | IARC questionnaire: Utility/Productivity; no violence, sexuality, gambling, user-to-user chat or sharing location. Expected: Everyone / PEGI 3. |
| Target audience | 18+ (a developer tool, not for children) |
| News app | No |
| Government app | No |
| Financial features | None |
| Health | None |
| Foreground service | `specialUse`: keeps the user's SSH tunnel to their own computer open while connected, so task alerts arrive with the app in the background. Video: connect to a computer, show the *Connected to …* notification, background the app, a task alert arrives. |
| Account deletion | In-app path: wisp Cloud account page → *Delete your account*. Web: https://trywisp.dev/privacy.html#delete-your-wisp-cloud-account |

## Data safety

The app's own code collects nothing; the wisp page it shows does. Answer for both.

| Data type | Collected | Shared | Optional | Why |
|---|---|---|---|---|
| Personal info → Email, Name, User IDs | Yes (wisp Cloud sign-in only) | No | Yes (SSH needs no account) | Account management |
| App activity → App interactions | Yes (anonymous usage stats) | No | Yes (Settings → Privacy) | Analytics |
| App info and performance → Crash logs, Diagnostics | Yes | No | Yes (Settings → Privacy) | Analytics |
| Device or other IDs (a random ID made on install, tied to the usage stats) | Yes | No | Yes (Settings → Privacy) | Analytics |
| Messages / feedback you send | Yes, when you send it | No | Yes | Developer communications |

- Data encrypted in transit: **Yes** (HTTPS to wisp Cloud and PostHog; SSH to your computers).
- Users can request deletion: **Yes** (link above).
- Not collected: location, contacts, files and docs (your code stays on your computers), photos,
  audio, calendar, financial info, health, web history.

## Going public

A personal developer account made after Nov 2023 has to run a **closed test with 12+ testers for
14 days** before *Production* unlocks. Plan: internal testing first (yourself), then a closed test
track with the testers' Google accounts, then apply for production.
