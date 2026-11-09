# ADR-0038: Everything shareable can be shared through wisp Cloud in one click

- Status: accepted
- Date: 2026-11-09
- Source: the owner: "like apps, use the grid to host everything shareable, so sharing is super easy; users can
  always share files, but offer the easier option of sharing through wisp Cloud."
- With ADR-0027 (task sharing), 0034 (Share setup, modules), 0036 (apps), 0010 (peers).

## Decision

- **One Share, everywhere.** Tasks (spec, report or full), setups (a crew member, an agent, a workflow, a whole
  formula or module), My Stuff items, apps (as in v1), plugins and reports all use one **Share** action
  (`wisp share <address|id>`, `x.share()` in the SDK). Its default destination is **wisp Cloud** (your grid:
  grid.trywisp.dev, or a self-hosted grid), and **file, gist and git** stay one click away.
- **Not signed in?** Share offers "Share with wisp Cloud" with the one-click sign-in (GitHub or Google, the device
  flow from the CLI), or falls back to a file. Nothing is uploaded without the user choosing it.
- **What a share link gives:**
  - **a page that works without wisp:** a task's report and transcript, a setup's plan in plain words, a
    doc, a running app;
  - **Open in wisp** (`wisp://open/<id>`, or `wisp open <link>`), which goes straight to the import screen
    (ADR-0034) or the task's choices (ADR-0027);
  - **access:** anyone with the link (default), people or teams on the grid, or a password;
  - **expiry**, **revoke**, and a view and import count.
- **Live shares:** a shared setup or module is versioned. When the sharer updates it, everyone who imported it sees
  "update available" with the diff, and applies it like any formula. Pinning stays possible: a module `source:` on
  the grid takes `?ref=`.
- **My shares:** one page (app, TUI, `wisp shares`) lists everything you've shared, with its access, views, imports
  and versions. Change access, update or revoke from there.
- **Same privacy as everywhere:** the scrub preview (secrets, env values, private paths, unchosen names) always
  shows before upload. Personal kinds (accounts, UI) are never included. Secrets travel as `${secret:…}` only.
- **Storage:** grid shares live in the grid's shares store (v1 `grid/shares.js`, ported in `apps/grid`), signed by
  the sharer's peer key, so a receiver can verify where it came from. Self-hosted grids work the same way.

## Consequences

- grid-client gets one share API for every kind (upload, access, versions, revoke). The edge serves the share pages,
  rendered with the same kit as the app.
- The site's Track and Declare sections show "Share" leading to a link, with file as the alternative.
