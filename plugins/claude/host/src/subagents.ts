// The subagent tally of one Claude Code process (see usage.ts for what the stream says and why the
// numbers are split this way). Pure: fed the stream's messages, asked once per result.

import { num, rec, str } from '@wisp/harness-kit';
import type { ModelTokens, SubagentRow } from './usage.ts';

interface Msg {
  model: string;
  read: number;
  output: number;
}
interface Call {
  type: string;
  model: string;
  msgs: Map<string, Msg>;
  total: { read: number; output: number } | null;
}
interface Part {
  c: Call;
  model: string;
  read: number;
  output: number;
  fixed?: boolean;
}

const n0 = (x: unknown): number => {
  const v = num(x);
  return v !== undefined && v > 0 ? v : 0;
};
const usageOf = (u: unknown): { read: number; output: number } => {
  const r = rec(u);
  return { read: n0(r['input_tokens']) + n0(r['cache_read_input_tokens']) + n0(r['cache_creation_input_tokens']), output: n0(r['output_tokens']) };
};

export interface SubagentTally {
  init(list: unknown): void;
  call(id: unknown, name: unknown, input: unknown): void;
  /** an assistant message: from inside a subagent (parent_tool_use_id), or the main thread's */
  message(msg: Record<string, unknown>): void;
  /** the Agent call's result; an older Claude Code put the subagent's usage on tool_use_result */
  result(id: unknown, toolUseResult: unknown): void;
  /** models: this result's modelsOf; mainOut: its usage.output_tokens. Clears the tally. */
  take(o?: { models?: ModelTokens[] | undefined; mainOut?: unknown }): SubagentRow[] | undefined;
}

export function subagentTally(): SubagentTally {
  const calls = new Map<string, Call>();
  let tools: unknown[] | null = null; // init's tools, when it sent them
  let main = ''; // the main thread's model, from its own messages
  return {
    init(list) {
      if (Array.isArray(list)) tools = list;
    },
    call(id, name, input) {
      const i = rec(input);
      if ((name === 'Agent' || name === 'Task') && typeof id === 'string' && id && !calls.has(id)) calls.set(id, { type: String(i['subagent_type'] || 'general-purpose'), model: i['model'] ? String(i['model']) : '', msgs: new Map(), total: null });
    },
    message(msg) {
      const m = rec(msg['message']);
      const parent = msg['parent_tool_use_id'];
      if (!parent) {
        if (m['model']) main = String(m['model']);
        return;
      }
      const c = typeof parent === 'string' ? calls.get(parent) : undefined;
      if (!c) return;
      if (m['model']) c.model = String(m['model']);
      if (!m['usage']) return;
      const key = typeof m['id'] === 'string' && m['id'] ? m['id'] : `#${c.msgs.size}`;
      const u = usageOf(m['usage']);
      const was = c.msgs.get(key);
      c.msgs.set(key, { model: c.model, read: Math.max(was?.read ?? 0, u.read), output: Math.max(was?.output ?? 0, u.output) });
    },
    result(id, toolUseResult) {
      const c = typeof id === 'string' ? calls.get(id) : undefined;
      if (!c) return;
      const r = rec(toolUseResult);
      if (r['resolvedModel'] && !c.model) c.model = String(r['resolvedModel']);
      const usage = r['usage'];
      if (usage && typeof usage === 'object' && num(rec(usage)['output_tokens']) !== undefined) c.total = usageOf(usage);
    },
    take({ models, mainOut = 0 } = {}) {
      if (!calls.size) return undefined;
      const parts = partsOf(calls);
      // None (modelUsage can't be split, see unsplit): the messages' snapshots aren't output either.
      if (!models) for (const p of parts) if (!p.fixed) p.output = 0;
      shareOutput(parts, models, main || models?.[0]?.model || '', n0(mainOut));
      calls.clear();
      return rowsOf(parts, main, tools !== null && !tools.includes('WebFetch'));
    },
  };
}

/** Per call and model: what its messages say. */
function partsOf(calls: Map<string, Call>): Part[] {
  const parts: Part[] = [];
  for (const c of calls.values()) {
    if (c.total) {
      parts.push({ c, model: c.model, ...c.total, fixed: true });
      continue;
    }
    const by = new Map<string, Part>();
    for (const m of c.msgs.values()) {
      const model = m.model || c.model;
      const e = by.get(model) ?? { c, model, read: 0, output: 0 };
      e.read += m.read;
      e.output += m.output;
      by.set(e.model, e);
    }
    if (!by.size) by.set(c.model, { c, model: c.model, read: 0, output: 0 });
    parts.push(...by.values());
  }
  return parts;
}

/** A model's output from modelUsage, past what the main thread and fixed totals account for. */
function shareOutput(parts: Part[], models: ModelTokens[] | undefined, mainModel: string, mainOut: number): void {
  for (const m of models ?? []) {
    const on = parts.filter((p) => p.model === m.model && !p.fixed);
    if (!on.length) continue;
    const pool = m.output - (m.model === mainModel ? mainOut : 0) - parts.filter((p) => p.model === m.model && p.fixed).reduce((a, p) => a + p.output, 0);
    const seen = on.reduce((a, p) => a + p.output, 0);
    if (!(pool > seen)) continue;
    for (const p of on) p.output = seen ? Math.round((pool * p.output) / seen) : Math.round(pool / on.length);
  }
}

function rowsOf(parts: Part[], main: string, noFetch: boolean): SubagentRow[] {
  const types = new Map<string, { type: string; ids: Set<Call>; models: Map<string, number>; read: number; output: number }>();
  for (const p of parts) {
    const e = types.get(p.c.type) ?? { type: p.c.type, ids: new Set<Call>(), models: new Map<string, number>(), read: 0, output: 0 };
    e.ids.add(p.c);
    e.read += p.read;
    e.output += p.output;
    if (p.model) e.models.set(p.model, (e.models.get(p.model) ?? 0) + p.output + 1);
    types.set(p.c.type, e);
  }
  return [...types.values()]
    .map((e): SubagentRow => {
      const model = str([...e.models].sort((a, b) => b[1] - a[1])[0]?.[0]);
      // same: on the main thread's model, as its own messages name it (the receipt offers Subagents on Haiku).
      return { type: e.type, calls: e.ids.size, read: e.read, output: e.output, model, ...(model && model === main && { same: true as const }), ...(noFetch && /^web[-_ ]?fetch/i.test(e.type) && { instead: 'WebFetch' as const }) };
    })
    .sort((a, b) => b.output - a.output || b.calls - a.calls);
}
