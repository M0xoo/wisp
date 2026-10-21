// The script that starts wisp on a machine over `ssh … sh -s` and reports each step back.
// No Node imports: the mobile app (mobile/) runs this same file to start wisp from a phone.

import { shq } from '../shq.js';

// The steps a connection goes through, as the script and the tunnel report them.
export const STEPS = [
  ['ssh', 'Connect over SSH'],
  ['node', 'Set up Node.js'],
  ['wisp', 'Start wisp there'],
  ['tunnel', 'Open the tunnel'],
  ['agents', 'Find coding agents'],
];

// What runs on the machine. Sent on stdin, so the login shell there (bash, zsh, fish…) only ever
// sees `sh -s`. Steps come back as `@@wisp step <id> <run|done> <detail>`, `@@wisp fail <id>
// <message>`, and finally `@@wisp ready <version> <pid>`; then `cat` holds the session (and the
// tunnel) open until this side lets go. apiVersion `any` takes whichever wisp already runs there
// (the phone loads that wisp's own page, so it always speaks its API).
// No Node.js there (or one older than 20)? With installNode, the script downloads the current LTS
// from nodejs.org into ~/.wisp/node: checked against its SHA-256, no admin rights, nothing else
// touched. wisp itself then comes from npx. So a computer with only SSH on is enough.
export const NODE_LINE = 'latest-v24.x';
export function nodeInstallScript({ dist = 'https://nodejs.org/dist' } = {}) {
  return String.raw`NODE_HOME=$HOME/.wisp/node
install_node() {
  case $(uname -s) in Linux) os=linux ;; Darwin) os=darwin ;; *) say fail node "wisp can’t install Node.js on $(uname -s). Install Node.js 20 or newer there."; return 1 ;; esac
  case $(uname -m) in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; armv7l) arch=armv7l ;; *) say fail node "wisp can’t install Node.js on $(uname -m). Install Node.js 20 or newer there."; return 1 ;; esac
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then say fail node "This Linux uses musl (Alpine): install Node.js with apk add nodejs npm, then connect again."; return 1; fi
  if command -v curl >/dev/null 2>&1; then get() { curl -fsSL "$1"; }
  elif command -v wget >/dev/null 2>&1; then get() { wget -qO- "$1"; }
  else say fail node "Neither curl nor wget is there to download Node.js. Install Node.js 20 or newer there."; return 1; fi
  base=__DIST__/__LINE__
  say step node run "installing Node.js into ~/.wisp/node (no admin needed)"
  line=$(get "$base/SHASUMS256.txt" 2>/dev/null | grep " node-v[0-9.]*-$os-$arch.tar.gz$")
  [ -n "$line" ] || { say fail node "Couldn’t download Node.js from nodejs.org there. Check its internet connection."; return 1; }
  sum=$(printf '%s' "$line" | cut -d' ' -f1); file=$(printf '%s' "$line" | awk '{print $NF}')
  dl=$HOME/.wisp/node-download; rm -rf "$dl"; mkdir -p "$dl"
  get "$base/$file" > "$dl/$file" 2>/dev/null || { rm -rf "$dl"; say fail node "Downloading Node.js failed. Check that computer’s internet connection."; return 1; }
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$dl/$file"); else got=$(shasum -a 256 "$dl/$file"); fi
  [ "$(printf '%s' "$got" | cut -d' ' -f1)" = "$sum" ] || { rm -rf "$dl"; say fail node "The Node.js download was damaged (its checksum didn’t match). Try again."; return 1; }
  rm -rf "$NODE_HOME.new"; mkdir -p "$NODE_HOME.new"
  tar -xzf "$dl/$file" -C "$NODE_HOME.new" --strip-components=1 2>/dev/null || { rm -rf "$dl" "$NODE_HOME.new"; say fail node "Unpacking Node.js failed."; return 1; }
  rm -rf "$NODE_HOME" "$dl"; mv "$NODE_HOME.new" "$NODE_HOME"
  PATH="$NODE_HOME/bin:$PATH"; export PATH
}
`
    .replace('__DIST__', dist)
    .replace('__LINE__', NODE_LINE);
}

