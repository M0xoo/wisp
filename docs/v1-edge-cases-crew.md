# Crew row (crew, goal, later, budget, Auto/router, automations, learn): v1 edge cases for the Rust brief

Gathered from the five porting agents' readings of v1. Line numbers marked ~ are approximate.

## Top 10 (across the row)
1. **Budget: when "Automations stop at" holds** (server/budget.js ~470-478, ~47-56):
   - A window holds only if it is at or past the line and has a reset in the future. A window with no reset time holds nothing.
   - `until` is the latest reset among the windows past the line.
   - A harness's own line set to 'same', unset, or an unknown value falls back to `autoStop`.
   - Who is held: an unattended launch (a check-in or a trigger) is refused with a 409 and the hold attached (services/launch.js:150-153). An agent's scheduled follow-up is held; the user's own follow-up never is (later.js:420).
2. **Budget: spotting an early ("banked") reset** (budget.js ~58-62, ~330-334; index.js:504-509):
   - Two reset times less than 10 minutes apart are the same period, because Codex's "resets in n s" drifts.
   - It counts as early only if all three hold: the old reset hadn't come yet, the new one is more than 10 minutes later, and use fell by at least 25 points (or went from 10%+ to under 5%).
   - `onReset` fires once per period.
   - Crew and triggers are released only if no other window still holds that account.
3. **Budget: reading a full window** (budget.js ~120-138): a Claude `status: 'rejected'` with no `utilization` counts as 100%. `rateLimitType: 'overage'` never becomes a window. `isUsingOverage: true` marks the run "past your plan" even when no windows come back.
4. **Later: limits and the plan hold** (later.js:20, :42-43, :104-107, :124, :420, :475-479; runner.js:1456):
   - A time sooner than 1 minute from now is refused. The latest allowed is a month ahead for the user, a week for an agent.
   - A task may have at most 5 pending entries.
   - After 10 agent wake-ups in a row with no word from the user, the next one is refused. Any user message resets the count.
   - A due follow-up that isn't the user's (or a reminder), on an account past the stop line, moves to max(until, now + 1 min) with `held`. The next due entry goes instead. Editing the time clears `held`.
5. **Later: late, missed and lapsed entries** (later.js:73, :170-210, :370-374, :410-435):
   - Due more than 24 h ago: never sent. It becomes a "Missed follow-up" reminder; a late task plan becomes a "Missed: …" task.
   - Sent more than 2 minutes late: the agent is told it is N minutes late. Send now is never marked late.
   - On an archived task, due entries lapse.
   - A follow-up never goes while the task is running, asking a question or waiting on delegates. Reminders still fire.
   - Mark done drops the agent's and wisp's wake-ups and keeps the user's.
6. **Goal: verdicts and stalls** (goal.js:313-331, :356-361, :423-440, :460-473):
   - A "met" with no evidence, or while the project's tests fail, is overruled to not_yet with progress capped at 95.
   - Two not_yet rounds in a row that changed nothing, or repeated the same next step with no progress, pause the goal as "Stalled".
   - With judges, "impossible" needs a majority. When only judges that didn't answer hold the goal back, it pauses instead of sending an empty round.
   - A round past the plan line is scheduled at max(until, now + 61 s) and the goal pauses as "Waits for your plan". If it can't be scheduled because the task already has 5 entries, the goal pauses and the task goes to the user.
7. **Crew: the schedule** (crew.js:47-48, :259-277, :387, :856-859):
   - The current cron minute stays due until its check-in has run (`lastMinute`). A check-in fires at most once per cron minute.
   - The tick clears `wakeAt` when it fires.
   - `wakeIn` is clamped to between 5 minutes and 7 days.
   - A second check-in while one runs or waits returns `{already: true}`, which the route turns into a 409 (crew.js:848).
8. **Crew: queue, holds and filing** (crew.js:615-619, :670, :752-774, :819-835, :954-959):
   - A job waits when the member is at its `parallel` limit, or is paused (except `task` and `mention` jobs). The 21st waiting job gets a 429.
   - An unattended job held by the budget is logged as skipped, with one line and a counter for skips in a row. It doesn't count as a check-in.
   - Only check-in and `event` jobs can end quiet or For later, and only on their first turn. For later beats quiet. A delegated job is always filed under Done.
   - A member sends at most 3 follow-ups, only to tasks it is linked to. A delegated job's follow-up to the lead that delegated it is dropped, so work can't bounce back.
