// What a Claude Code tool call is, in words: the live ticker's sentence and a coarse kind for the
// trail (describeTool), a permission prompt's subject (actionOf), the exact thing allowed (detailOf),
// the --allowedTools rule for a retry (ruleOf), and the diff an edit's input already holds.

import path from 'node:path';
import { clip, crewToolLabel, describeCommand, ioStep, MAX_SNAPSHOT, rec, rel, str, type IoStep, type RunPaths, type ToolLabel } from '@wisp/harness-kit';
import type { HarnessEvent } from '@wisp-plugin/runtime-api';

type Input = Record<string, unknown>;
const fileOf = (input: Input, paths: RunPaths | string): string => rel(input['file_path'] || input['notebook_path'] || input['path'], paths);

/** wisp's own MCP tools, by full name. */
function wispTool(name: string, input: Input): ToolLabel | null {
  switch (name) {
    case 'mcp__wisp__ask_user':
      return { kind: 'wait', label: 'Waiting for your answer' };
    case 'mcp__wisp__delegate': {
      const tasks = Array.isArray(input['tasks']) ? input['tasks'].map(rec) : [];
      return { kind: 'agent', label: `Delegating to ${clip([...new Set(tasks.map((t) => t['subagent']))].join(', ') || 'subagents', 60)}` };
    }
    case 'mcp__wisp__subagent_results':
      return { kind: 'agent', label: 'Waiting on subagents' };
    case 'mcp__wisp__resume_later':
      return { kind: 'tool', label: input['cancel'] ? 'Cancelling a scheduled follow-up' : `Scheduling a follow-up${input['minutes'] ? ` in ${str(input['minutes'])} min` : ''}` };
    case 'mcp__wisp__wisp_tag': {
      const tags = Array.isArray(input['tags']) ? input['tags'] : [];
      return { kind: 'tool', label: `Tagging the task${tags.length ? `: ${clip(tags.map((t) => `#${str(t)}`).join(' '), 60)}` : ''}` };
    }
    case 'mcp__wisp__wisp_pr':
      return { kind: 'tool', label: input['remove'] ? 'Detaching a PR' : `Attaching PR ${clip(String(input['pr'] || '').replace(/^https:\/\/github\.com\//, ''), 60)}` };
    case 'mcp__wisp__wisp_save': {
      const what = String(input['title'] || input['name'] || String(input['app'] || input['path'] || input['url'] || '').split(/[\\/]/).pop() || 'it');
      return { kind: 'tool', label: `${input['id'] ? 'Updating' : 'Saving'} ${clip(what, 50)} ${input['id'] ? 'in' : 'to'} My Stuff` };
    }
    case 'mcp__wisp__wisp_stuff':
      return { kind: 'tool', label: 'Looking in My Stuff' };
    case 'mcp__wisp__wisp_blocks':
      return { kind: 'tool', label: 'Reading block formats' };
    case 'mcp__wisp__wisp_stats':
      return { kind: 'tool', label: 'Reading wisp stats' };
    case 'mcp__wisp__wisp_sessions':
      return { kind: 'tool', label: 'Listing wisp tasks' };
    case 'mcp__wisp__wisp_session':
      return { kind: 'tool', label: `Reading wisp task ${clip(input['id'] || '', 40)}` };
    default:
      return null;
  }
}

