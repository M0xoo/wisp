// @wisp/native: PTYs and process trees for the terminal and runtime plugins (ADR-0010).
//
//   const host = await startNative();
//   const pty = await host.spawnPty({ cmd: 'claude', args: ['--resume', id], cwd, env, cols, rows });
//   pty.onData((chunk) => …); pty.write('hi\r'); pty.resize(120, 40); await pty.kill();
//   const p = await host.spawnTree({ cmd: 'codex', args, cwd, env }); p.stdout.on('data', …);
//   await host.killTree(p.pid);   // the whole tree, 0 orphans
//
// The wisp-native binary does the work when it is there (WISP_NATIVE_BIN, the optional dependency
// @wisp/native-<platform>-<arch>, or a dev build in native/target/release). Otherwise a fallback
// with the same API runs v1's Python pty.fork helper / script(1) and kills process groups, so an
// install never breaks. WISP_NATIVE=0 forces the fallback.

import { startBinary } from './binary-host.ts';
import { NativeError } from './errors.ts';
import { startFallback } from './fallback/host.ts';
import { type LocateDeps, defaultLocateDeps, locateBinary } from './locate.ts';
import type { NativeHost } from './types.ts';

export interface StartOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** 'native' fails instead of falling back (tests, `wisp doctor`); 'fallback' skips the binary */
  prefer?: 'auto' | 'native' | 'fallback';
  /** what the helper logs, and why the fallback was chosen */
  log?: (line: string) => void;
  /** override the lookup (tests) */
  locate?: Partial<LocateDeps>;
}

export async function startNative(opts: StartOptions = {}): Promise<NativeHost> {
  const env = opts.env ?? process.env;
  const prefer = opts.prefer ?? 'auto';
  const log = opts.log ?? (() => {});
  const off = env['WISP_NATIVE'] === '0' || env['WISP_NATIVE'] === 'off';
  if (prefer === 'fallback' || (off && prefer === 'auto')) {
    return startFallback({ reason: off ? 'turned off by WISP_NATIVE' : 'asked for', env });
  }
  const found = locateBinary({ ...defaultLocateDeps(env), ...opts.locate });
  if (found.binary === null) {
    if (prefer === 'native') throw new NativeError('unsupported', found.reason);
    log(found.reason);
    return startFallback({ reason: found.reason, env });
  }
  try {
    return await startBinary({ binary: found.binary, source: found.source, log });
  } catch (e) {
    if (prefer === 'native') throw e;
    const reason = `wisp-native at ${found.binary} didn't start: ${e instanceof Error ? e.message : String(e)}`;
    log(reason);
    return startFallback({ reason, env });
  }
}

export { NativeError } from './errors.ts';
export { NATIVE_TARGETS, binaryName, locateBinary, nativePackageName } from './locate.ts';
export type { LocateDeps, Located } from './locate.ts';
export { PROTOCOL, SIGNALS } from './protocol.ts';
export type { ErrorCode, Event, ListItem, Request, Signal } from './protocol.ts';
export { escapeCmdArgument, escapeCmdCommand, parseCmdShim, resolveCommand, whichWindows } from './resolve-command.ts';
export type { BinarySource, ExitInfo, HostInfo, KillOptions, KillReport, NativeHost, Pty, SpawnOptions, SpawnPtyOptions, TreeProcess } from './types.ts';
