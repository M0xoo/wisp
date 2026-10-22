// One quick question to a cheap model, through whichever harness is installed: the scout and the
// judge use it. Read-only (plan mode), no wisp protocol, a hard time limit, and the reply's JSON.

import { adapters } from './adapters/index.js';

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

// Resolves with the parsed JSON object from the reply, or null (no harness, timeout, no JSON).
export function askJson({ agents, prompt, cwd, timeoutMs = 90_000, pick = cheapest(agents) }) {
  if (!pick || !adapters[pick.agent]) return Promise.resolve(null);
  return new Promise((resolve) => {
    let text = '';
    let handle;
    try {
      handle = adapters[pick.agent].run({
        prompt,
        cwd,
        mode: 'plan',
        model: pick.model,
        effort: '',
        systemPrompt: 'You are a helper inside wisp. Answer with one JSON object and nothing else.',
        attachments: [],
        onEvent: (e) => {
          if (e.type === 'result') text = e.isError ? '' : e.text || '';
        },
      });
    } catch {
      return resolve(null);
    }
    const timer = setTimeout(() => handle.stop(), timeoutMs);
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
