// Replays plugins/claude/core/tests/fixtures/*.jsonl through a v1 checkout's Claude adapter.
// usage: node replay.mjs <v1-checkout> <fixtures-dir> <out-dir>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const [v1, dir, outDir] = process.argv.slice(2);
process.env.WISP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'g6-home-'));
process.env.WISP_UPDATE_CHECK = '0';
delete process.env.WISP_CHROME;
const names = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => f.slice(0, -6)).sort();
const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'g6-bin-'));
const bin = path.join(binDir, 'claude');
fs.writeFileSync(bin, `#!/usr/bin/env node
const fs=require('fs');const m=JSON.parse(fs.readFileSync(process.env.G6_META,'utf8'));
const out=fs.readFileSync(process.env.G6_JSONL,'utf8').split('@CWD@').join(process.env.G6_CWD);
process.stdin.resume();process.stdin.on('data',()=>{});
process.stdout.write(out,()=>{ if(m.exit.stderr) process.stderr.write(m.exit.stderr);
 if(m.stopAfter){setInterval(()=>{},1000);return;} process.exit(m.exit.code??0);});
`);
fs.chmodSync(bin, 0o755);
process.env.WISP_CLAUDE_BIN = bin;
const { default: claude } = await import(path.join(v1, 'server/adapters/claude.js'));
for (const name of names) {
  const meta = JSON.parse(fs.readFileSync(path.join(dir, `${name}.meta.json`), 'utf8'));
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g6-run-')));
  Object.assign(process.env, { G6_META: path.join(dir, `${name}.meta.json`), G6_JSONL: path.join(dir, `${name}.jsonl`), G6_CWD: cwd });
  const events = [];
  let run;
  run = claude.run({ prompt: 'fix the add bug', systemPrompt: '# You are running inside wisp\nAnswer with a ```wisp block.\n', cwd, ...meta.opts, onEvent: (e) => {
    events.push(e);
    if (meta.stopAfter && events.length === meta.stopAfter) setTimeout(() => run.stop(), 50);
  } });
  await run.done;
  const text = JSON.stringify(events, null, 1).split(cwd).join('@CWD@');
  fs.writeFileSync(path.join(outDir, `${name}.v1.json`), text + '\n');
  console.log(name, events.length);
}
