// A stand-in for `claude auth …` / `codex login …` (test/agent-login.test.js). It prints what the
// real CLIs print (captured from claude 2.1.306 and codex-cli 0.163.0 in a wisp Grid container)
// and keeps its "login" in $HOME/.fake-<name>, like they keep theirs in ~/.claude and ~/.codex.
import fs from 'node:fs';
import path from 'node:path';

const name = path.basename(process.argv[1]).replace(/\.mjs$/, '');
const args = process.argv.slice(2).join(' ');
const file = path.join(process.env.HOME, `.fake-${name}`);
const signedIn = fs.existsSync(file);

if (name === 'gh') {
  // gh 2.88: without a terminal, `auth login --web` prints the code and URL and waits for approval.
  if (/auth status/.test(args)) {
    console.log(signedIn ? 'github.com\n  ✓ Logged in to github.com account octo (keyring)' : 'You are not logged into any GitHub hosts. To log in, run: gh auth login');
    process.exit(signedIn ? 0 : 1);
  } else if (/auth login/.test(args)) {
    console.log('\n! First copy your one-time code: ABF2-20CC\nOpen this URL to continue in your web browser: https://github.com/login/device');
    setTimeout(() => {
      fs.writeFileSync(file, 'ok');
      console.log('✓ Authentication complete.');
      process.exit(0);
    }, Number(process.env.FAKE_LOGIN_MS || 1200));
  } else if (/auth setup-git/.test(args)) fs.writeFileSync(path.join(process.env.HOME, '.fake-gh-git'), 'ok');
  else if (/auth logout/.test(args)) fs.rmSync(file, { force: true });
  else if (/api user/.test(args)) console.log(JSON.stringify({ login: 'octo', id: 583231, name: 'Octo Cat', email: null }));
} else if (args === '--version') {
  console.log(name === 'claude' ? '2.1.306 (Claude Code)' : 'codex-cli 0.163.0');
} else if (/status/.test(args)) {
  if (name === 'claude') console.log(JSON.stringify({ loggedIn: signedIn, authMethod: signedIn ? 'claude.ai' : 'none' }, null, 2));
  else console.log(signedIn ? 'Logged in using ChatGPT' : 'Not logged in');
  process.exit(name === 'claude' || signedIn ? 0 : 1);
} else if (/logout/.test(args)) {
  fs.rmSync(file, { force: true });
} else if (/device-auth/.test(args)) {
  console.log('\nWelcome to Codex [v\x1b[90m0.163.0\x1b[0m]\n\nFollow these steps to sign in with ChatGPT using device code authorization:\n');
  console.log('1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n');
  console.log('2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94m9YF0-4VK4S\x1b[0m\n');
  setTimeout(() => {
    fs.writeFileSync(file, 'ok');
    console.log('Successfully logged in');
    process.exit(0);
  }, Number(process.env.FAKE_LOGIN_MS || 1200));
} else if (/auth login/.test(args)) {
  const url = 'https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=y';
  process.stdout.write(`Opening browser to sign in…\nIf the browser didn't open, visit: \x1b]8;;${url}\x07${url}\x1b]8;;\x07\nPaste code here if prompted > `);
  process.stdin.setEncoding('utf8');
  let got = '';
  process.stdin.on('data', (d) => {
    got += d;
    if (!/[\r\n]/.test(got)) return;
    if (got.trim().endsWith('good-code')) {
      fs.writeFileSync(file, 'ok');
      console.log('\nLogin successful.');
      process.exit(0);
    }
    console.log('\nOAuth error: Invalid code');
    process.exit(1);
  });
}