export function bootstrapScript({ port, command, apiVersion, installNode = false }) {
  return String.raw`say() { printf '@@wisp %s\n' "$*"; }
PORT=__PORT__
INSTALL=__INSTALL__
API=__API__
CMD=__CMD__
cd "$HOME" 2>/dev/null # npx would resolve wisp-agents from a package.json in the current folder
say step ssh done "$(uname -sn 2>/dev/null)"
# A non-interactive SSH shell skips the profile that puts node (Homebrew, nvm, Volta…) on PATH.
SH=$SHELL; [ -n "$SH" ] || SH=/bin/sh
LP=$("$SH" -lc 'printf "%s" "$PATH"' </dev/null 2>/dev/null) && [ -n "$LP" ] && PATH="$LP:$PATH"
NVM_BIN=
for d in "$HOME"/.nvm/versions/node/*/bin; do [ -x "$d/node" ] && NVM_BIN=$d; done
[ -n "$NVM_BIN" ] && PATH="$NVM_BIN:$PATH"
PATH="$PATH:$HOME/.local/bin:$HOME/.volta/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin"
__NODE_INSTALL__
[ -x "$NODE_HOME/bin/node" ] && PATH="$NODE_HOME/bin:$PATH" # one wisp installed before
export PATH
node_ok() { command -v node >/dev/null 2>&1 && node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; }
if ! node_ok; then
  if [ "$INSTALL" != 1 ]; then
    if command -v node >/dev/null 2>&1; then say fail node "Node $(node -v 2>/dev/null) is too old: wisp needs 20 or newer."; else say fail node "Node.js isn't installed there (or isn't on PATH)."; fi
    exit 0
  fi
  install_node || exit 0
  node_ok || { say fail node "Node.js was installed but doesn’t run there."; exit 0; }
fi
NV=$(node -v 2>/dev/null)
say step node done "$NV"
health() { node -e 'fetch("http://127.0.0.1:" + process.argv[1] + "/api/health", { signal: AbortSignal.timeout(2500) }).then((r) => r.json().catch(() => ({ name: "other" }))).then((j) => console.log([j.name, j.version, j.apiVersion, j.pid].join(" ")), () => process.exit(1))' "$PORT" 2>/dev/null; }
H=$(health)
if [ -n "$H" ]; then
  set -- $H
  if [ "$1" != wisp ]; then say fail wisp "Port $PORT is used by another program there. Pick another port under Advanced."; exit 0; fi
  if [ "$API" != any ] && [ "$3" != "$API" ]; then say stale "$4"; say fail wisp "wisp $2 is already running there and speaks an older API. Restart it to update."; exit 0; fi
  say step wisp done "already running · $2"
else
  LOG=$WISP_HOME; [ -n "$LOG" ] || LOG=$HOME/.wisp
  mkdir -p "$LOG"; LOG=$LOG/machine.log
  say step wisp run "starting $CMD"
  npm_config_omit=optional nohup sh -c "exec $CMD --no-open --port $PORT" >"$LOG" 2>&1 </dev/null &
  PID=$!
  i=0
  until H=$(health) && [ -n "$H" ]; do
    if ! kill -0 "$PID" 2>/dev/null; then say fail wisp "wisp stopped while starting: $(tail -n 4 "$LOG" | tr '\n' ' ')"; exit 0; fi
    i=$((i+1)); if [ "$i" -ge 330 ]; then say fail wisp "wisp didn't answer within 5 minutes: $(tail -n 4 "$LOG" | tr '\n' ' ')"; exit 0; fi
    sleep 1
  done
  set -- $H
  say step wisp done "started · $2"
fi
say ready "$2" "$4"
exec cat >/dev/null
`
    .replace('__NODE_INSTALL__', nodeInstallScript())
    .replace('__INSTALL__', installNode ? '1' : '0')
    .replace('__PORT__', String(port))
    .replace('__API__', String(apiVersion))
    .replace('__CMD__', shq(command));
}
