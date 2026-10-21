// A stand-in for the native WispSsh plugin, so the machines screen runs in a desktop browser
// (`npm run preview`). `?fail=auth` refuses until a password is given, `?fail=node`
// fails at Node.js, `?fail=bare` shows Node.js being installed.

const q = new URLSearchParams(location.search);
const listeners = new Set();
const lines = [];
let state = 'idle';
let machineId = '';
let n = 0;
const emit = (text) => {
  lines.push(text);
  for (const fn of listeners) fn({ text });
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeKey = (name, type = 'ssh-ed25519', source = 'phone') => {
  const id = `k${++n}`;
  const b = btoa(`${id}${name}`).replace(/=/g, '');
  return { id, name, source, type, publicKey: `${type} AAAAC3NzaC1lZDI1NTE5AAAAI${b} wisp-phone`, fingerprint: `SHA256:${(b + 'q2V0dW4bTn8C1jX1fZb3cU6m4X0kq7sQYp9w8L').slice(0, 43)}` };
};
const keys = [fakeKey('This phone')];

export const WispSsh = {
  addListener(event, fn) {
    if (event === 'line') listeners.add(fn);
    return { remove: () => listeners.delete(fn) };
  },
  async listKeys() {
    return { keys: [...keys] };
  },
  async createKey({ name }) {
    const k = fakeKey(name);
    keys.push(k);
    return k;
  },
  async importKey({ name, privateKey }) {
    if (!/PRIVATE KEY/.test(privateKey)) throw new Error('That doesn’t look like a private key (OpenSSH, PEM or PuTTY).');
    const k = fakeKey(name, 'ssh-ed25519', 'imported');
    keys.push(k);
    return k;
  },
  async deleteKey({ id }) {
    keys.splice(keys.findIndex((k) => k.id === id), 1);
  },
  async status() {
    return { state, lines: [...lines], machineId, port: 4477 };
  },
  async disconnect() {
    state = 'idle';
    machineId = '';
    lines.length = 0;
  },
  async forgetHost() {},
  async connect({ machineId: id, host, user, password }) {
    const fail = q.get('fail');
    state = 'connecting';
    machineId = id;
    lines.length = 0;
    emit(`@@wisp step ssh run ${user}@${host}`);
    await wait(700);
    if (fail === 'auth' && !password) return ((state = 'failed'), emit('@@wisp fail ssh Authentication failed: the machine refused this phone’s key.'));
    if (password) emit('@@wisp keyed');
    emit(`@@wisp step ssh done Linux ${host}`);
    await wait(600);
    if (fail === 'node') return ((state = 'failed'), emit('@@wisp fail node Node.js isn’t installed there (or isn’t on PATH).'));
    if (fail === 'bare') {
      emit('@@wisp step node run installing Node.js into ~/.wisp/node (no admin needed)');
      await wait(1500);
    }
    emit('@@wisp step node done v24.22.1');
    emit('@@wisp step wisp run starting npx -y wisp-agents@latest');
    await wait(1200);
    emit('@@wisp step wisp done started · 0.26.0');
    emit('@@wisp ready 0.26.0 4242');
    emit('@@wisp step tunnel run');
    await wait(500);
    emit('@@wisp step tunnel done 127.0.0.1:4477 → 4477');
    state = 'ready';
    emit('@@wisp open 0.26.0');
  },
};
