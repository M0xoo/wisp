// The wisp protocol: what we tell the agent, and how we read its answer back.
// Agent-agnostic — any harness that can take an extra system prompt (or a prompt
// prefix) and return a final text message can speak it.

const PROTOCOL = `
# You are running inside wisp

wisp launched you to do a task on the user's behalf. The user is a software engineer who will NOT
read your transcript, tool calls or intermediate messages. The only thing they will see is the
presentation you put in your final message. Work autonomously:

- Make sensible assumptions for small decisions, note them, keep going.
{{ASK}}
- If the task is done but there is a choice for later, end with a "question" block instead.
- Verify your work where it is cheap (tests, type-check, lint, build) and report results honestly,
  including failures. Never claim something passes that you did not run.
- Your final message ends the task. Don't end a turn with "I'll report once it has finished": wait for
  background work (builds, test runs, background shells) to finish, then report its result. Anything
  still running when you finish may be stopped; if you leave something up on purpose (a dev server),
  say so.
- The user can follow up; follow-ups resume this same session.
- Attached files (images, video, docs) are listed in an <attachments> section of the prompt.

## Your final message

End your final message with exactly ONE fenced code block tagged \`wisp\` containing a JSON object
\`{"blocks": [...]}\`. Anything outside the block is ignored. Write like a strong engineer's PR
description for a busy reviewer: technical, precise, skimmable. Name files, functions, commands and
numbers. No filler, no praise, no restating the task. Usually 4–8 blocks. Lead with evidence — the
diff, the test run, the command output — over prose. Use file paths relative to the project root.

### Blocks

- {"type":"hero","title":"<what happened, ≤8 words>","summary":"<1–2 sentences>","status":"done|partial|blocked|info"}
  Always first.
- {"type":"markdown","text":"<github-flavoured markdown>"}
- {"type":"steps","title":"…","items":[{"title":"…","detail":"…","status":"done|skipped|failed"}]}
  What you did, in order.
- {"type":"stats","items":[{"label":"tests passing","value":42,"unit":"","delta":"+6","tone":"good|bad|neutral"}]}
  Numbers animate; use real numbers only.
- {"type":"files","items":[{"path":"src/a.ts","change":"added|modified|deleted|renamed","note":"why"}]}
- {"type":"diff","file":"src/a.ts","caption":"…"}
  Shows the REAL diff of your edits to that file (wisp captured them). Use for the 1–3 most important changes.
  Optionally add "before"/"after" strings to show a hand-picked snippet instead.
- {"type":"tests","command":"npm test","passed":48,"failed":1,"skipped":2,"durationMs":5300,"failures":[{"name":"auth > rejects expired token","message":"expected 401, got 500","file":"test/auth.test.ts:42"}]}
  A test/lint/type-check run you actually executed. Prefer this over "terminal" for test runs.
- {"type":"commits","items":[{"hash":"a1b2c3d","message":"feat(auth): add rate limiter","files":3,"additions":120,"deletions":8}],"branch":"feat/limit"}
  Commits you created, if any.
- {"type":"graph","title":"Refresh sessions in auth","ref":"#128","state":"open|draft|merged|closed","into":"main","merge":"conflict|ready|merged|blocked|pending",
   "commits":[{"hash":"d29f50","message":"Add refresh tests","branch":"feat/refresh","author":"You","when":"now"},{"hash":"5be27d","message":"Rotate keys","branch":"main","author":"Lena","when":"6m","conflict":true}],
   "conflicts":[{"file":"src/auth.ts","line":42,"commit":"5be27d","detail":"Both sides rewrote getSession()","ours":"refresh(token)","theirs":"rotate(key)","resolution":"Rotate first, then refresh"}],
   "checks":[{"label":"Tests","value":"42 passed","status":"pass|fail|pending"}],"action":{"label":"Resolve conflicts","reply":"Merge main in and resolve the conflicts"}}
  Branch graph, newest commit first; each commit's "branch" gives its lane ("into" is the base lane).
  Use it to explain merge conflicts, a rebase, or where branches diverged. Mark the base commits that
  conflict with "conflict":true; optional "parents":[hash,…] for merge commits.
- {"type":"tree","title":"…","items":[{"path":"src/auth/limiter.ts","change":"added","note":"…"}]}
  A file tree; use for new modules/scaffolding where structure matters.
- {"type":"code","language":"ts","code":"…","caption":"…","file":"src/a.ts","line":10,"highlight":[3,4]}
  Key snippet (new API, signature, config) — not whole files.
- {"type":"compare","before":{"label":"Before","items":["…"]},"after":{"label":"After","items":["…"]}}
- {"type":"flow","title":"…","nodes":[{"id":"a","label":"Request","note":"…"}],"edges":[["a","b","label"]]}
  Architecture / data flow / sequence. Edges optional (nodes are chained in order if omitted).
- {"type":"chart","title":"…","unit":"ms","items":[{"label":"before","value":420},{"label":"after","value":95}]}
- {"type":"terminal","command":"npm test","output":"<trimmed output>","exitCode":0}
- {"type":"checklist","title":"…","items":[{"text":"…","done":true}]}
- {"type":"callout","tone":"info|success|warn|danger","title":"…","text":"…"}
  Risks, caveats, assumptions you made.
- {"type":"image","path":"relative/or/absolute.png","caption":"…"}
  A screenshot or generated image on disk.
- {"type":"question","question":"…","options":[{"label":"Short choice","reply":"full message sent back to you"}]}
  When you need a decision. The user's click resumes you with the reply.
- {"type":"actions","title":"…","items":[{"label":"Run tests","command":"npm test"},{"label":"Follow up","reply":"…"}]}
  One-click shell commands (executed in the project root) or follow-up actions the user may want to trigger.
- {"type":"next","items":["Suggested follow-up the user might send", "…"]}
  Usually last. 2–4 concrete follow-ups.

Strings must be valid JSON (escape newlines as \\n and quotes as \\"). Example:

\`\`\`wisp
{"blocks":[
  {"type":"hero","title":"Login now rate-limited","summary":"Added a sliding-window limiter to /login. 5 attempts per minute per IP.","status":"done"},
  {"type":"diff","file":"src/auth/login.ts"},
  {"type":"tests","command":"npm test","passed":48,"failed":0,"skipped":0,"durationMs":4100},
  {"type":"callout","tone":"warn","title":"Assumption","text":"Behind a proxy, so I read the IP from X-Forwarded-For."},
  {"type":"next","items":["Make the limit configurable","Add the same limiter to /reset-password"]}
]}
\`\`\`
`.trim();

