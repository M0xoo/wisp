# Today: what's happening, in one view

Status: being built, 6 Nov 2026. The owner decided: a new Home page, and the New task page stays as it is. Mockup: `design/mockups/today.html` (a sample of one real evening, not live data).

## The problem

The sidebar answers "what state is each task in?". Someone who feels lost is asking something else:
*does anything need me, is it going fine, and what did I miss?*

Measured on the owner's real tasks, last 24 hours:

| | |
|---|---|
| Tasks touched | 45 (7 working, 8 in review, 30 done) |
| Pieces of work they belong to | 19, following a task's parent or the crew job's source |
| Tasks started by delegation to the crew | 20 of 45 |
| Largest piece of work | 6 tasks |
| Titles over 60 characters | 9 of 45 |

That's 2.4 tasks for each thing the person actually cares about, and a task's title is often a raw
prompt or the agent's latest news, so it changes over time.

## The idea

**Home is a new page, this overview.** It opens when wisp starts and from the wisp icon at the top. *New task* keeps its page, unchanged. On Home the prompt box stays first and never moves, tips go last, and between them the page reads as three questions.

1. **What's going on?** One sentence that names things instead of counting them:
   *Kilo Code and Plan limits need you. Publish check looks stuck.* With nothing to do: *All quiet.*
2. **What do I have to do?** **Needs you** cards you can answer in place. Each says who asks, what, and why.
3. **Is the rest fine?** **Working**: one row per piece of work, not per task, in fixed columns: who, what
   in one plain sentence, how far (Asked, Working, Checks, Your review, Merged), when it last changed.

Below: *Done today*, folded, *Coming up* and *Left in your plans*. After time away, the second line
under the sentence becomes *While you were away, 19:00 to 23:00: …* and Done opens with what's new marked.

## Decisions (6 Nov, with Moris's evidence)

Moris's sources are in `~/.wisp/crew/1e0f1342e828/` and the job report. In short:

