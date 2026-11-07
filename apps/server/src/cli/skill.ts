// `wisp skill [install]`: prints the skill that teaches other agents to use wisp, or installs it where
// each harness looks for skills (per user, or with --project in this folder).
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Ctx } from './context.ts';
import { packageFile } from './root.ts';

export const SKILL_FILE = 'skills/wisp/SKILL.md';

export function skillTargets(base: string | null, env: Record<string, string | undefined> = process.env, home: string = os.homedir()): Record<string, string> {
  return {
    claude: base ? path.join(base, '.claude', 'skills') : path.join(home, '.claude', 'skills'),
    codex: base ? path.join(base, '.codex', 'skills') : path.join(env['CODEX_HOME'] || path.join(home, '.codex'), 'skills'),
    opencode: base ? path.join(base, '.opencode', 'skill') : path.join(env['XDG_CONFIG_HOME'] || path.join(home, '.config'), 'opencode', 'skill'),
  };
}

export async function skill(ctx: Ctx, sub: string | undefined): Promise<void> {
  const src = packageFile(SKILL_FILE);
  if (sub !== 'install') return void process.stdout.write(await readFile(src, 'utf8'));
  const targets = skillTargets(ctx.flags.project ? ctx.cwd : null);
  const agent = ctx.flags.agent;
  const which = !agent ? ['claude'] : agent === 'all' ? Object.keys(targets) : [agent];
  for (const a of which) {
    const target = targets[a];
    if (!target) ctx.die(`no skill location for ${a} (try claude, codex, opencode or all)`);
    const dir = path.join(target, 'wisp');
    await mkdir(dir, { recursive: true });
    await copyFile(src, path.join(dir, 'SKILL.md'));
    console.log(`  ✓ ${a}: ${path.join(dir, 'SKILL.md')}`);
  }
}