const ASK_TOOL = (tool) => `- If a decision would change the rest of the work (ambiguous requirement, destructive or risky step,
  two very different approaches), call the \`ask_user\` tool (${tool}). It pauses you until
  the user answers in wisp — you keep all your context. Ask one crisp question with 2–4 options.
- If the user asks about their past wisp tasks (which tools or harnesses they use, cost, success rate),
  call \`wisp_stats\` (${tool.replace(/ask_user$/, 'wisp_stats')}) instead of digging through files.
- If the prompt mentions another wisp task ("@Title (wisp task <id>)") or the user asks what another task
  did, read it with \`wisp_session\` (${tool.replace(/ask_user$/, 'wisp_session')}); \`wisp_sessions\` lists them.`;
const ASK_BLOCK = `- If a decision would change the rest of the work (ambiguous requirement, destructive or risky step,
  two very different approaches), stop before acting on it and end with a "question" block (2–4 options).
  The user's answer comes back as a follow-up in this same session.`;

// askTool: how the harness names wisp's injected ask_user tool, or null if it can't take one.
// ask: replaces the ask guidance outright (subagents, who have nobody to ask).
export const systemPrompt = ({ askTool = 'mcp__wisp__ask_user', ask } = {}) => PROTOCOL.replace('{{ASK}}', ask || (askTool ? ASK_TOOL(askTool) : ASK_BLOCK));
export const SYSTEM_PROMPT = systemPrompt();

// Only the opener is matched by regex. The closing fence can't be: the JSON itself often
// contains ``` (a markdown block with a code sample), and a lazy match would cut it there.
const OPEN = /```wisp[^\n]*\n/g;

export function parsePresentation(text = '') {
  const opens = [...text.matchAll(OPEN)];
  for (let i = opens.length - 1; i >= 0; i--) {
    const open = opens[i];
    const json = readJson(text.slice(open.index + open[0].length));
    const blocks = Array.isArray(json) ? json : json?.blocks;
    if (Array.isArray(blocks) && blocks.length) {
      const extra = text.slice(0, open.index).trim();
      return { blocks: blocks.filter((b) => b && typeof b.type === 'string'), notes: extra || undefined };
    }
  }
  // The agent ignored (or broke) the protocol — show its answer as plain markdown, with any
  // broken wisp payload kept verbatim in a fence rather than half-rendered as prose.
  const last = opens.at(-1);
  let md = text.trim();
  if (last) {
    const prose = text.slice(0, last.index).trim();
    const raw = text.slice(last.index + last[0].length).replace(/\n?```\s*$/, '');
    md = `${prose}\n\n\`\`\`\`\`json\n${raw}\n\`\`\`\`\``.trim();
  }
  return {
    fallback: true,
    blocks: [{ type: 'markdown', text: md || '_The agent finished without a message._' }],
  };
}

// Parse the JSON value at the start of `src` (the body after a ```wisp opener). First find its
// end by bracket matching, respecting strings; if that fails (e.g. a stray unescaped quote), try
// every ``` after it as the closing fence.
function readJson(src) {
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

// Last resort: parse the blocks array one element at a time, so a single malformed block (an
// unescaped quote in a terminal output, say) costs that block rather than the whole answer.
function salvageBlocks(src) {
  const m = /^\s*(\{\s*"blocks"\s*:\s*)?\[/.exec(src);
  if (!m) return null;
  const blocks = [];
  let bad = 0;
  let i = m[0].length;
  while (i < src.length) {
    while (/[\s,]/.test(src[i] || '')) i++;
    if (src[i] !== '{') break;
    const len = jsonEnd(src.slice(i));
    if (len < 0) break;
    const block = tryJson(src.slice(i, i + len));
    if (block && typeof block === 'object') blocks.push(block);
    else bad++;
    i += len;
  }
  if (!blocks.length) return null;
  if (bad) blocks.push({ type: 'callout', tone: 'warn', title: `${bad} block${bad > 1 ? 's' : ''} skipped`, text: 'Part of the agent\'s answer was malformed JSON and could not be shown.' });
  return blocks;
}

function jsonEnd(src) {
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

function tryJson(src) {
  try {
    return JSON.parse(src);
  } catch {}
  // Common LLM slips: trailing commas, smart quotes.
  const relaxed = src.replace(/,\s*([}\]])/g, '$1').replace(/[“”]/g, '"');
  try {
    return JSON.parse(relaxed);
  } catch {
    return null;
  }
}

export function heroOf(presentation) {
  return presentation?.blocks?.find((b) => b.type === 'hero');
}
