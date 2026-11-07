// npm run dev:tauri: the Tauri shell on this checkout. web/ edits reload it, server/ and desktop/
// edits relaunch it once nothing is running (desktop/entry.mjs). Rust edits need a new run.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), 'src-tauri', 'Cargo.toml');
const args = ['run', '--manifest-path', manifest, ...process.argv.slice(2)];
spawn('cargo', args, { stdio: 'inherit', env: { ...process.env, WISP_DEV: '1' } })
  .on('error', () => (console.error('dev:tauri needs Rust: https://rustup.rs'), process.exit(1)))
  .on('exit', (code) => process.exit(code ?? 1));
