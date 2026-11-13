# ADR-0052: A crew is shared through wisp.share as a link, not a gist; a member's own agent may propose kit files

- Status: accepted
- Date: 2026-11-13
- Source: the lead, for F-crew-12 (`docs/v1-features.md`): "v1 made a GitHub gist; v2 shares a crew the way it shares
  everything else". With ADR-0038 (one Share for every kind, through wisp Cloud), ADR-0041 (the grid is the hub),
  ADR-0008 (capability sets), ADR-0040 (meet users where they work).

## Context

v1's Share… on a crew member offered a `.crew.json` file or a secret GitHub gist (`gh gist create`, the user's GitHub
token). v2 already shares tasks, setups and apps through wisp.share (`share.send`, `share.destination@1`, wisp Cloud
links with access, expiry, revoke, view and import counts); the crew still had only the file (Download, Copy), and its
import refused any link (no egress for gists). Separately, round 2026-11-13 added `crew:propose` (`crew.agent.kit`,
the `wisp_crew_kit` tool) without recording why it is its own permission.

## Decision

- **A crew share is a wisp.share `crew` kind.** `crew.share { ids, kit?, notebook?, team?, password?, expiresAt? }`
  (permission `crew:share`) builds `crew.export`'s bundle and sends it with `share.send { kind: "crew", content, key }`
  to the first ready destination (wisp Cloud). One Share, the same link page, access, expiry, revoke and My shares as
  every other kind. No GitHub token is involved. `key` is `crew` for the whole crew and `crew:<ids>` for some members,
  so sharing the same members again is a new version of the same link (ADR-0038).
- **What goes is the export's bundle and nothing else:** each member's card (name, role, face, brief, schedule, what
  starts them, mode, harness), their kits and the delegates ticked. Never their project, computer, sandbox, log, queue,
  jobs or offers. **Notebooks are optional and off by default** (they hold what a member learned about the sharer's
  code). The secret scan refuses the share outright, before a destination is asked, as it refuses the file.
- **Import takes a link.** `crew.import { url }` reads:
  - a share link (`https://<grid>/s/<id>`, `wisp://open/<id>`, `grid://<handle>/<name>`) through `grid-client.fetch`,
    refused unless the signature holds and the share is a crew. A successful import is counted (`grid-client.imported`)
    so the receiver sees "update available";
  - **v1's gist links still** (`gist:<id>`, a gist.github.com page): `GET api.github.com/gists/<id>` without a token
    (a secret gist is readable by its id), its `*.crew.json` file;
  - any other https `.crew.json`.
  Everything fetched is then imported like a pasted file (review, all or none, paused). The `wisp_crew_add` tool's
  `from` names the same sources.
- **The crew host gets HTTP egress for that read only** (`reqwest`, already pinned in the root `Cargo.toml` for
  grid-client, posthog, machines and channels): one GET, a 15 s timeout, no redirects, a 1 MB cap read as it streams,
  and never a host on this computer or a private network (loopback, private, link-local, CGNAT, `.local`), so a
  pasted link or an agent's `from` can't make wisp reach inside the network. The kernel has no shared fetch
  service; one belongs in its own ADR when a second plugin needs a generic GET.
- **Reach (ADR-0040):** the app (the Share dialog's Share link, ⌘K *Share your crew…* and *Import crew members…*, the
  member page's ⋯ → *Share your crew…*), MCP (`crew.share` is in the catalogue, `wisp_crew_add { from }`), the CLI
  (`wisp share`, `wisp open` on the link).
- **`crew:share` and `crew:propose` are their own permissions.** `agent:session` allows `crew:*`. The `crew:<name>`
  set (a member's own job) denies `crew:write` and now `crew:share`: a member can't change or publish the crew it
  belongs to. It keeps `crew:propose`: `crew.agent.kit` only *proposes* files (an offer under the answer, nothing
  changes until the user picks), so a member's agent may build its own kit. A capped task (a channel's mode cap) is
  refused `crew:share`, like `stuff:publish`.

## Consequences

- `ExportArgs.gist` is refused with a pointer to `crew.share`. The file path (Download, Copy) stays.
- The share page for a `crew` kind renders the setup's plan in plain words like other setups (ADR-0038); until the grid
  has a crew renderer it shows the generic card (title, summary: each member's name and role).
- A locked (password) link answers that it's locked; the Import dialog has no password box yet.

## Edge cases

Each one is a test named after it.
- `a_crew_share_bundle_has_no_secrets`: no project path, computer, log or queue in what goes; the notebook only when
  ticked; a key in a kit refuses the share; the whole crew is one `crew` key, a pick is `crew:<ids>`; a password makes a
  password share (`plugins/crew/host/src/shared.rs`).
- `a_share_link_imports_the_members`: a crew share's content imports its members, paused, the sharer's project left
  behind (`shared.rs`).
- `a_gist_link_still_imports`: `gist:<id>` and a gist page name the gist, the API's `*.crew.json` file is found and its
  members import (`shared.rs`).
- `a_pasted_link_names_a_share_a_gist_or_a_file`: share links (https, a self-hosted grid over http, `wisp://open/`),
  gists, https files; plain http only for a share page (`<origin>/s/<id>`, nothing deeper); loopback, private and
  link-local hosts refused; `gist:../etc` and other schemes are refused
  (`plugins/crew/core/src/source.rs`).
- `a_gist_s_crew_file_is_found_among_its_files`: the first `*.crew.json`, a truncated file refused (`source.rs`).
- `a_share_of_another_kind_is_not_a_crew`: a task share's link is refused by the crew import; a body over 1 MB is
  refused (`source.rs`).
- `families_and_plugins`: a member's own set is refused `crew:share` and allowed `crew:propose`
  (`crates/wisp-kernel/src/caps.rs`).
- Signed out: `crew.share` says how to sign in and offers Download (the destination's own reason); the bundle's secret
  check runs first, so a secret is refused even signed out.
