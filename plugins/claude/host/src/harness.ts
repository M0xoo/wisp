// Claude Code as a Harness (`runtime.harness@1`): drives `claude -p --output-format stream-json`.
// The port of v1 server/adapters/claude.js; the stream parser is parser.ts, the command line args.ts.

import type { ProcService } from '@wisp/kernel';
import { detectFirst, drive, helpEfforts, helpText, rec, versionTriple } from '@wisp/harness-kit';
import type { Harness, HarnessEvent, HarnessFound, HarnessRun, Mode } from '@wisp-plugin/runtime-api';
import { APPROVE_TOOL, claudeArgs, resumeArgv } from './args.ts';
import { chromeEnabled, fallbackBins, hasSession, latestSession, profileCache, trustFolder } from './config.ts';
import { actionOf, detailOf } from './describe.ts';
import { claudeParser } from './parser.ts';

type Env = Record<string, string | undefined>;

export interface ClaudeDeps {
  proc: ProcService;
  /** wisp's own environment (process.env on a real install; tests pass their own) */
  env: () => Env;
  now: () => number;
  /** whether a run's text says Claude Code is signed out (its login's authFailed words) */
  signedOut(text: string): boolean;
  platform?: string;
}

/**
 * Where the CLI runs another model than --model says. Seen on claude 2.1.318 from modelUsage: `--model
 * haiku --permission-mode plan` runs claude-sonnet-5-5, `--model claude-haiku-5-5` with it stays on
 * Haiku, and Haiku with edits is Haiku. So the alias only, and only in plan.
 */
const MODEL_OVERRIDES = [{ model: 'haiku', mode: 'plan', label: 'Sonnet', note: 'Plan runs on Sonnet here, not Haiku: the Claude CLI picks it.' }];

export function createClaude(deps: ClaudeDeps): Harness {
  const pinned = deps.env()['WISP_CLAUDE_BIN'];
  const defaultBin = pinned || 'claude';
  let bin = defaultBin; // the one detect() found
  let version: number[] = []; // [major, minor, patch] of that claude
  const profiles = profileCache(deps.proc, () => bin);

  const run = (o: HarnessRun) =>
    drive<HarnessEvent>(
      async () => {
        const base = deps.env();
        const chrome = await chromeEnabled({ ...base, ...o.accountEnv });
        const { args, input, env, lean } = claudeArgs(o, { version, chrome, baseEnv: base });
        // Started before the run and never awaited: a Console profile is a notice (Past your plan), never a hold.
        if (o.probe && !lean) profiles.profile(env, deps.now()).then((p) => p && o.onEvent({ type: 'billing', kind: 'profile' })).catch(() => {});
        return {
          proc: deps.proc, bin, args, cwd: o.cwd, env, input, signal: o.signal, now: deps.now, onEvent: o.onEvent,
          parser: (paths) => claudeParser({ paths, prior: o.prior, unknownPrior: !!o.unknownPrior, signedOut: deps.signedOut }),
          failed: (text) => ({ type: 'result', isError: true, text }),
        };
      },
      { onEvent: o.onEvent, failed: (text) => ({ type: 'result', isError: true, text }) },
    );

  return {
    id: 'claude',
    name: 'Claude Code',
    reportsCli: true, // says its own version per run: `cli` events, no version from detect
    bin: () => bin,
    // Asks wisp before a tool call its permission mode won't allow on its own (Edits mode).
    approveTool: APPROVE_TOOL,
    askTool: 'mcp__wisp__ask_user',
    sideGate: true, // a side discussion can change the work: wisp hears of every write first
    fork: true, // run({ resumeId, fork }) answers on a copy of the conversation (/btw)
    sessionIds: true, // resumeCommand({ sessionId }) picks the new conversation's id
    models: [
      { id: '', label: 'Default', hint: 'Whatever Claude Code is set to' },
      { id: 'opus', label: 'Opus', hint: 'Most capable, for hard problems' },
      { id: 'sonnet', label: 'Sonnet', hint: 'Fast and smart, everyday work' },
      { id: 'haiku', label: 'Haiku', hint: 'Fastest, for quick tasks' },
    ],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    modelOverride({ model, mode }: { model: string; mode: Mode }) {
      const o = MODEL_OVERRIDES.find((x) => x.model === model && x.mode === mode);
      return o ? { label: o.label, note: o.note } : null;
    },
    resumeCommand: (o) => ({ argv: resumeArgv(bin, o) }),
    hasSession: (id, cwd, env) => hasSession(id, cwd, env ?? deps.env()),
    latestSession: (cwd, env) => latestSession(cwd, env ?? deps.env()),
    trust: (dir) => trustFolder(dir, deps.env()),
    // How to get it, shown in Settings → Agents and the picker while it isn't found (this OS's steps).
    setup(platform = deps.platform ?? process.platform) {
      return {
        tip: platform === 'linux' ? 'Install Claude Code, then run claude once to sign in' : 'Install Claude Code and run claude once to sign in. Or open the Claude app’s Code tab once: wisp uses the copy it downloads',
        command: platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
        url: 'https://claude.com/claude-code',
      };
    },
    async detect(): Promise<HarnessFound> {
      const { bin: found, ...said } = await detectFirst(deps.proc, defaultBin, () => fallbackBins(deps.env(), undefined, deps.platform), !!pinned);
      bin = found;
      version = versionTriple(said.version);
      if (!said.available) return said;
      const efforts = helpEfforts(await helpText(deps.proc, bin));
      return efforts.length ? { ...said, efforts } : said;
    },
    // What a permission prompt is about, for the approval card and for matching "always allow".
    permission(tool, input, cwd) {
      const i = rec(input);
      return { tool, action: actionOf(tool, i, cwd), detail: detailOf(tool, i, cwd), why: tool === 'Bash' ? String(i['description'] || '') : '' };
    },
    run,
  };
}
