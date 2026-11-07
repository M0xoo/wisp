// `claude -p --output-format stream-json`, line by line (v1 adapters/claude.js onJson + onClose), as a
// sans-IO machine: stream-json in, HarnessEvents out. The only IO it asks for is a Write's "before"
// (describe.ts captureChange), through an IoStep the driver runs in place.

import { exitText, flatten, rec, str, type Exit, type LineParser, type Out, type RunPaths } from '@wisp/harness-kit';
import type { HarnessEvent } from '@wisp-plugin/runtime-api';
import { claudeLimits } from './limits.ts';
import { captureChange, describeTool, detailOf, ruleOf } from './describe.ts';
import { finalResult, resultEvent, type Result } from './result.ts';
import { asCounted, countedFrom, costSince, modelsOf, modelUsageOf, subagentTally, type Counted } from './usage.ts';

export interface ClaudeParserOptions {
  paths: RunPaths;
  /** the last turn's stats.totals, on --resume */
  prior?: unknown;
  unknownPrior?: boolean;
  /** whether a run's text says Claude Code is signed out (the login's authFailed words) */
  signedOut(text: string): boolean;
}

type Msg = Record<string, unknown>;

/** What one turn of a process has seen so far; reset by each result it reports. */
interface TurnState {
  contextTokens: number;
  cacheTtlMs: number; // 0: unknown
  compacted: boolean; // a /compact with no main-thread request since: the size is gone, and says 0
  boundary: Msg | null; // the last compact_boundary's compact_metadata, until a result takes it
  unshrunk: { error: string } | null; // a status that says compacting failed, until a boundary says it worked
}

