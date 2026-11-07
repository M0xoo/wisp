// `wisp computer …`: this computer on a wisp Grid, the same as Machines → Reach this computer from
// anywhere. Not signed in yet: the device sign-in runs here, you allow the code in a browser, and wisp adds
// the computer once it's done.
import type { WispClient } from '../client.ts';
import { openUrl, sleep, type Ctx } from './context.ts';
import type { Api } from './scripted.ts';

interface Computer {
  cloud?: boolean;
  on?: boolean;
  name?: string;
  grid?: string;
  state?: string;
  url?: string;
  error?: string;
  account?: { grid: string; handle: string } | null;
}

interface SignIn {
  id: string;
  grid: string;
  state: 'waiting' | 'done' | (string & {});
  userCode?: string;
  verifyUrl?: string;
  error?: string;
  user?: { handle?: string };
}

export const DEFAULT_GRID = 'grid.trywisp.dev';
// The tunnel comes up a moment after the grid has the computer: wait a little for it.
const SETTLE_MS = 15_000;

export function gridHost(u: string): string {
  try {
    return new URL(/^https?:\/\//i.test(u) ? u : `https://${u}`).host;
  } catch {
    return u;
  }
}

export function computerLine(v: Computer): string {
  if (v.cloud) return '  ● this is a cloud computer: it’s on its grid already';
  if (v.on) return `  ● ${v.name} is on ${gridHost(v.grid ?? '')}: ${v.state}${v.error ? ` (${v.error})` : ''}\n    ${v.url}`;
  const why = v.error ? `${v.error} ` : '';
  return v.account ? `  ○ off. ${why}Signed in to ${gridHost(v.account.grid)} as ${v.account.handle}: wisp computer on adds it` : `  ○ off. ${why}wisp computer on signs in to a wisp Grid and adds it`;
}

export async function computerCommand(ctx: Ctx, api: Api, [sub = 'status']: string[]): Promise<void> {
  const get = (): Promise<Computer> => api.wisp.request<Computer>('GET', '/computer');
  switch (sub) {
    case 'status': {
      const v = await get();
      return ctx.out(v, computerLine(v));
    }
    case 'off':
      return ctx.out(await api.wisp.request('POST', '/computer', { on: false }), '  ✓ off: this computer left the grid');
    case 'on':
      return turnOn(ctx, api.wisp, get);
    default:
      ctx.die(`unknown: wisp computer ${sub} (status, on, off)`);
  }
}

async function turnOn(ctx: Ctx, wisp: WispClient, get: () => Promise<Computer>): Promise<void> {
  let v = await get();
  if (v.cloud) return ctx.out(v, computerLine(v));
  const want = ctx.flags.grid && gridHost(ctx.flags.grid);
  const at = v.on ? v.grid : v.account?.grid;
  if (want && at && gridHost(at) !== want) ctx.die(`this computer uses ${gridHost(at)}. To move it, run wisp computer off and sign out of ${gridHost(at)} in Machines first.`);
  if (!v.account) {
    await signIn(ctx, wisp, ctx.flags.grid || DEFAULT_GRID);
    v = await get();
  }
  if (!v.on) await wisp.request('POST', '/computer', { on: true });
  v = await get();
  for (const end = Date.now() + SETTLE_MS; v.on && v.state !== 'online' && Date.now() < end; v = await get()) await sleep(500);
  return ctx.out(v, computerLine(v));
}

/** The device sign-in, from the terminal: print the code, open the page, wait for the browser. */
async function signIn(ctx: Ctx, wisp: WispClient, grid: string): Promise<void> {
  let f = await wisp.request<SignIn>('POST', '/cloud/signin', { url: grid, addComputer: true });
  console.error(`\n  Sign in to ${new URL(f.grid).host} and allow this code: ${f.userCode}\n    ${f.verifyUrl}\n\n  Waiting for the browser… (Ctrl-C cancels)`);
  if (ctx.flags.open && process.stdout.isTTY && f.verifyUrl) openUrl(f.verifyUrl);
  const id = f.id;
  const cancel = (): void => {
    void wisp.request('DELETE', `/cloud/signin/${id}`).catch(() => {}).finally(() => process.exit(130));
  };
  process.once('SIGINT', cancel);
  try {
    while (f.state === 'waiting') {
      await sleep(1000);
      f = await wisp.request<SignIn>('GET', `/cloud/signin/${id}`);
    }
  } finally {
    process.off('SIGINT', cancel);
  }
  if (f.state !== 'done') ctx.die(f.error || `sign-in ${f.state}`);
  console.error(`  ✓ signed in as ${f.user?.handle || 'you'}`);
}
