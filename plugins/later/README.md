# wisp.later

Follow-ups, reminders and planned tasks (v1 `server/later.js`, `routes/internal.js` `resume_later`).

## Intent

- A follow-up scheduled on a task goes into that same task when due, so its agent carries on with its whole
  conversation, with a note saying who scheduled it and whether it is late.
- A reminder brings its task back to Needs you with its text; a reminder plan is a small task of its own.
- A planned task starts at its time, or after another task is done, or waits in Drafts.
- An agent schedules its own wake-up (`resume_later`), at most a week ahead and at most 10 in a row with no
  word from the user.
- What is due goes at most 3 at a time; something a day late isn't run but lands in Needs you.
- Unattended follow-ups wait while the account is past Automations stop at (wisp.budget), and go when it
  resets.

## Not yet

For later (park), the user's time zone (times are written in UTC until wisp.settings carries the offset),
and running reminder plans.
