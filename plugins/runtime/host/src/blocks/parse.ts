// Reading an agent's answer back (v1 server/protocol.js parsePresentation): the last fenced `wisp`
// block's JSON, forgiving the slips models make (trailing commas, smart quotes, a stray quote in
// a terminal output, a lost closing brace), and plain markdown when there is none.

import type { Block, Presentation } from '../model.ts';

/** Bumped when the parser changes: a stored presentation from an older one is rebuilt lazily. */
export const PARSER_VERSION = 1;

// Only the opener is matched by regex. The closing fence can't be: the JSON itself often contains
// ``` (a markdown block with a code sample), and a lazy match would cut it there.
const OPEN = /```wisp[^\n]*\n/g;
const EMPTY = '_The agent finished without a message._';

type Parsed = unknown;

export function parsePresentation(text = ''): Presentation {
  const opens = [...text.matchAll(OPEN)];
  for (let i = opens.length - 1; i >= 0; i--) {
    const open = opens[i];
    if (!open) continue;
    const at = open.index ?? 0;
    const json = readJson(text.slice(at + open[0].length));
    const obj = isObj(json) ? json : null;
    const blocks = Array.isArray(json) ? json : obj?.['blocks'];
    // A top-level topic names the task when no hero does (runner finishTurn).
    const rawTopic = obj?.['topic'];
    const topic = typeof rawTopic === 'string' && rawTopic.trim() ? rawTopic.trim() : '';
    const extra = text.slice(0, at).trim();
    if (Array.isArray(blocks) && blocks.length) {
      const kept = blocks.filter((b): b is Block => isObj(b) && typeof b['type'] === 'string');
      return { blocks: kept, ...(extra && { notes: extra }), ...(topic && { topic }) };
    }
    // A quick answer: plain text, then a wisp block with only its topic. The text is the answer, as
    // it is (not a slip, so no fallback), and the block shows nothing.
    if (topic && (blocks === undefined || Array.isArray(blocks))) return { topic, blocks: [{ type: 'markdown', text: extra || EMPTY }] };
  }
  // The agent ignored (or broke) the protocol: its answer as plain markdown, with any broken wisp
  // payload kept verbatim in a fence rather than half-rendered as prose.
  const last = opens.at(-1);
  let md = text.trim();
  if (last) {
    const at = last.index ?? 0;
    const prose = text.slice(0, at).trim();
    const raw = text.slice(at + last[0].length).replace(/\n?```\s*$/, '');
    md = `${prose}\n\n\`\`\`\`\`json\n${raw}\n\`\`\`\`\``.trim();
  }
  return { fallback: true, blocks: [{ type: 'markdown', text: md || EMPTY }] };
}

export function heroOf(p: Presentation | null | undefined): Block | undefined {
  return p?.blocks?.find((b) => b.type === 'hero');
}

// The JSON value at the start of `src` (the body after a ```wisp opener). First its end by bracket
// matching, respecting strings; if that fails (a stray unescaped quote), every ``` after it as the
// closing fence; then block by block.
function readJson(src: string): Parsed {
  const end = jsonEnd(src);
  if (end > 0) {
    const json = tryJson(src.slice(0, end));
    if (json) return json;
  }
  for (let i = src.indexOf('```'); i !== -1; i = src.indexOf('```', i + 3)) {
    const json = tryJson(src.slice(0, i));
    if (json) return json;
  }
  return salvageBlocks(src);
}

// Last resort: the blocks array one element at a time, so one malformed block (an unescaped quote
// in a terminal output) costs that block rather than the whole answer.
function salvageBlocks(src: string): Parsed {
  const m = /^\s*(\{\s*"blocks"\s*:\s*)?\[/.exec(src);
  if (!m) return null;
  const blocks: unknown[] = [];
  let bad = 0;
  let i = m[0].length;
  while (i < src.length) {
    while (/[\s,]/.test(src[i] ?? '')) i++;
    if (src[i] !== '{') break;
    const len = jsonEnd(src.slice(i));
    if (len < 0) {
      // The last block is missing closing braces (a common slip after a long string): close it.
      const fixed = closeBraces(src.slice(i));
      if (fixed) blocks.push(fixed);
      else bad++;
      break;
    }
    // A bracket count that ends early on a `]` usually means a block lost a closing brace.
    const block = tryJson(src.slice(i, i + len)) ?? closeBraces(src.slice(i, i + len));
    if (block && typeof block === 'object') blocks.push(block);
    else bad++;
    i += len;
  }
  if (!blocks.length) return null;
  if (bad) blocks.push({ type: 'callout', tone: 'warn', title: `${bad} block${bad > 1 ? 's' : ''} skipped`, text: "Part of the agent's answer was malformed JSON and could not be shown." });
  return blocks;
}

// A block whose closing braces went missing at the end of the answer: cut it at each of its last
// few `}` and add up to three more until it parses. null when that doesn't help.
function closeBraces(src: string): Parsed {
  const body = src.replace(/```[\s\S]*$/, '').trimEnd();
  let cut = body.length;
  for (let tries = 0; tries < 6 && cut > 0; tries++) {
    cut = body.lastIndexOf('}', cut - 1);
    if (cut < 0) return null;
    for (let k = 1; k <= 3; k++) {
      const json = tryJson(body.slice(0, cut + 1) + '}'.repeat(k));
      if (isObj(json) && typeof json['type'] === 'string') return json;
    }
  }
  return null;
}

export function jsonEnd(src: string): number {
  const start = src.search(/\S/);
  if (src[start] !== '{' && src[start] !== '[') return -1;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      if (--depth === 0) return i + 1;
    }
  }
  return -1;
}

function tryJson(src: string): Parsed {
  try {
    return JSON.parse(src) as unknown;
  } catch {
    // Common LLM slips: trailing commas, smart quotes.
  }
  const relaxed = src.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"');
  try {
    return JSON.parse(relaxed) as unknown;
  } catch {
    return null;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
