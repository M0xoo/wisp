// One quick question to a cheap model, through whichever harness is installed: the scout and the
// judge use it. Read-only (plan mode), no wisp protocol, a hard time limit, and the reply's JSON.

import { sideEnv } from './accounts.js';
import { adapters } from './adapters/index.js';
import { leanOn } from './lean.js';

// Cheapest first: what the scout and judge run on when it's installed.
const CHEAP = [
  ['claude', 'haiku'],
  ['antigravity', 'gemini-3.8-flash-low'],
  ['codex', ''],
  ['opencode', ''],
  ['grok', ''],
  ['copilot', 'gpt-5-mini'],
  ['claude', ''],
];

export function cheapest(agents) {
  for (const [id, model] of CHEAP) {
    const a = agents.find((x) => x.id === id && x.available);
    if (a && (!model || (a.models || []).some((m) => m.id === model))) return { agent: id, model };
  }
  return null;
}

// pick: { agent, model, effort? }. Resolves with the parsed JSON object from the reply, or null (no harness, timeout, no JSON).
// onEvent(e): every event of the run as the harness sends it, plus { type: 'timeout' } when the time
// limit stops it; for who keeps a record of the run (server/goal-runs.js). It can't break the run.
export function askJson({ agents, prompt, cwd, timeoutMs = 90_000, pick = cheapest(agents), onEvent }) {
  if (!pick || !adapters[pick.agent]) return Promise.resolve(null);
  const tell = (e) => {
    try {
      onEvent?.(e);
    } catch (err) {
      console.warn(`wisp: recording a side run: ${err.message}`);
    }
  };
  return new Promise((resolve) => {
    let text = '';
    let handle;
    try {
      handle = adapters[pick.agent].run({
        prompt,
        cwd,
        mode: 'plan',
        model: pick.model,
        effort: pick.effort || '',
        systemPrompt: 'You are a helper inside wisp. Answer with one JSON object and nothing else.',
        accountEnv: sideEnv(pick.agent),
        untrusted: true, // a JSON answer needs nothing from the folder (server/project-trust.js)
        quiet: leanOn(), // a JSON answer loses nothing without nonessential traffic (server/lean.js)
        attachments: [],
        onEvent: (e) => {
          if (e.type === 'result') text = e.isError ? '' : e.text || '';
          tell(e);
        },
      });
    } catch (err) {
      tell({ type: 'result', isError: true, text: err.message });
      return resolve(null);
    }
    const timer = setTimeout(() => {
      tell({ type: 'timeout', ms: timeoutMs });
      handle.stop();
    }, timeoutMs);
    handle.done.then(() => {
      clearTimeout(timer);
      resolve(readJson(text));
    });
  });
}

export function readJson(text = '') {
  const s = String(text);
  for (let i = s.indexOf('{'); i >= 0; i = s.indexOf('{', i + 1)) {
    let depth = 0;
    let inStr = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && !--depth) {
        try {
          return JSON.parse(s.slice(i, j + 1));
        } catch {
          break;
        }
      }
    }
  }
  return null;
}
