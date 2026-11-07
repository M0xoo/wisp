## wisp-app.json

{ "name": "…", "description": "one line", "entry": "index.html", "uses": ["…"], "db": true }

name is what its bar shows; entry defaults to index.html; db: true gives it a SQLite database of its own ("db": "seed.sql" makes its tables from that file), which its pages use with import { sql } from '/_wisp/db.js'; once it's published, anyone with the link can read and change that data, so no personal data in it. uses lists what it needs from wisp, from this list and nothing else:

{scopes}

## Its page

<script src="/_wisp/pane.js"></script> gives it `wisp`. <link rel="stylesheet" href="/_wisp/pane.css"> gives it wisp's look: the tokens (var(--ink), var(--muted), var(--faint), var(--bg), var(--bg-2), var(--surface), var(--line), var(--line-2), var(--accent)), light and dark, following the user's theme, and .btn, .btn.primary, .card, .chip, .muted, .faint, .sk (a loading placeholder). Use them, and no colours of your own.

Every call returns a promise.

{calls}

- `wisp.context`: { where: "task" | "home", task: id | null, theme: "light" | "dark" }.
- `wisp.on('context', fn)`: fn(context) when it changes (another task opened, the theme).

Beside tasks, `context.task` is the open task: repaint when it changes.

## The rules it lives under

- A call the user hasn't allowed rejects. Nothing is allowed until they press Allow… on the pane's bar, so the first paint must make sense without access: catch the rejection and show its message.
- `tasks.launch` and `tasks.followUp` open wisp's own card with the exact text, and only the user's Send sends it. They can cancel, and only one card opens at a time. Handle the rejection every time and say so in the page: it is normal, not a crash. Never retry on your own.
- At most {writes} writes a minute from a pane, cancelled ones included; past that they reject. Show that error too.
- Changing any file of the app turns `tasks:write` off until the user allows it again; its bar says *Changed since allowed*, and read scopes stay. Say this in your answer when the pane has `tasks:write`, every time you update it.
- An app that uses wisp may only reach its own address. No external scripts, styles, fonts, images or fetch, so no CDN, whatever wisp_save says about CDNs: bundle everything into the folder. Frames are off.
- Links can't open anything: the frame has no popups and can't leave its own address. A link inside the app works; one to anywhere else fails. Show an address as text.
- There are at most {max} panes. It is one frame in a side panel about 400px wide, or a tile on home at least 300px wide and 420px tall that the user can resize, and a full page on phones: it must work narrow, and scroll inside itself.