export function claudeParser(o: ClaudeParserOptions): LineParser<HarnessEvent> {
  const { paths } = o;
  const prior: Counted | null = asCounted(o.prior);
  let sawResult = false;
  const subagents = subagentTally();
  let lastModels: unknown = null; // the last result's modelUsage (it adds up over the process)
  let counted: Counted | null | undefined; // the counters this process started from, once its first result says
  let unsplit = false; // the next result's modelUsage can't be told from the conversation's
  // This turn's last main-thread message ended with stop_reason "refusal". Per turn, not per process:
  // a refusal the CLI retried past can still end in success, and a background task starts a turn.
  let refused = false;
  let authFailed = ''; // the words of an assistant message with error: 'authentication_failed'
  let early: Result | null = null; // an empty result that came before our prompt was answered
  const pendingTools = new Map<string, string>(); // tool_use_id -> name, to name failed results
  // Background tasks still running: while any are, the CLI stays up after its result.
  let background = new Map<string, string>(); // task_id -> description
  const turn: TurnState = { contextTokens: 0, cacheTtlMs: 0, compacted: false, boundary: null, unshrunk: null };

  const setBackground = (next: Map<string, string>, out: Out<HarnessEvent>[]): void => {
    const was = [...background.keys()].join(' ');
    background = next;
    if ([...next.keys()].join(' ') !== was) out.push({ type: 'background', tasks: [...next.values()] });
  };

  // The main thread's last request: what a reply reads back if the cache lapses. result.usage can't
  // say: it sums every request of the turn. Each message's usage is one request.
  const noteContext = (msg: Msg): void => {
    const u = rec(rec(msg['message'])['usage']);
    if (!rec(msg['message'])['usage'] || msg['parent_tool_use_id']) return; // a subagent's context is its own
    const size = (Number(u['input_tokens']) || 0) + (Number(u['cache_read_input_tokens']) || 0) + (Number(u['cache_creation_input_tokens']) || 0);
    if (size) [turn.contextTokens, turn.compacted] = [size, false]; // 0: a <synthetic> message
    // The TTL the provider wrote with, read from the latest message that wrote any. Both: unknown.
    const cc = rec(u['cache_creation']);
    const h1 = cc['ephemeral_1h_input_tokens'];
    const m5 = cc['ephemeral_5m_input_tokens'];
    if (h1 || m5) turn.cacheTtlMs = h1 && m5 ? 0 : h1 ? 3_600_000 : 300_000;
  };

  const assistant = (msg: Msg, out: Out<HarnessEvent>[]): void => {
    subagents.message(msg);
    noteContext(msg);
    const m = rec(msg['message']);
    const stop = m['stop_reason'];
    if (stop && !msg['parent_tool_use_id']) refused = stop === 'refusal'; // a subagent's refusal isn't the turn's
    if (msg['error'] === 'authentication_failed' && !msg['parent_tool_use_id']) authFailed = flatten(m['content'] ?? []) || 'authentication_failed';
    for (const p of Array.isArray(m['content']) ? m['content'] : []) {
      const part = rec(p);
      if (part['type'] === 'text' && str(part['text']).trim()) out.push({ type: 'text', text: str(part['text']) });
      else if (part['type'] === 'thinking') out.push({ type: 'thinking', ...(part['thinking'] ? { text: str(part['thinking']) } : {}) });
      else if (part['type'] === 'tool_use') {
        const id = str(part['id']);
        const name = str(part['name']);
        const input = rec(part['input']);
        pendingTools.set(id, name);
        subagents.call(id, name, input);
        out.push({ type: 'tool', id, ...describeTool(name, input, paths) });
        // Streamed before the call runs, and before any permission prompt for it (early).
        const change = captureChange(name, input, paths);
        if (change) out.push(change);
      }
    }
  };

  const user = (msg: Msg, out: Out<HarnessEvent>[]): void => {
    for (const p of Array.isArray(rec(msg['message'])['content']) ? (rec(msg['message'])['content'] as unknown[]) : []) {
      const part = rec(p);
      if (part['type'] !== 'tool_result') continue;
      const id = str(part['tool_use_id']);
      subagents.result(id, msg['tool_use_result']);
      if (part['is_error']) out.push({ type: 'tool_error', id, name: pendingTools.get(id) as string, text: flatten(part['content']).slice(0, 400) });
      else out.push({ type: 'tool_output', id, text: flatten(part['content']) });
    }
  };

  const system = (msg: Msg, out: Out<HarnessEvent>[]): void => {
    if (msg['subtype'] === 'init') {
      // Signed in with an API key (ANTHROPIC_API_KEY, apiKeyHelper…): billed as API credit, not the
      // plan. `none` is the plan or a Console profile: consoleProfile() tells those apart.
      const source = msg['apiKeySource'];
      if (source && !/^(?:none|oauth)$/i.test(str(source))) out.push({ type: 'billing', kind: 'api' });
      // The tools this run had: two accounts of the same harness can differ (one's settings deny WebFetch).
      if (Array.isArray(msg['tools'])) out.push({ type: 'tools', list: msg['tools'] as string[] });
      if (msg['claude_code_version']) out.push({ type: 'cli', version: String(msg['claude_code_version']) });
      subagents.init(msg['tools']);
      return;
    }
    if (msg['subtype'] === 'compact_boundary') [turn.contextTokens, turn.compacted, turn.boundary, turn.unshrunk] = [0, true, rec(msg['compact_metadata']), null];
    if (msg['subtype'] === 'status' && msg['compact_result']) turn.unshrunk = msg['compact_result'] === 'success' ? null : { error: String(msg['compact_error'] || msg['error'] || '').trim() };
    // A subagent started (claude 2.1.316 runs Agent calls in the background): its type.
    if (msg['subtype'] === 'task_started' && msg['task_type'] === 'local_agent' && msg['tool_use_id']) subagents.call(msg['tool_use_id'], 'Agent', { subagent_type: msg['subagent_type'] });
    // background_tasks_changed carries the full list; task_started/task_notification are the per-task
    // edges, kept as a fallback in case a CLI version only sends those.
    if (msg['subtype'] === 'background_tasks_changed' && Array.isArray(msg['tasks'])) {
      setBackground(new Map((msg['tasks'] as unknown[]).map(rec).map((t) => [str(t['task_id']), str(t['description']) || 'Background task'])), out);
    } else if (msg['subtype'] === 'task_started' && msg['is_backgrounded'] && msg['task_id']) {
      setBackground(new Map(background).set(str(msg['task_id']), str(msg['description']) || 'Background task'), out);
    } else if (msg['subtype'] === 'task_notification' && background.has(str(msg['task_id']))) {
      const next = new Map(background);
      next.delete(str(msg['task_id']));
      setBackground(next, out);
    }
  };

  const result = (msg: Msg, out: Out<HarnessEvent>[]): void => {
    const ev = resultEvent(msg, authFailed, o.signedOut);
    if (counted === undefined) {
      counted = countedFrom(msg, prior, o.unknownPrior);
      lastModels = modelUsageOf(counted?.models) ?? null;
      // Restored, from a turn that left no models: this modelUsage is the whole conversation with
      // nothing to take off. It's still the baseline for the next result and the next run.
      unsplit = !!counted && !counted.models?.length;
    }
    if (counted) ev.stats.costUsd = costSince(msg, counted);
    if (counted && counted !== prior && !ev.stats.costUsd) ev.stats['baseline'] = true; // no measure of this run
    // What the next --resume starts from. Its presence says stats.models is this turn's alone.
    ev.stats['totals'] = { costUsd: msg['total_cost_usd'], models: modelsOf(msg['modelUsage']) };
    const verdict = finalResult(ev, msg, turn);
    if (verdict === 'early') {
      early = ev;
      return;
    }
    sawResult = true;
    // modelUsage adds up over the process: this result's part is what's new since the last.
    const models = unsplit ? undefined : modelsOf(msg['modelUsage'], lastModels);
    unsplit = false;
    if (msg['modelUsage']) lastModels = msg['modelUsage'];
    if (models) ev.stats['models'] = models;
    const subs = subagents.take({ models, mainOut: rec(msg['usage'])['output_tokens'] });
    if (subs) ev.stats['subagents'] = subs;
    // Refused tool calls (no approve tool here, or the user said no): the card offers a retry.
    for (const d of Array.isArray(msg['permission_denials']) ? (msg['permission_denials'] as unknown[]).map(rec) : []) {
      const input = rec(d['tool_input']);
      const tool = str(d['tool_name']);
      out.push({ type: 'blocked', tool, detail: detailOf(tool, input, paths), rule: ruleOf(tool, input) });
    }
    if (refused && !msg['stop_reason']) ev.stopReason = 'refusal'; // the result's own stop_reason, when it has one, says
    refused = false;
    out.push({ ...ev, background: background.size }); // > 0: another turn and result follow when they finish
  };

  return {
    line(raw) {
      const msg = rec(raw);
      const out: Out<HarnessEvent>[] = [];
      if (msg['session_id']) out.push({ type: 'session', id: str(msg['session_id']) });
      const type = msg['type'];
      if (type === 'assistant') assistant(msg, out);
      else if (type === 'user') user(msg, out);
      else if (type === 'rate_limit_event') {
        // How much of the account's 5-hour and weekly windows is gone (Settings → Usage, the limit card).
        const limits = claudeLimits(msg['rate_limit_info']);
        if (limits) out.push({ type: 'limits', ...limits });
      } else if (type === 'system') system(msg, out);
      else if (type === 'result') result(msg, out);
      return out;
    },
    close(exit: Exit) {
      if (sawResult) return [];
      if (early && !exit.stopRequested) return [early];
      return [{ type: 'result', isError: true, stopped: exit.stopped, text: exit.stderr || exitText('claude', exit.code, exit.signal) }];
    },
  };
}