/** Human sentence for the live ticker + a coarse kind for the trail summary. */
export function describeTool(name: string, input: Input, paths: RunPaths | string): ToolLabel {
  const f = fileOf(input, paths);
  switch (name) {
    case 'Read':
      return { kind: 'read', label: `Reading ${f}`, file: f };
    case 'Edit':
    case 'MultiEdit':
      return { kind: 'edit', label: `Editing ${f}`, file: f };
    case 'Write':
      return { kind: 'edit', label: `Writing ${f}`, file: f };
    case 'NotebookEdit':
      return { kind: 'edit', label: `Editing notebook ${f}`, file: f };
    case 'Bash':
      return { kind: 'run', label: input['description'] ? clip(input['description']) : describeCommand(input['command'], paths), detail: input['command'] as string };
    case 'Grep':
      return { kind: 'search', label: `Searching for “${clip(input['pattern'], 40)}”` };
    case 'Glob':
      return { kind: 'search', label: `Finding ${clip(input['pattern'], 50)}` };
    case 'WebSearch':
      return { kind: 'web', label: `Searching the web: ${clip(input['query'], 50)}` };
    case 'WebFetch':
      return { kind: 'web', label: `Reading ${clip(input['url'], 60)}` };
    case 'Task':
    case 'Agent':
      return { kind: 'agent', label: `Delegating: ${clip(input['description'] || input['prompt'], 60)}` };
    case 'TodoWrite': {
      const todos = Array.isArray(input['todos']) ? input['todos'].map(rec) : [];
      const active = todos.find((t) => t['status'] === 'in_progress');
      return { kind: 'plan', label: active ? clip(active['activeForm'] || active['content']) : 'Planning' };
    }
    case 'Skill': // the name is how a shared task finds the skills it used
      return { kind: 'tool', label: input['skill'] ? `Using the ${clip(String(input['skill']), 64)} skill` : 'Using a skill' };
    default:
      return wispTool(name, input) ?? crewToolLabel(name.replace(/^mcp__wisp__/, ''), input) ?? { kind: 'tool', label: name.startsWith('mcp__') ? `Using ${name.split('__').slice(1).join(' · ')}` : `Using ${name}` };
  }
}

/** A permission prompt's subject: "run `npm publish`", "edit src/a.ts", "fetch https://…". */
export function actionOf(tool: string, input: Input, paths: RunPaths | string): string {
  const f = fileOf(input, paths);
  if (tool === 'Bash') return `run \`${clip(input['command'], 200)}\``;
  if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool) && f) return `${tool === 'Write' ? 'write' : 'edit'} ${f}`;
  if (tool === 'WebFetch') return `fetch ${clip(input['url'], 120)}`;
  if (tool === 'WebSearch') return `search the web for “${clip(input['query'], 80)}”`;
  if (tool === 'ExitPlanMode') return 'leave plan mode and start making changes';
  if (tool.startsWith('mcp__')) return `use ${tool.split('__').slice(1).join(' · ')}`;
  return `use ${tool}`;
}

/** The exact thing being allowed, so "always allow" matches only the same command or file. */
export function detailOf(tool: string, input: Input, paths: RunPaths | string): string {
  if (tool === 'Bash') return String(input['command'] ?? '');
  const f = input['file_path'] || input['notebook_path'] || input['path'];
  if (f) return rel(f, paths);
  return String(input['url'] ?? input['query'] ?? input['pattern'] ?? '');
}

/** An --allowedTools rule for a retry: the exact command for Bash, the tool for the rest. */
export const ruleOf = (tool: string, input: Input): string => (tool === 'Bash' && input['command'] ? `Bash(${String(input['command'])})` : tool);

type Change = Extract<HarnessEvent, { type: 'change' }>;

/**
 * The diff an edit's input already holds, so wisp shows real diffs without asking the agent. A Write
 * needs the file as it is now (tool_use is streamed before the tool runs, so the file still holds
 * its old content): that read is an IO step the driver runs in place.
 */
export function captureChange(name: string, input: Input, paths: RunPaths): Change | IoStep<HarnessEvent> | null {
  const file = input['file_path'];
  if (!file || typeof file !== 'string') return null;
  const r = rel(file, paths);
  if (name === 'Edit') return { type: 'change', early: true, file: r, op: 'edit', edits: [{ before: str(input['old_string'] ?? ''), after: str(input['new_string'] ?? '') }] };
  if (name === 'MultiEdit') {
    const edits = (Array.isArray(input['edits']) ? input['edits'] : []).map(rec).map((e) => ({ before: str(e['old_string'] ?? ''), after: str(e['new_string'] ?? '') }));
    return { type: 'change', early: true, file: r, op: 'edit', edits };
  }
  if (name !== 'Write') return null;
  const after = String(input['content'] ?? '');
  return ioStep(async (io) => {
    // Past the cap it is a new file as far as the diff goes, as in v1.
    const before = await io.readUpTo(path.resolve(paths.cwd, file), MAX_SNAPSHOT);
    return [{ type: 'change', early: true, file: r, op: before === null ? 'create' : 'write', edits: [{ before: before ?? '', after: after.slice(0, MAX_SNAPSHOT) }] }];
  });
}
