// Drops node:sqlite's ExperimentalWarning, and only it: every user of wisp would see it on each start,
// and it says nothing they can act on. Every other warning still prints. A side-effect module, imported
// first (bin/wisp.ts; tools/bundle.ts puts it ahead of every published entry), and idempotent, since a
// bundle may carry it twice.
const FLAG = Symbol.for('wisp.quietSqliteWarning');
const g = globalThis as { [FLAG]?: true };

function isSqliteWarning(warning: string | Error, rest: unknown[]): boolean {
  const first = rest[0];
  const type = warning instanceof Error ? warning.name : typeof first === 'string' ? first : first && typeof first === 'object' && 'type' in first ? first.type : undefined;
  const message = warning instanceof Error ? warning.message : warning;
  return type === 'ExperimentalWarning' && /\bSQLite\b/i.test(message);
}

if (!g[FLAG]) {
  g[FLAG] = true;
  const emit = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]): void => {
    if (isSqliteWarning(warning, rest)) return;
    (emit as (w: string | Error, ...r: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}

export {};
