// grid/deploy/firewall.sh, run for real with stand-ins for iptables, ip and docker: the rules it
// leaves are walked the way netfilter does, first match wins, for what a box may reach.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve('grid/deploy/firewall.sh');
const PUBLIC = '203.0.113.7'; // the host's own public address
const GATEWAY = '172.18.0.1'; // the bridge's, on the host too
const skip = process.platform === 'win32' && 'needs sh';

// -C looks for the rule, -I puts it first, as iptables does.
const IPTABLES = `#!/bin/sh
op=$1; shift
case "$op" in
  -C) grep -qxF -- "$*" "$RULES" ;;
  -I) { echo "$*"; cat "$RULES"; } > "$RULES.new"; mv "$RULES.new" "$RULES" ;;
  *) exit 2 ;;
esac
`;

function setup(t, { route = `1.1.1.1 via 172.31.1.1 dev eth0 src ${PUBLIC} uid 0`, rules = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wisp-fw-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (name, text) => fs.writeFileSync(path.join(dir, name), text, { mode: 0o755 });
  put('iptables', IPTABLES);
  put('docker', '#!/bin/sh\nexit 0\n');
  put('ip', route ? `#!/bin/sh\necho '${route}'\n` : '#!/bin/sh\nexit 2\n');
  const file = path.join(dir, 'rules');
  fs.writeFileSync(file, rules.map((r) => `${r}\n`).join(''));
  const run = () => execFileSync('sh', [SCRIPT], { env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, RULES: file }, stdio: 'pipe' });
  const list = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return { run, list };
}

const flag = (w, name) => {
  const i = w.indexOf(name);
  return i < 0 ? undefined : w[i + 1];
};

// What the host does with a packet a box sent to dst:port. INPUT's policy is ACCEPT.
function verdict(rules, { dst, port, state = 'NEW' }) {
  for (const r of rules) {
    const w = r.split(' ');
    if (w[0] !== 'INPUT') continue;
    if (flag(w, '-i') && flag(w, '-i') !== 'br-wisp') continue;
    if (flag(w, '-d') && flag(w, '-d') !== dst) continue;
    if (flag(w, '-p') && flag(w, '-p') !== 'tcp') continue;
    if (flag(w, '--dport') && Number(flag(w, '--dport')) !== port) continue;
    if (flag(w, '--ctstate') && !flag(w, '--ctstate').split(',').includes(state)) continue;
    return flag(w, '-j');
  }
  return 'ACCEPT';
}

// What's on the server today, in chain order.
const LIVE = ['INPUT -i br-wisp -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT', 'INPUT -i br-wisp -j DROP', 'DOCKER-USER -i br-wisp -p tcp --dport 25 -j DROP', 'DOCKER-USER -i br-wisp -d 169.254.169.254 -j DROP'];

for (const [name, rules] of [
  ['a new server', []],
  ['a server with the older rules', LIVE],
]) {
  test(`firewall on ${name}: a box reaches the grid's 443 and nothing else on the host`, { skip }, (t) => {
    const fw = setup(t, { rules });
    fw.run();
    const r = fw.list();
    assert.equal(verdict(r, { dst: PUBLIC, port: 443 }), 'ACCEPT', 'Publish, Share and /sandbox go to WISP_GRID_URL');
    for (const port of [22, 80, 2019, 8080]) assert.equal(verdict(r, { dst: PUBLIC, port }), 'DROP', `public ${port}`);
    for (const port of [22, 443, 8080]) assert.equal(verdict(r, { dst: GATEWAY, port }), 'DROP', `gateway ${port}`);
    assert.equal(verdict(r, { dst: GATEWAY, port: 40000, state: 'ESTABLISHED' }), 'ACCEPT', 'replies to the port proxy still pass');
  });
}

test('firewall: a second run adds nothing', { skip }, (t) => {
  const fw = setup(t);
  fw.run();
  const once = fw.list();
  fw.run();
  assert.deepEqual(fw.list(), once);
});

test('firewall: no public address found, the grid still starts and nothing opens', { skip }, (t) => {
  const fw = setup(t, { route: '' });
  fw.run(); // it's ExecStartPre: a failure here would keep the grid down
  assert.equal(verdict(fw.list(), { dst: PUBLIC, port: 443 }), 'DROP');
});
