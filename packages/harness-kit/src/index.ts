// @wisp/harness-kit: the plumbing every harness module shares (v1 server/adapters/common.js and
// commands.js). Parsers are sans-IO machines (parser.ts); drive.ts is the one place that spawns,
// through the proc service. Generic over the event type: packages sit below plugin api packages,
// so the kit never names wisp.runtime's HarnessEvent itself.

export { LineSplitter, jsonLine } from './lines.ts';
export { ioStep, isIo, replay, cleanExit } from './parser.ts';
export type { Exit, HarnessIo, IoStep, LineParser, Out } from './parser.ts';
export { drive } from './drive.ts';
export type { DriveHandle, DriveOptions } from './drive.ts';
export { fileTracker, readSnapshot, readUpTo } from './tracker.ts';
export type { FileTracker, TrackedChange } from './tracker.ts';
export { MAX_SNAPSHOT, rel } from './paths.ts';
export type { RunPaths } from './paths.ts';
export { arr, clip, flatten, isRecord, lower, num, rec, str } from './text.ts';
export { detectFirst, detectVersion, helpEfforts, helpText, quietOutput, versionIn, versionTriple } from './detect.ts';
export type { Detected } from './detect.ts';
export { ASK_TIMEOUT_MS, attachmentNote, crewToolLabel, exitText, onDisk, withProtocol } from './protocol.ts';
export type { FileNote, ToolLabel } from './protocol.ts';
export { describeCommand } from './commands/index.ts';
