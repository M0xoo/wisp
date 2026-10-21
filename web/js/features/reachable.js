// Settings → Machines → This computer: can another computer, or the wisp phone app, connect here
// over SSH? Each row checks one thing (GET /api/machines/reachable) and says how to fix it on this
// OS, with the command to copy.

import { esc } from '../md.js';
import { copy } from '../blocks.js';
import { api } from '../core/api.js';
import { $, icon } from '../core/dom.js';
import { toast } from '../ui/toast.js';
import { setupCommand } from './setup.js';

export const TAILSCALE_GUIDE = 'https://trywisp.dev/guides/connect-machines-with-tailscale.html';

// How to turn on an SSH server, per OS.
const SSH_ON = {
  darwin: { tip: 'Turn on System Settings → General → Sharing → Remote Login, or run:', command: 'sudo systemsetup -setremotelogin on' },
  linux: { tip: 'Install and start the OpenSSH server (on Fedora: dnf install openssh-server, then enable sshd):', command: 'sudo apt install -y openssh-server && sudo systemctl enable --now ssh' },
};

const state = (kind, label) => `<span class="sx-state ${kind === 'bad' ? 'bad' : ''}"><i class="dot ${kind}"></i>${label}</span>`;

function rows(r) {
  const row = (name, desc, control) => `<div class="sx-row"><div class="sx-text"><b>${name}</b>${desc ? `<small>${desc}</small>` : ''}</div><div class="sx-ctl">${control}</div></div>`;
  if (!r.supported) {
    return row('Windows', `Machines run wisp under a POSIX shell. Install <a href="https://learn.microsoft.com/windows/wsl/install" target="_blank" rel="noopener">WSL</a>, then install Node.js and wisp inside it and connect to that.`, state('bad', 'Needs WSL'));
  }
  const ts = r.tailscale;
  const fix = SSH_ON[r.os] || SSH_ON.linux;
  const ssh = r.ssh.running
    ? row('SSH server', esc(r.ssh.banner), state('ok', 'On'))
    : row('SSH server', `${esc(fix.tip)}${setupCommand(fix.command)}`, state('bad', 'Off'));
  const tailscale = !ts.installed
    ? row('Tailscale', 'Optional. Reach this computer from your laptop or phone anywhere, without opening ports.', `<a class="ghost sm" href="https://tailscale.com/download" target="_blank" rel="noopener">${icon('external')}<span>Get it</span></a>${state('', 'Optional')}`)
    : !ts.running
      ? row('Tailscale', 'Installed but not connected. Open Tailscale and sign in.', state('bad', 'Off'))
      : row('Tailscale', `On your tailnet as <code>${esc(ts.name || ts.ip)}</code>${ts.ssh ? ' · Tailscale SSH lets your tailnet in without keys' : r.os === 'linux' ? `. To let your tailnet in without keys:${setupCommand('sudo tailscale set --ssh')}` : ''}`, state('ok', 'On'));
  const keys = row(
    'Keys allowed in',
    `${r.keys ? `${r.keys} key${r.keys === 1 ? '' : 's'} in <code>~/.ssh/authorized_keys</code>.` : 'No keys in <code>~/.ssh/authorized_keys</code> yet.'} From the other computer, run this once. The phone app shows a command to run here.${setupCommand(`ssh-copy-id ${r.target}`)}`,
    state(r.keys || ts.ssh ? 'ok' : '', r.keys ? 'Ready' : ts.ssh ? 'Tailscale SSH' : 'None yet'),
  );
  const target = row('Connect with', `In Machines on another computer, or in the wisp phone app. <a href="${TAILSCALE_GUIDE}" target="_blank" rel="noopener">Setup guide</a><button class="setup-cmd" data-copy="${esc(r.target)}" title="Copy"><code>${esc(r.target)}</code>${icon('copy')}</button>`, '');
  return ssh + tailscale + keys + target;
}

// Paints into `box` (an .sx-group) and re-checks on its button.
export async function paintReachable(box) {
  box.innerHTML = `<div class="sx-row"><div class="it-loading"><span class="orb tiny"></span>Checking this computer…</div></div>`;
  try {
    box.innerHTML = rows(await api('/machines/reachable'));
  } catch (err) {
    box.innerHTML = `<div class="sx-row"><div class="sx-text"><small>Couldn’t check: ${esc(err.message)}</small></div></div>`;
  }
  box.onclick = (e) => {
    const c = e.target.closest('[data-copy]');
    if (!c) return;
    copy(c.dataset.copy, c);
    toast('Copied');
  };
}

export const reachableHtml = () => `<div class="sx-group sx-reach"></div>`;
export const reachableBox = (root) => $('.sx-reach', root);
