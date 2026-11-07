// What every harness says the same way: attachments in the prompt, wisp's protocol for CLIs with no
// system-prompt flag, the result text of a CLI that died, and wisp's own MCP tools' labels.

import { clip, isRecord } from './text.ts';

/** ask_user may wait for the human a long time */
export const ASK_TIMEOUT_MS = 7 * 24 * 3600 * 1000;

/** The result text for a CLI that ended without saying why. */
export const exitText = (bin: string, code: number | null, signal: string | null): string => `${bin} exited with ${signal || `code ${code}`}`;

export interface FileNote {
  path: string;
  mime: string;
  size: number;
}

/** Attachments that have a path on disk: what a harness can be pointed at. */
export const onDisk = <T extends { path?: string; mime: string; size: number }>(list: readonly T[]): (T & FileNote)[] =>
  list.filter((a): a is T & FileNote => typeof a.path === 'string' && a.path !== '');

export function attachmentNote(files: readonly FileNote[], how = 'Read images and PDFs with your file-reading tool'): string {
  if (!files.length) return '';
  const lines = files.map((f) => `- ${f.path}  (${f.mime}, ${Math.max(1, Math.round(f.size / 1024))} KB)`);
  return `\n\n<attachments>\nThe user attached these files. ${how}; for video/audio/other formats use the shell (e.g. ffmpeg, ffprobe) if needed.\n${lines.join('\n')}\n</attachments>`;
}

/**
 * Harnesses without a system-prompt flag get the wisp protocol in front of the first prompt.
 * Follow-ups resume the same session, so the protocol is still in context.
 */
export function withProtocol(prompt: string, systemPrompt: string, resumeId: string | null | undefined): string {
  return resumeId ? prompt : `${systemPrompt.trim()}\n\n---\n\n# Task\n\n${prompt}`;
}

export interface ToolLabel {
  kind: 'read' | 'edit' | 'run' | 'search' | 'web' | 'agent' | 'plan' | 'tool' | 'wait' | 'ask';
  label: string;
  file?: string;
  detail?: string;
}

/** The crew and connector tools of wisp's MCP server, by bare tool name; null for any other tool. */
export function crewToolLabel(tool: string, input: unknown = {}): ToolLabel | null {
  const i = isRecord(input) ? input : {};
  const who = clip(String(i['member'] || i['name'] || ''), 40);
  if (tool === 'wisp_crew') return { kind: 'tool', label: who ? `Reading ${who}’s brief, notebook and kit` : 'Listing your crew' };
  if (tool === 'wisp_crew_add') return { kind: 'tool', label: `Adding ${who || 'a member'} to your crew` };
  if (tool === 'wisp_crew_edit') return { kind: 'tool', label: `Changing ${who || 'a crew member'}` };
  if (tool === 'wisp_crew_kit') return { kind: 'tool', label: `Writing skills for ${who || 'a crew member'}` };
  if (tool === 'wisp_crew_remove') return { kind: 'tool', label: `Removing ${who || 'a member'} from your crew` };
  if (tool === 'wisp_connectors') return { kind: 'tool', label: 'Listing your connectors' };
  if (tool === 'wisp_connector_add') return { kind: 'tool', label: `Adding ${who || 'a connector'} to your connectors` };
  if (tool === 'wisp_connector_signin') return { kind: 'ask', label: `Waiting for you to sign in to ${who || 'a connector'}` };
  return null;
}