9. **Auto: telling limits apart** (router.js:180-217, :685-702; index.js:326-328):
   - A usage limit, quota, 402 or billing error cools the whole harness for 60 minutes, or until the stated "resets 9pm" + 1 min, at most 6 h.
   - A 429 or "overloaded" cools that model (every effort level) for 10 minutes.
   - "Too many active sessions" or "device limit" cools the harness for 15 minutes. It is checked before "session limit", which means Claude's usage window.
   - On Codex, a 429 while every known window is below 99.5% is a 60 s blip.
   - A run that hit a limit is voided: its reward is subtracted from the stats and later signals are ignored.
   - Model keys: `claude:` and `claude:opus` both become `claude:opus:medium`. In `opencode:ollama/llama3:8b` the model id is kept whole, because a trailing segment is a level only if it is a known effort.
10. **Automations: loop guards and webhooks** (triggers.js ~250-330, ~380-440; hooks.js ~85-185):
    - A watcher's first poll only records what is already there. Run now acts at once. At most 3 starts per poll. A held run puts the items it didn't start back as unseen.
    - Each task fires a trigger at most 3 times. Subagents, delegates and `agent === 'wisp'` are ignored, and so are a crew event job's or a task watcher's own task, and a member's own jobs. This prevents loops.
    - A CI failure on a branch that has an open task becomes a queued follow-up on that task.
    - Webhooks: an unknown token gives 404 (tokens compared in constant time). A bad signature gives 401 (Slack v0 or Linear within 5 minutes; plain HMAC as `sha256=`, bare hex or a PagerDuty v1 list). At most one task per trigger per 30 s. Slack retries are deduped by `channel:ts`. The 202 goes out before the task starts.

## More, per plugin
- **budget**:
  - The learned rate uses only readings within 30 minutes of each other, never a live read, and halves once past 0.3. It is trusted only after 2 points of movement.
  - `resetAt` = the latest reset among windows at 99.5% or more whose reset hasn't passed.
  - A window's move is split among the turns that ran since the last report, by how long each ran.
  - Notices: the first report of an account announces nothing. "Gone" needs 3 missed complete reports over 6 h or more. The same Codex slot under a new id is a length change.
  - Drain watch: one phone note per window per 2 h, only with `drainWatch` on.
  - A live Codex entry whose reset has passed is frozen and replaced by the newest non-side bucket.
- **later**:
  - /after plans: the target marked done starts the plan. The target deleted or archived turns the plan into a draft with `lost`. A target already done starts it at once.
  - For later: a task that is still working can't be parked (409). Any state change, Archive, a new turn that isn't a compaction, or a reminder firing takes the task out of For later.
- **crew**:
  - Notebook: `remember` adds at most 12 lines of 300 characters. Past 12,000 characters the oldest lines go.
  - A field a spell owns can't be edited (409). Resuming a member whose spell changed needs `accept: true`.
  - Mentions: stored `@[Ada](crew:id)` tokens are matched first. Plain names are matched longest first, never inside a word or an email. A mention is "leading" only after spaces, commas or colons.
  - A member's job can't remove that member.
  - Import is all or nothing and joins paused. Clashing names become "Scout 2" (24 characters at most).
- **router**:
  - Rewards: a signal replaces the earlier one (switched beats merged, which beats 👍/👎, then closed, rolledBack, error, then the hero minus 0.1 per follow-up, floor 0.05). Hand-picked runs weigh 0.5.
  - Tiers: Best runs only frontier models (else none). Balanced steps down only when every frontier model is cooling. Name-based tiers match whole segments ("gemini" is not "mini").
  - New arms after the first sync are suggested only until 3 outcomes. A late detection never overwrites a newer one.
- **automations**:
  - Cron: day-of-week 7 is Sunday. With both day fields restricted, either one matching fires it. `nextRun` looks 1 year ahead, then gives null.
  - `toCron` returns null for any unknown word. A day with no time means 9:00. "between 9 and 6" means 9:00 to 18:00.
  - A hook secret is never sent back. Changing a trigger's kind, folder, label or branch resets its bookkeeping.
  - Slack starters are member IDs only, at most 50.
  - Templates: `{{body.a.0.b}}` is filled in one pass and never re-expanded. A strict recipe refuses a missing `{param}`.
- **learn**:
  - Lists are deduped ignoring case, at most 10 items of 180 characters.
  - A retro's proposal is applied as a diff against what it saw, so edits made during it survive.
  - A single turn that just worked gets no retro. The retro waits for 90 s of quiet; a new turn cancels it. Retros run one at a time.