1. **Wide windows open on Home; it's a choice.** Settings → *Start on*: *Home* or *Last task*, kept on every launch. Forced
   start views are what people protest (Cursor, Antigravity), and an empty start screen too (CC#102264). Nobody
   running parallel agents complained about an overview.
2. **Phones and narrow windows keep the list first.** The wisp icon opens Home. Phone apps are lists, and the complaints
   are about wrong or unsorted lists. This is judgment: nobody compared the two.
3. **Order:** Needs you, Ready for review, Working, Done. Usage is one quiet line, not a tile. No board, no timeline. Rows
   show the project, because removing project grouping drew 46 reactions (CC#102088).
4. **Since you left** is unread results from each task's existing final report, grouped by project, with PR chips. No model
   call: summaries cost real requests (CC#86879), and demand for a written digest is thin.
5. **Never call silence stuck.** A row can say *Quiet for 12 min* as a fact. *Looks stuck* needs 3 identical failures or a
   named retry state, and only after checking it isn't waiting on you. 3 is a starting guess. Timers alone fail:
   Codex#24260 was silent 30 minutes, then ran normally.

## Rules for it

- **Grey unless it matters.** Colour only where a person has to act, as in control rooms (ISA-101).
- **Dark when fine.** A quiet state is the goal, so it shows almost nothing.
- **A warning always has an owner and a next step.** No red with nothing to do about it.
- **Plain words, not statuses.** Flighty's aim: "boringly obvious".
- **No model calls.** Everything is written from data wisp has, so opening it spends no allowance.

## Where it came from

| Source | What it gave us |
|---|---|
| [Claude Code agent view](https://claude.com/blog/agent-view-in-claude-code) | Rows of waiting, working, done with the last response. One harness only, per session |
| [Cursor Needs Attention](https://forum.cursor.com/t/agents-approval-window/170388) | Blocked agents gathered in one group. A user: "one agent might be waiting for user approval without me knowing it's stuck" |
| [LangChain agent inbox](https://www.langchain.com/blog/ux-for-agents-part-2-ambient) | Notify, Question, Review: a queue of where the agent needs help |
| [GitHub mission control](https://github.blog/ai-and-ml/github-copilot/how-to-orchestrate-agents-using-mission-control/), Antigravity's inbox | One place across agents, but still a unit per agent run |
| [KanVibe](https://hnshowcase.com/post/47034185/kanvibe-kanban-board-that-auto-tracks-ai-agents-via-hooks), [Kanban Code](https://github.com/langwatch/kanban-code) | People build boards just to know who is waiting. [One comparison](https://www.mindstudio.ai/blog/vibe-kanban-vs-paperclip-vs-claude-code-dispatch) says they get unwieldy at 15+ agents. wisp's Agent board pane stays for that |
| [agenthud](https://github.com/neochoon/agenthud) | The closest to a digest: daily or weekly, written by a model. We found no live "while you were away" across harnesses |
| [Which one was doing what?](https://artemxtech.substack.com/p/how-i-manage-10-claude-code-agents), [Chip Huyen, Simon Willison on overload](https://builtin.com/articles/ai-brain-fry-software-developers) | Attention is the limit. Anecdotes, not studies |
| [Linear Pulse](https://linear.app/docs/pulse), Slack recaps | A bounded catch-up, not an endless feed |
| [Superhuman splits](https://help.superhuman.com/article/441-splits) | A count that works as a to-do list |
| [Flighty](https://blakecrosley.com/guides/design/flighty) | One line per flight, only what this stage needs |
| [Mayo Clinic's ER board](https://medcitynews.com/2012/04/mayo-clinic-docs-real-time-dashboard-makes-er-patient-tracking-easier/), kitchen tickets | Overview first, detail on click. Age makes a ticket stand out |
| [Endsley's three levels](https://en.wikipedia.org/wiki/Situation_awareness) | What is, what it means, what's next: the page's order |
| [ISA-101](https://control.com/technical-articles/going-gray/), [EEMUA 191](https://library.e.abb.com/public/72f20c70c7b44d889d463db81df5c38d/SCADA%20Alarm%20Management%20White%20Paper.pdf) | Grey screens, under one alarm per 10 minutes |

Most tool write-ups are third-party. The Moris evidence pass on user quotes didn't run: Moris was at the job limit.

## What we tried and dropped

Gucci reviewed the first mockup in Chrome and we changed course:

- **A day line** (a timeline with a now line, one lane per piece of work). Dropped: 738px of space to say what
  the words already say, and most rows were the same blue stub. Stage dots answer "how far along?" better.
- **Floor** (spirits in rooms). Dropped as a work view: it repeats the rows and puts a member in two rooms.
  Could come back as an idle second-screen mode.
- **Brief** (a written front page). Its idea stayed: name things. The sentence comes from it.
- **Counting** (*Two things need you, four are moving*). Dropped: numbers need decoding and disagreed with headings.
- **A board** was never a candidate: Agent board already exists, and four columns are still one card per task.

## What wisp has already, and what's missing

| Needs | Today |
|---|---|
| All the data for Needs you, Working, Done | `groups()` in `web/js/features/feed.js`, `underMember` jobs as on home |
| Grouping into a piece of work | `trailOf()` in `lineage.js`: climb `parentId` and `crew.from`. Client only |
| One plain line | The last turn's summary, as the list and `wisp_sessions` show it |
| Stage | Derive from `state` and `pr`: no PR yet, checks, review, merged |
| Coming up, plans | `upcoming()` in later.js, `S.agents` |
| A stable name | **Missing.** A title can be the agent's latest news. Use the first prompt's title or the PR's title |
| Time away | **Missing.** Keep a last seen time; per device first |
| Looks stuck | **Missing.** Needs a real signal, tested on real runs: same check failing twice, or no activity for long past that kind of run. Long test runs must not trigger it |
| Decisions apart from reports | **Partly.** `state: waiting` is a question; `review` + unread is "go read this". None of tonight's 8 in review were questions, so cards are for questions, the rest are rows under *Ready for review* |

## Build

Three PRs, each usable alone. `ci:full` not needed unless launch paths change.

1. **Home (M, built).** A page of its own beside New task, which stays as it was. They're two states of `#splitHome`: one prompt box, one set of tips and panes.
   Under the prompt: sentence, Needs you cards, Ready for review rows (finished and unread, open PRs), Working rows per task, Done today folded,
   a quiet line each for Coming up and usage; spare cards and panes keep working; tips, keys and feedback last.
   Live on the same state as the list. Opens at start side by side (a link to a task still wins; *Start on* setting)
   and from the wisp icon; New task and `N` open New task; Esc from a task goes to Home; stacked, the list stays first
   and the icon opens Home over it, with Back.
2. **Pieces of work (M).** Grouping by project and PR, then lineage; stable names, answers in place. Grouping by goal is later.
3. **Since you left and Looks stuck (M).** Last seen, unread results, the signal from decision 5, its tests.

Each PR: spell slots and parts (`view.today`, `today.needs`, `today.working`, `today.row`, `today.sentence`, a
`today.top` slot, setting `startOn`), a `qa/scenarios` entry, the design checklist in Chrome.

## Questions we settled

- **Home and New task are two pages** (owner, after the first mockup). Home is for seeing what's going on and
  starting work from there; New task stays the quiet page it is. Both have a prompt box and tips, one draft between them.
- **The sentence goes under the prompt, not in the greeting's place:** its length changes, and a prompt box that
  moves on a refresh breaks the stable layout rule.
- **Name:** Today is the design's name. On the page it's just home; it needs no label.
- **`--warn`, not `--bad`, for Looks stuck:** it's a guess by wisp, not a failure.
