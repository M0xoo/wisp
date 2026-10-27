# Words

wisp talks like a helpful colleague: plain, short, concrete. Read your UI text out loud; if it
sounds like a manual, rewrite it.

## Names

Use these, everywhere in the page, the app, the site and the CHANGELOG:

| Say | Not |
|---|---|
| task | session, wisp, job (the code says `session`; the page doesn't) |
| *New task* | New wisp |
| *Needs you*, *Working*, *Done*, *Archived* | Inbox, Running, Completed |
| *Finished* (the agent's verdict) | Completed, Success |
| *Mark done* / *Reopen* | Close / Resolve |
| *Rerun…* | Replay (that's a separate presentation, under More) |
| *Ship it* | Push, Deploy |
| harness (Claude Code, Codex, …), model, thinking level | provider, engine, effort |
| prompt box / reply box (*follow-up*) | input, chat box |
| *Computers* (in the phone app), *Machines* (on desktop) | servers, hosts |
| spell | plugin, theme, mod |
| *Crew*, crew member, *job*, spirit (its avatar) | agents, assistants, bots (an agent is the harness running a task) |
| *Track record* (a member's), *Compare crew* (everyone's) | stats, performance, score, leaderboard |
| Settings → *Section* → *Row* | the config, preferences |
| *For later* (the list section), *Save for later* / *Unsave* (the action, everywhere; toasts *Saved for later* / *Unsaved*) | Bookmark, Pin, Park, Read later, Remove from For later |
| *scheduled follow-up*, *scheduled task*, *reminder*; *Scheduled* (the list section), *Coming up* (split home) | wake-up, resume, timer (fine in code and in the agent's tool) |

When you rename something, change every place it shows (menus, palette, settings, tooltips,
toasts, docs, guides, README).

## Labels

- Buttons say what happens: a verb, or verb + object (*Delete recipe*, *Add a delegate*). Never *OK*,
  *Submit* or *Yes*.
- Sentence case. No trailing periods on labels, titles or menu items.
- Times: relative for the past in lists (*28m ago*), absolute for the future (*14:32*, *Mon 9:00*, never *in 18m*, which reads as *ago*); the full date, and *in 18 min*, on hover.
- Use `…` on a label only when it opens something that asks more (*Rerun…*).
- Settings rows: a short title and one line saying what it does, in the person's terms.

## Messages

- Toasts: past tense for what happened (*Archived*, *Marked done*), with *Undo* when it can be
  undone.
- Errors: what went wrong and what to do, in a sentence (*Still working — stop it first or let it
  finish.*). No stack traces, codes or "Something went wrong".
- Confirms: the question in the first paragraph, the consequence after a blank line, the action on
  the button.

## CHANGELOG lines

A user-facing change gets a line under *Unreleased* (AGENTS.md): a bold summary of what the person
sees now, then what was wrong before and where to find it. Write it for someone using wisp, not
reading the code (*Toasts no longer cover the reply box: …*).
