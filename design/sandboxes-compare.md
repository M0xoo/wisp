# Sandboxes: how wisp compares (Nov 2026)

What other products give an AI coding agent as its machine, and what wisp's sandboxes
(`design/sandboxes.md`, `grid/README.md` → Sandboxes) lack. Every cell cites a source `[n]`
(list at the end). **n/p** = not public: I found no first-party statement. Vendor speed claims
are the vendors' own numbers, not measured here.

## 1. Products × features

### Machine

| Product | Isolation | Start | Root / installs | Browser | Port previews | Persistence |
|---|---|---|---|---|---|---|
| **GitHub Codespaces** | a VM per codespace [1] | prebuilds cut it; n/p | your dev container decides; n/p | n/p (it's an IDE) | yes, port forwarding, private/org/public [3] | the codespace persists until deleted; prebuilds [4] |
| **Copilot coding agent** | Actions runner, Ubuntu x64 only [5] | n/p | yes; `copilot-setup-steps.yml` [5] | Playwright MCP by default, can reach localhost [5] | no (screenshots in the PR) [5] | `snapshot` key in setup steps [5] |
| **Devin** | a cloud VM per session [6] | n/p | yes [6] | built-in browser + Interactive Browser the user drives; VS Code on "Devin's machine" [7][8] | n/p | Machine Snapshots + saved browser login [7][8] |
| **Replit Agent** | n/p | n/p | n/p | App Testing: agent drives a real browser [9] | yes, the workspace webview [9] | checkpoints: files + agent context + DB, rollback [9] |
| **OpenAI Codex cloud** | a new container per task [10] | cached state up to 12 h [10] | yes; setup script [10] | not documented [10] | no | container cache, maintenance script on resume [10] |
| **Claude Code on the web** | gVisor container (third-party report) [11] | n/p | yes; setup script, cached [12] | n/p | no | setup result cached [12] |
| **Cursor cloud agents** | an isolated VM per agent [13] | "Builds" pre-warm envs [13] | yes; Dockerfile / snapshot / agent-led [13] | computer use: desktop + browser; user can take over the remote desktop [13] | n/p | saved environment snapshots, versioned [13][14] |
| **Google Jules** | short-lived VM per task, Ubuntu [15] | n/p | yes; setup script [15] | ChromeDriver installed [15]; "visualizes web app output" (third-party) [16] | no | "Run and Snapshot" per repo [15] |
| **E2B** (infra) | Firecracker microVM [17] | ~150 ms (third-party) [17] | default `user`, template sets user [18] | bring your own (desktop template) n/p | public `<port>-<id>` URLs n/p | pause/resume keeps memory + files, no TTL [19] |
| **Daytona** (infra) | containers + hardware-virtualized VM sandboxes [20] | <90 ms (vendor) [21] | n/p | n/p | authenticated / signed preview URLs per port [22] | snapshots, pause/resume, fork on VM sandboxes [20]; auto-stop 15 min [22] |
| **wisp** | gVisor container on your Grid; root only inside gVisor (a root helper behind `sudo`), wisp itself as uid 1000 | **23.7 s** cold, measured on the Hetzner grid (make + boot + project + start); progress shown while it starts | **yes**: `sudo apt-get` (what's installed comes back on the next start), `pip`/`npm -g` into the kept home; `.wisp/sandbox.sh` runs once | **yes**: Chromium the agent drives through the Browser connector (Playwright MCP over CDP), watched and usable live in the task's **Browser** tab (noVNC) | `p<port>--sb-<id>--<handle>`, framed in wisp | home + recorded packages kept until the task is deleted; idle stop + wake; per-turn checkpoints (Undo) from wisp; no memory snapshot |

### Control and money

| Product | Secrets / env | Egress control | Parallel | Your login | Pricing | Harness |
|---|---|---|---|---|---|---|
| **Codespaces** | user/org/repo Codespaces secrets [2] | n/p | many codespaces | GitHub account | core-hours (120/180 free on Free/Pro) + storage [4] | any (it's a VM) |
| **Copilot agent** | Actions secrets/variables in `copilot` env [5] | firewall: recommended + custom allowlist, org-level lock; Bash tool only, not MCP or setup steps [23] | one session per task | Copilot sub; Claude & Codex agents ride on it [24] | AI credits / premium requests + Actions minutes [24] | Copilot, Claude, Codex [24] |
| **Devin** | org and per-session secrets [8] | n/p | many sessions | Devin account | ACUs; plans restructured in 2026, sources disagree [25] | Devin only |
| **Replit** | Secrets pane; integrations without keys (third-party) [26] | n/p | n/p | Replit account | effort-based per checkpoint; Core ~$20–25/mo with credits [9][27] | Replit Agent only |
| **Codex cloud** | env vars for the run; secrets setup-only, removed before the agent phase [10] | off by default; None / Common deps / All + custom domains; GET/HEAD/OPTIONS only [28] | many cloud tasks | ChatGPT sign-in | in ChatGPT plans, shared 5-h window with CLI [29] | Codex only |
| **Claude Code web** | `.env` per environment [12] | None / Trusted (registries) / custom; GitHub via separate proxy [12] | n/p | Claude sub | in Claude plans n/p | Claude Code only |
| **Cursor** | team/workspace secrets, injected at start [13] | restrict outbound domains; Tailscale to private nets [13] | "as many as you want", each its own VM; subagents in own VMs [13][30] | Cursor account + connected Git host [13] | plan usage at model rates; not on Free/Plus [13] | Cursor only |
| **Jules** | n/p | n/p; network on (third-party) [16] | 3 concurrent free; 5×/20× on AI Pro/Ultra [31] | Google account | Google AI plans [31] | Jules only |
| **E2B** | you pass env at create n/p | on/off, `allowOut`/`denyOut` CIDR + domains, change live [32] | API, unlimited by plan | your API key | per second of vCPU+RAM; Pro $150/mo; Hobby 1 h sessions [33] | any (infra) |
| **Daytona** | n/p | block all / CIDR / domain allowlist; tier-gated [21] | API | your API key | per use n/p | any (infra) |
| **wisp** | **env vars** for every sandbox, sealed per user on the grid (names shown, never values) | none (Docker network; metadata and SMTP dropped by the grid's firewall) | 10 per user; **one sandbox per subagent** (place *Sandbox* in Delegate); crew members per job or one of their own | your Claude sub via sealed `claude setup-token` | $0 beyond subs and your server | v1: Claude only; image has all six |

## 2. What the best do that wisp doesn't

**Status on this branch** (built, tested, and checked on real gVisor on the Hetzner grid unless noted):
- Gap 1 (root): **closed**. `sudo apt-get install cowsay` works in a wisp-made sandbox; it's reinstalled when the box wakes.
- Gap 2 (browser + live view): **closed**. The agent's Browser connector drove Chromium to example.com over MCP; the task's Browser tab shows it live, desktop and phone, light and dark.
- Gap 3 (setup): **partly**. `.wisp/sandbox.sh` runs once per sandbox; no cached per-repo layer yet (gVisor keeps a container's root in its own overlay, so `docker commit` can't capture it).
- Gap 5 (secrets): **closed**. Settings → Cloud → Sandboxes → Env vars, sealed per user, given to every sandbox.
- Gap 8 (start): **measured** at 23.7 s cold (36 s to wake one and bring its browser up). Progress steps show while it starts; a warm pool is still to do.
- Gap 9 (parallel): **closed**. One sandbox per subagent and per crew job; 10 per user.
- Still open: 4 (network policy, needs an egress proxy in boxd), 6 (Codex sign-in in a sandbox), 7 (memory snapshots: `runsc checkpoint`).


Ranked by how often a user hits it.

1. **No root, so no `apt install`.** Every agent product lets the agent install system packages;
   wisp's sandbox is uid 1000 with `no-new-privileges`. *Fix:* in sandbox boxes only, run as root
   inside gVisor (it's the boundary) or ship passwordless `sudo` and drop `no-new-privileges`.
2. **No browser for the agent and no live view.** Cursor and Devin show a desktop you can take over,
   Copilot ships Playwright MCP, Replit tests in a real browser [5][7][9][13]. *Fix:* add Chromium +
   Playwright MCP to `deploy/image/Dockerfile`, and a noVNC desktop served as the `p6080` preview.
3. **No setup script or reusable environment.** Codex, Jules, Cursor, Devin, Copilot and Claude web
   run setup once and reuse the result [5][7][10][12][13][15]; wisp starts each sandbox cold.
   *Fix:* run `.wisp/sandbox.sh` on first seed, `docker commit` the result as a per-repo layer, start
   later sandboxes for that repo from it (rebuild when the script changes).
4. **No network policy.** Codex, Copilot, Claude web, E2B and Daytona default to or offer allowlists
   [12][21][23][28][32]; a wisp sandbox reaches the whole internet. *Fix:* per-sandbox
   `None / Packages / All` via an egress proxy boxd puts on the sandbox network.
5. **No secrets or env vars.** Everyone else injects them; Codex keeps secrets out of the agent
   phase [10]. *Fix:* Settings → Cloud → Sandboxes → Secrets, sealed per user like the token, given
   by `envFor`; a *setup only* flag drops them after `.wisp/sandbox.sh`.
6. **One harness.** "Any harness" is the pitch, but v1 refuses everything but Claude; Copilot already
   runs three agents on one sub [24]. *Fix:* seal a Codex login the same way via `codex login
   --device-auth` run inside each sandbox (still never copy `auth.json`).
7. **No snapshot or rollback.** Replit checkpoints files + context, E2B and Daytona pause with
   memory [9][19][20]. *Fix:* `runsc checkpoint/restore` for idle stop, and a git commit per turn in
   the sandbox so *Undo turn* works there.
8. **Slow, unreported start.** Infra products claim sub-200 ms [17][21]; wisp's is seconds and
   unmeasured. *Fix:* keep one warm sandbox per signed-in user and show the make/copy/start steps
   (open item 4 in `design/sandboxes.md`).
9. **Parallel caps.** Cursor runs unlimited agents, each in its own VM, subagents too [13][30];
   wisp allows 5 per user and subagent sandboxes are still proposed. *Fix:* ship the planned
   `machine: "sandbox"` delegate place, and make `perUser` follow `maxRunning`, not a fixed 5.

## 3. Where wisp is ahead

- **Cost and ownership.** Runs on your own Grid with your own Claude subscription: $0 extra, no
  per-second compute bill (E2B, Codespaces [4][33]), no ACUs or effort-based credits [9][25].
- **Not tied to a Git host.** The project goes in as a git bundle *with uncommitted changes*;
  Cursor needs a connected Git host, Codex and Jules check out a branch, Copilot works from a GitHub
  repo [5][10][13][15].
- **Previews for any port** at a stable name, which Codex, Copilot, Jules and Claude web don't offer.
- **Lifecycle is the task's.** Made with `/sandbox`, idles and wakes, deleted with the task: no
  dashboard of stray VMs to clean up.
- **Built for any harness.** The image already ships Claude Code, Codex, Cursor, Grok, Antigravity
  and opencode; only the agent products' own agent runs in theirs (Copilot is the exception, 3 agents).
- **Planned crew sandboxes** (per job or one of their own that wakes for a schedule) have no
  equivalent in the products above.
- **Self-hostable, open isolation** (gVisor now, Firecracker next): the only one here besides
  Daytona's and E2B's open-source runtimes you can run on your own box.

## Sources

1. https://docs.github.com/en/codespaces/reference/security-in-github-codespaces
2. https://docs.github.com/en/codespaces/managing-your-codespaces/managing-your-account-specific-secrets-for-github-codespaces
3. https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace
4. https://docs.github.com/en/billing/concepts/product-billing/github-codespaces
5. https://learn.microsoft.com/en-us/training/modules/github-copilot-code-agent/4-customize-extend-validate-copilot-code-agent
6. https://www.fast.io/resources/devin-session-tools-guide.md (third-party)
7. https://cognition.ai/blog/june-24-product-update
8. https://docs.devin.ai/work-with-devin/browser-auth.md
9. https://docs.replit.com/replitai/agent
10. https://learn.chatgpt.com/docs/environments/cloud-environment
11. https://zenn.dev/oikon/articles/claude-code-web-sandbox (third-party)
12. https://code.claude.com/docs/en/cloud-environments
13. https://cursor.com/docs/cloud-agent
14. https://cursor.com/changelog/cloud-in-agents-window
15. https://jules.google/docs/environment/
16. https://rywalker.com/research/jules (third-party)
17. https://rywalker.com/research/e2b (third-party)
18. https://e2b.dev/docs/template/user-and-workdir
19. https://www.morphllm.com/comparisons/e2b-vs-daytona (third-party, quoting E2B's persistence docs)
20. https://www.daytona.io/docs/en/isolation
21. https://www.developersdigest.tech/agent-sandboxes/daytona (third-party)
22. https://www.daytona.io/docs/en/v2/preview.md
23. https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall
24. https://docs.github.com/en/copilot/concepts/agents/about-third-party-coding-agents
25. https://oracore.dev/news/devin-pricing-june-2026-plans-limits-en (third-party; devin.ai/pricing is the authority)
26. https://dev.to/jovan_chan_9500711396d4e6/replit-agent-review-2026-from-idea-to-deployed-app-but-read-the-credit-bill-first-4cma (third-party)
27. https://www.softr.io/blog/replit-pricing (third-party)
28. https://developers.openai.com/codex/cloud/agent-internet
29. https://developers.openai.com/codex/pricing
30. https://releases.sh/release/rel_CIbpFGFEa_CKM1DtFcK1Z-cloud-environment-setup-in-under-10-minutes-subagents-run-in-own-vms
31. https://techcrunch.com/2025/08/06/googles-ai-coding-agent-jules-is-now-out-of-beta (Aug 2025 limits)
32. https://e2b.dev/docs/network/internet-access
33. https://docs.e2b.dev/faq/calculate-sandbox-price
