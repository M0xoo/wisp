# v2 round, item 2: grid leftovers (ADR-0041, v2-grid-round.md "Not built")

## Built

**Sign-in with GitHub, Google and any OIDC issuer**
- Ported from v1 `grid/auth/providers.js` and `jwt.js`.
- `apps/grid/src/auth.rs` has the providers, the PKCE S256 challenge, and the state/nonce flows:
  - flows are kept in memory for 10 minutes, keyed by state, and each is used once;
  - the browser holds the state in a cookie, so a callback from another browser finds nothing.
- GitHub's identity is its numeric id, and only a verified email counts.
- ID tokens are checked: signature (RS256 via `rsa`, ES256 via `p256`, already dependencies), issuer, audience, nonce, expiry and `iat`. `alg: none` is refused.
- HTTP goes through `AuthHttp`, with reqwest in production.
- `Accounts::sign_in`:
  - an identity's link, or linking it to the signed-in user (refused if it belongs to someone else), or a new user;
  - never matched by email;
  - `auth.allow` (accounts, verified emails or domains, GitHub orgs), `auth.signup: closed`, disabled accounts;
  - a unique handle that avoids the reserved names.
- Routes (`apps/grid/src/edge_signin.rs`): `GET /signin`, `/auth/<id>/start[?link=1]`, `/auth/<id>/callback`. `/activate` sends you to `/signin`.

**boxd, the container driver** (`apps/grid/boxd`)
- Rust, std only, because it runs as root (ADR-0014). It has a small JSON reader.
- `check_run`: only the id, port, env, limits and DNS come from the grid. A sandbox is recognised only by the shape of its id.
- `container_run`:
  - gVisor, `--cap-drop ALL`, `no-new-privileges`, `--user 1000:1000`, a port on loopback only;
  - secrets go in a 0600 env file, never on the command line;
  - a sandbox runs as gVisor's root only under runsc.
- The socket server: `ping`, `remove`, and `run`, which streams `{log}` and then `{exit}`.
  - `{signal}` is taken on the run's connection;
  - when the grid hangs up, the box gets TERM, then a hard stop after 10 s.
- Also: `root_only_dir`, `migrate`, and `wisp-grid-boxd serve|migrate`.
- Grid side:
  - `apps/grid/src/boxd.rs`: `call` and `BoxdRun` (logs go to the box's `wisp.log`; dropping it stops the box);
  - hostd has two drivers, `process` and `container` (`ProcessOptions.boxd: Option<boxd::Driver>`), sharing one env builder.

**`wisp-grid serve`**: a real grid.
- It reads `grid.json` and `GRID_DATA`, and opens grid.db.
- It uses the configured providers, and hostd's driver from `hostd.driver` (`container` requires `hostd.container.boxd`).
- It stops every box on SIGTERM or Ctrl-C.

**Sandboxes as peers**
- `apps/grid/src/sandboxes.rs`:
  - create (a per-user cap; the label `sb-<id>--<handle>`) and list;
  - a bearer `wsb_<id>_<secret>`, compared in constant time, that opens that sandbox only;
  - the Claude sign-in and env vars, sealed per user (only their names are ever shown);
  - `env_for` (the owner's env, sign-ins and `WISP_SANDBOX=1`), which never goes into the user's own box.
- Edge: the `sb-…` address proxies to the sandbox's box through the same `proxy` as a user's own box, and `/api/sandboxes…` (`edge_sandboxes.rs`).
- Without a master key, sandboxes are off and say why.
- grid-client:
  - `grid-client.sandbox`, `.sandboxes` and `.sandboxRemove`;
  - a new sandbox becomes a `grid` machine holding its own token, never the device's.
- CLI: `wisp sandbox new [name] | ls | rm <id>`.

**Teams in the CLI**
- `grid-client.teams` (`ls`, `new`, `show`, `add`, `rm` over the grid's `/api/teams`).
- `wisp team ls | new <slug> [name] | show <slug> | add <slug> <handle> [role] | rm <slug> <handle>`.

**Tests, each run one at a time, all passing**
- auth (10):
  - `pkce_s256_matches_rfc_7636`;
  - `state_binds_the_callback_to_its_browser_once`;
  - `github_identity_is_the_numeric_id_and_a_verified_email`;
  - `id_token_signature_issuer_audience_nonce_and_expiry_are_checked`;
  - `github_sign_in_sends_state_and_pkce_and_reads_the_user`;
  - `sign_in_never_links_by_email`;
  - `allow_lists_by_account_verified_email_domain_and_org`;
  - `closed_signup_lets_existing_users_in_and_refuses_new_ones`;
  - `linking_someone_elses_identity_is_refused`;
  - `handles_are_unique_and_never_reserved`.
- Integration: `tests/signin.rs::github_sign_in_through_the_routes` (a fake GitHub, the real routes).
- boxd (6):
  - `json_round_trips_what_the_protocol_sends`;
  - `run_requests_take_only_what_boxd_allows`;
  - `container_run_locks_a_box_down`;
  - `a_run_streams_logs_and_exit_and_stops_when_the_grid_hangs_up` (a fake docker);
  - `ping_and_remove`;
  - `homes_move_once_and_never_through_a_link`.
- `tests/boxd_driver.rs::hostd_runs_a_box_through_boxd` (a fake boxd).
- `cli::serve_runs_boxes_through_boxd_when_the_config_says_container`.
- Sandboxes:
  - `a_sandboxs_token_opens_that_sandbox_only`;
  - `sandbox_sign_ins_and_env_are_sealed_and_only_named_back`;
  - grid-client's `a_sandbox_peer_is_found_by_its_sandbox_id` and `team_ops_are_the_grids_team_api`.

Clippy `-D warnings` is clean on wisp-grid, wisp-grid-boxd, wisp-grid-client(+api) and wisp. `npm run check` reports 0 errors.

## What's left

- **`wisp ssh <machine>`: not built.** A real SSH gateway needs an SSH server library, and a new dependency needs an ADR. The other way, a PTY over the box's own edge, needs streams routed through `machines.route`, which carries commands only today. Either one is a decision for the owner (see the question below).
- **The user image:** boxd runs `wisp serve --port N` in `wisp-grid-user`. The v2 image (with the Rust `wisp` on PATH) isn't built yet. `grid/deploy` still builds v1's.
- **Sandboxes from the cloud box:** a box's `Box` credential carries no user in v2's edge yet, so a box can't ask for sandboxes. v1 allowed it.
- **Sandbox sign-in UI and preview pages**, and **sites, inbox, mail and route**: still not ported. A sandbox's preview address answers 404.
- **Sign-in pages:** linking a second way in from the account page needs the account page itself, which comes with the GUI work.

**Question for the owner:** should `wisp ssh` be a real SSH gateway (a new `russh` dependency and an ADR), or a shell over the box's own wisp (a new routed stream in machines)?
