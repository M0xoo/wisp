// What every `wisp` subcommand gets: the parsed flags, the folder it runs for, and how it prints, asks for
// a missing argument, or stops.
import { spawn } from 'node:child_process';
import type { Flags } from './args.ts';

/** A refusal the CLI prints as `  ✗ message` before it exits 1. */
export class Refusal extends Error {}

export interface Ctx {
  flags: Flags;
  /** --cwd, else the folder wisp was started in */
  cwd: string;
  /** --json prints the value, else the text */
  out(value: unknown, text: string): void;
  /** the argument, or a refusal naming what's missing */
  need<T>(value: T | null | undefined, what: string): T;
  die(message: string): never;
}

export function makeCtx(flags: Flags): Ctx {
  const die = (message: string): never => {
    throw new Refusal(message);
  };
  return {
    flags,
    cwd: flags.cwd || process.cwd(),
    out: (value, text) => console.log(flags.json ? JSON.stringify(value, null, 2) : text),
    need: (value, what) => (value === null || value === undefined || value === '' ? die(`${what} required — see wisp --help`) : value),
    die,
  };
}

/** Opens a web address in the browser. No shell: the address may come from a server. */
export function openUrl(u: string): void {
  if (!/^https?:$/.test(new URL(u).protocol)) return;
  const [cmd, args]: [string, string[]] = process.platform === 'darwin' ? ['open', [u]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', u]] : ['xdg-open', [u]];
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
