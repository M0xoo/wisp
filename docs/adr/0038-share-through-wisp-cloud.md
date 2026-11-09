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

## Edge cases (added 2026-11-09)

Each one is a test named after it.
- `a_share_goes_only_after_the_scrub`: what wisp Cloud receives is the scrubbed, signed bundle the preview showed.
- `a_share_must_be_signed_by_its_sharer`: the grid checks the ed25519 signature against the key it carries, and
  a new version of a share must be signed by the same key as its first (nobody else's key can update it).
- `share_access_anyone_people_teams_password`: anyone with the link; only the people named (signed in); only
  members of the teams named; or a password (kept as an scrypt hash, compared in constant time). A refused
  reader learns nothing about the share but that it's locked.
- `an_expired_or_revoked_link_is_gone`: both answer 410 with which, and nothing of the content.
- `views_and_imports_are_counted`: a page or a fetch counts a view, an import an import; the sharer's own
  reads don't count.
- `sharing_again_is_a_new_version`: the same key again makes version n+1 at the same link; a version only
  changes when the content does.
- `an_import_sees_update_available`: a receiver who imported version n sees "update available" (with the
  diff, as a plan) once the sharer publishes n+1, and applies it like any formula.
- `ref_pins_a_version`: `?ref=v1` (or a module `source: grid://…?ref=v1`) always answers that version.
- `a_share_page_works_without_wisp`: every kind (task, setup, doc) has an HTML page, every value escaped.
- `wisp_shares_lists_mine`: kind, access, views, imports and versions of each of my shares.
- `not_signed_in_offers_sign_in_or_a_file`: `--to cloud` signed out says how to sign in and offers `--to file`;
  nothing is uploaded.
