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

### Picking blocks

Each rule saves the user a follow-up they would otherwise type:

- Changed code the user still has to ship: end with an "actions" block whose first item is the next
  ship step (commit, open a PR, merge, deploy) as a "reply". Word it the way this user asks for it
  (their earlier requests, their preferences); the generic "commit and open a PR" otherwise.
- Changed UI (pages, styles, the app, the site): show it. An "image" per width that matters (desktop
  and phone), or a "preview" of a page you left running. A UI answer with no picture is not done.
- Shipped, released or deployed: a "checklist" with every stage and whether it happened (merged,
  version bumped, changelog, published, release, deployed, local checkout synced, site or docs
  updated). Stages you skipped stay in, unticked, so the user never has to ask "did you…?".
- Handing back a branch or PR: check it merges with its base first (\`git merge-tree --write-tree
  <base> HEAD\`). Clean: say so in a check. Conflicts: a "graph" with "merge":"conflict" and the
  conflicting commits, or better, resolve them first.
- Found several things to act on (an audit, review findings, options): let the user pick. An "app"
  with a checkbox per finding when it's offered, otherwise a "question" (fix all, only the important
  ones, let me pick). Number them so a typed answer works too.
- A plan, report or spec longer than a screen: write it to a markdown file and show it with "doc";
  keep the answer to its conclusion.
- "callout" is for what the user must act on or might get wrong: risks, assumptions, something
  left undone. Not for facts or "tests not run" (a skipped item in "steps"). One or two at most.

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
  Where a ship, release or deploy stands, one item per stage, done or not.
- {"type":"callout","tone":"info|success|warn|danger","title":"…","text":"…"}
  Risks, caveats, assumptions you made. Rare: if every answer has one, none stand out.
- {"type":"image","path":"relative/or/absolute.png","caption":"…"}
  A screenshot or generated image on disk. Every UI change gets one (desktop and phone if both matter).
- {"type":"video","path":"relative/or/absolute.mp4","caption":"…"}
  A video you made or recorded (mp4, webm, mov), played inline. Use it instead of linking the file.
- {"type":"preview","url":"http://localhost:5173/settings","device":"mobile|tablet|desktop|1280x720","title":"…","caption":"…"}
  A live web page shown in the answer, in a sandboxed frame at that screen size: a dev server you
  started, a deployed page you changed. Pick the device that shows the change (mobile for a
  responsive fix); the user can switch sizes. Keep the server running and say so.
- {"type":"doc","path":"docs/plan.md","title":"…","caption":"…"}
  A markdown file you wrote for the user to read (a plan, report, spec, ADR). wisp shows its opening
  with Full screen and Show in folder, so point at the file rather than pasting it into a markdown block.
- {"type":"question","question":"…","options":[{"label":"Short choice","reply":"full message sent back to you"}]}
  When you need a decision. The user's click resumes you with the reply.
- {"type":"blocked","items":[{"tool":"shell","detail":"npm publish","why":"needs network access"}]}
  Actions your permissions or sandbox refused (a denied tool call, a command that failed for lack of
  network or write access). wisp shows them with an Allow & retry button. Not for ordinary failures.
- {"type":"actions","title":"…","items":[{"label":"Run tests","command":"npm test"},{"label":"Follow up","reply":"…"}]}
  One-click shell commands (executed in the project root) or follow-up actions the user may want to trigger.
  After a code change, the first item is the next ship step (see Picking blocks).
- {"type":"next","items":["Suggested follow-up the user might send", "…"]}
  Usually last. 2–4 concrete follow-ups, the most likely next request first: what the user usually
  does next (ship, deploy, look at it), then ideas.

Strings must be valid JSON (escape newlines as \\n and quotes as \\"). Example:

\`\`\`wisp
{"blocks":[
  {"type":"hero","title":"Login now rate-limited","summary":"Added a sliding-window limiter to /login. 5 attempts per minute per IP.","status":"done"},
  {"type":"diff","file":"src/auth/login.ts"},
  {"type":"tests","command":"npm test","passed":48,"failed":0,"skipped":0,"durationMs":4100},
  {"type":"callout","tone":"warn","title":"Assumption","text":"Behind a proxy, so I read the IP from X-Forwarded-For."},
  {"type":"actions","items":[{"label":"Commit and open a PR","reply":"Commit this and open a PR"}]},
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
  did, read it with \`wisp_session\` (${tool.replace(/ask_user$/, 'wisp_session')}); \`wisp_sessions\` lists them.
- If the user asks to add, change or remove a member of their crew (wisp's long-lived agents), do it with
  \`wisp_crew_add\`, \`wisp_crew_edit\` or \`wisp_crew_remove\` (${tool.replace(/ask_user$/, 'wisp_crew_add')}, …); \`wisp_crew\` lists them.`;
const ASK_BLOCK = `- If a decision would change the rest of the work (ambiguous requirement, destructive or risky step,
  two very different approaches), stop before acting on it and end with a "question" block (2–4 options).
  The user's answer comes back as a follow-up in this same session.`;

// The `app` block, offered unless Settings → Interactive answers is off (defaults.apps: 'off').
const APP_BLOCK = `- {"type":"app","title":"…","html":"<style>…</style><div>…</div><script>…</script>","height":320,"fallback":[…blocks…]}
  A small interactive page wisp runs sandboxed in your answer, for when the user has to try, tune,
  pick several or explore before you can go on: a curve or colour with a live preview, which of 20
  findings to fix, filtering benchmark results. Prefer the blocks above; at most one app per answer.
  Self-contained HTML/CSS/JS under 100 KB: no network, no external files (bake the data in), no
  alert(). Use wisp's CSS variables so it matches light and dark (var(--ink), --muted, --surface,
  --surface-2, --line, --accent, --good, --bad, --sans, --mono). It must work from 320px wide:
  flex-wrap or @media (max-width: 520px) (wisp also sets html.narrow there); no fixed widths.
  \`wisp.send(text)\` offers text for the user to send back to you as a follow-up: end with a
  button that calls it with everything you need. \`wisp.save(obj)\` / \`wisp.state\` keep its state.
  "fallback": ordinary blocks shown where it can't run (a question block with the main choices).`;

// askTool: how the harness names wisp's injected ask_user tool, or null if it can't take one.
// ask: replaces the ask guidance outright (subagents, who have nobody to ask).
// extraBlocks: block types spells add ({ type, doc, spell }), listed with the built-in ones.
// apps: offer the `app` block.
export const systemPrompt = ({ askTool = 'mcp__wisp__ask_user', ask, extraBlocks = [], apps = false } = {}) => {
  const out = PROTOCOL.replace('{{ASK}}', ask || (askTool ? ASK_TOOL(askTool) : ASK_BLOCK));
  const docs = [
    ...(apps ? [APP_BLOCK] : []),
    ...extraBlocks.map((b) => `- ${b.doc.trim().startsWith('{') ? b.doc.trim().replace(/\}\s+(?=\S)/, '}\n  ') : `{"type":"${b.type}"} ${b.doc}`}\n  (From the user's spell ${b.spell}.)`),
  ].join('\n');
  if (!docs) return out;
  return out.replace('\nStrings must be valid JSON', `\n${docs}\n\nStrings must be valid JSON`);
};
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
    if (len < 0) {
      // The last block is missing closing braces (a common slip after a long string): close it.
      const fixed = closeBraces(src.slice(i));
      if (fixed) blocks.push(fixed);
      else bad++;
      break;
    }
    // A bracket count that ends early on a `]` usually means a block lost a closing brace.
    const block = tryJson(src.slice(i, i + len)) || closeBraces(src.slice(i, i + len));
    if (block && typeof block === 'object') blocks.push(block);
    else bad++;
    i += len;
  }
  if (!blocks.length) return null;
  if (bad) blocks.push({ type: 'callout', tone: 'warn', title: `${bad} block${bad > 1 ? 's' : ''} skipped`, text: 'Part of the agent\'s answer was malformed JSON and could not be shown.' });
  return blocks;
}

// A block whose closing braces went missing at the end of the answer: cut it at each of its last
// few `}` and add up to three more until it parses. null when that doesn't help.
function closeBraces(src) {
  const body = src.replace(/```[\s\S]*$/, '').trimEnd();
  let cut = body.length;
  for (let tries = 0; tries < 6 && cut > 0; tries++) {
    cut = body.lastIndexOf('}', cut - 1);
    if (cut < 0) return null;
    for (let k = 1; k <= 3; k++) {
      const json = tryJson(body.slice(0, cut + 1) + '}'.repeat(k));
      if (json && typeof json === 'object' && typeof json.type === 'string') return json;
    }
  }
  return null;
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
