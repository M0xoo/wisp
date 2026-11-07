// An OpenCode plugin: a side discussion's writes wait on wisp before they happen (server/side-gate.js).
// OpenCode has no permission route a run can hand to a tool: `run` answers every prompt itself. A
// plugin's tool.execute.before runs first and can throw, which stops the call, so that's the gate.
// Runs inside OpenCode (config `plugin`, server/adapters/opencode.js): built-ins and fetch only.

const { WISP_URL, WISP_TOKEN, WISP_SESSION } = process.env;
const POLL_MS = 1500;
const GONE_POLLS = 200; // a wisp down this long isn't restarting (server/mcp-ask.js says why)

async function call(path, body) {
  const res = await fetch(`${WISP_URL}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-wisp-token': WISP_TOKEN, 'x-wisp-session': WISP_SESSION },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(`wisp ${res.status}`), { status: res.status });
  return res.json();
}

async function wait(id) {
  for (let down = 0; down < GONE_POLLS; ) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let r;
    try {
      r = await call(`/api/internal/ask/${id}`);
      down = 0;
    } catch (err) {
      if (err.status >= 400 && err.status < 500) return null; // each start of wisp has a new token: it can't answer
      down++;
      continue;
    }
    if (r.answer !== undefined) return r;
    if (r.cancelled) return null;
  }
  return null;
}

// OpenCode's tool call as the gate reads it, a list since one patch touches several files. A tool
// that isn't here doesn't write.
export function gateCalls(tool, a = {}) {
  const file = a.filePath ?? a.path ?? a.file_path;
  if (tool === 'bash') return [{ tool: 'Bash', input: { command: a.command } }];
  if (tool === 'edit') return [{ tool: 'Edit', input: { file_path: file, old_string: a.oldString ?? a.old_string, new_string: a.newString ?? a.new_string, replace_all: a.replaceAll ?? a.replace_all } }];
  if (tool === 'write') return [{ tool: 'Write', input: { file_path: file, content: a.content } }];
  if (tool === 'multiedit') return [{ tool: 'MultiEdit', input: { file_path: file, edits: (a.edits || []).map((e) => ({ old_string: e.oldString ?? e.old_string, new_string: e.newString ?? e.new_string, replace_all: e.replaceAll ?? e.replace_all })) } }];
  // A patch: its lines aren't placed here, so each file counts as a Write.
  if (tool === 'apply_patch' || tool === 'patch') {
    const text = String(a.patchText ?? a.patch ?? a.input ?? '');
    const files = [...text.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
    return (files.length ? files : ['(patch)']).map((f) => ({ tool: 'Write', input: { file_path: f, content: text } }));
  }
  return [];
}

export const WispGate = async () => ({
  'tool.execute.before': async (input, output) => {
    for (const c of gateCalls(input.tool, output.args)) {
      let r = await call('/api/internal/approve', { session: WISP_SESSION, tool: c.tool, input: c.input, tool_use_id: input.callID });
      if (r.id) r = await wait(r.id);
      if (r?.decision !== 'allow') throw new Error(r?.message || 'The user did not answer. Do not retry it.');
    }
  },
});
