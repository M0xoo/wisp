// The script that starts wisp on a machine over `ssh … sh -s` and reports each step back.

import { shq } from '../util.js';

// What runs on the machine. Sent on stdin, so the login shell there (bash, zsh, fish…) only ever
// sees `sh -s`. Steps come back as `@@wisp step <id> <run|done> <detail>`, `@@wisp fail <id>
// <message>`, and finally `@@wisp ready <version> <pid>`; then `cat` holds the session (and the
// tunnel) open until this side lets go.
export function bootstrapScript({ port, command, apiVersion }) {
  return String.raw`say() { printf '@@wisp %s\n' "$*"; }
PORT=__PORT__
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
export PATH
if ! command -v node >/dev/null 2>&1; then say fail node "Node.js isn't installed there (or isn't on PATH)."; exit 0; fi
NV=$(node -v 2>/dev/null)
if ! node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null; then say fail node "Node $NV is too old: wisp needs 20 or newer."; exit 0; fi
say step node done "$NV"
health() { node -e 'fetch("http://127.0.0.1:" + process.argv[1] + "/api/health", { signal: AbortSignal.timeout(2500) }).then((r) => r.json().catch(() => ({ name: "other" }))).then((j) => console.log([j.name, j.version, j.apiVersion, j.pid].join(" ")), () => process.exit(1))' "$PORT" 2>/dev/null; }
H=$(health)
if [ -n "$H" ]; then
  set -- $H
  if [ "$1" != wisp ]; then say fail wisp "Port $PORT is used by another program there. Pick another port under Advanced."; exit 0; fi
  if [ "$3" != "$API" ]; then say stale "$4"; say fail wisp "wisp $2 is already running there and speaks an older API. Restart it to update."; exit 0; fi
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
    .replace('__PORT__', String(port))
    .replace('__API__', String(apiVersion))
    .replace('__CMD__', shq(command));
}
