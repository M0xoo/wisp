say() { printf '@@wisp %s\n' "$*"; }
# wisp's remote bootstrap (plugins/machines/core/src/bootstrap.rs fills the placeholder fields below; the phone app
# loads this same file). Sent on stdin to `ssh … sh -s`, so the login shell there (bash, zsh, fish…)
# only ever sees `sh -s`. Steps come back as `@@wisp step <id> <run|done|warn> <detail>`, `@@wisp fail
# <id> <message>`, `@@wisp stale <pid>`, and finally `@@wisp ready <version> <pid>`; then `cat` holds
# the session (and the tunnel) open until this side lets go. API `any` takes whichever wisp already
# runs there; a number is the lowest protocol this side speaks.
PORT=__PORT__
INSTALL=__INSTALL__
API=__API__
VERSION=__VERSION__
DIST=__DIST__
CMD=__CMD__
cd "$HOME" 2>/dev/null # wisp started from the login folder would take a project there for its own
say step ssh done "$(uname -sn 2>/dev/null)"
# A non-interactive SSH shell skips the profile that puts things on PATH (Homebrew, nvm, Volta…),
# where an npm-installed wisp lives.
SH=$SHELL; [ -n "$SH" ] || SH=/bin/sh
LP=$("$SH" -lc 'printf "%s" "$PATH"' </dev/null 2>/dev/null) && [ -n "$LP" ] && PATH="$LP:$PATH"
NVM_BIN=
for d in "$HOME"/.nvm/versions/node/*/bin; do [ -x "$d/node" ] && NVM_BIN=$d; done
[ -n "$NVM_BIN" ] && PATH="$NVM_BIN:$PATH"
PATH="$PATH:$HOME/.local/bin:$HOME/.volta/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin"
WISP_DIR=$HOME/.wisp/bin/$VERSION
export PATH WISP_DIR
if command -v curl >/dev/null 2>&1; then
  get() { curl -fsSL "$1"; }
  probe() { curl -s --max-time 3 "$1"; }
elif command -v wget >/dev/null 2>&1; then
  get() { wget -qO- "$1"; }
  probe() { wget -qO- -T 3 "$1"; rc=$?; [ "$rc" = 8 ] && return 0; return "$rc"; } # 8: it answered, with an error
fi
# One top-level field of a flat JSON answer, without a JSON parser: split at , { } and read the key.
field() { tr ',{}' '\n\n\n' | sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\"]*\)\"\{0,1\}[[:space:]]*\$/\1/p" | head -n 1; }
# "<name> <version> <proto> <pid>" of whatever answers on PORT, or nothing (exit 1) when nothing does.
health() {
  if command -v probe >/dev/null 2>&1; then J=$(probe "http://127.0.0.1:$PORT/api/health" 2>/dev/null) || return 1
  elif [ -x "$WISP_DIR/wisp" ]; then J=$("$WISP_DIR/wisp" health --port "$PORT" 2>/dev/null) || return 1
  else return 1; fi
  N=$(printf '%s' "$J" | field name); [ -n "$N" ] || N=other
  V=$(printf '%s' "$J" | field version)
  P=$(printf '%s' "$J" | field proto_max); [ -n "$P" ] || P=$(printf '%s' "$J" | field apiVersion)
  case $P in '' | *[!0-9]*) P=1 ;; esac
  I=$(printf '%s' "$J" | field pid)
  printf '%s %s %s %s\n' "$N" "${V:--}" "$P" "${I:-0}"
}
sha() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1"; fi | cut -d' ' -f1; }
# wisp's binary for this system into ~/.wisp/bin/<version>: checked against the release's SHA-256,
# no admin rights, nothing else touched.
install_wisp() {
  case $(uname -s) in Linux) os=linux ;; Darwin) os=darwin ;; *) say fail install "wisp can’t install itself on $(uname -s). Install wisp there by hand."; return 1 ;; esac
  case $(uname -m) in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) say fail install "wisp can’t install itself on $(uname -m). Install wisp there by hand."; return 1 ;; esac
  if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then say fail install "This Linux uses musl (Alpine), which wisp’s download doesn’t run on. Install wisp there by hand, then connect again."; return 1; fi
  command -v get >/dev/null 2>&1 || { say fail install "Neither curl nor wget is there to download wisp. Install one of them, or wisp itself, there."; return 1; }
  file=wisp-bin-$os-$arch.tar.gz
  say step install run "downloading wisp $VERSION into ~/.wisp/bin (no admin needed)"
  line=$(get "$DIST/SHA256SUMS.txt" 2>/dev/null | grep " \*\{0,1\}$file\$")
  [ -n "$line" ] || { say fail install "Couldn’t download wisp $VERSION there. Check that computer’s internet connection."; return 1; }
  sum=$(printf '%s' "$line" | cut -d' ' -f1)
  dl=$HOME/.wisp/bin/download; rm -rf "$dl"; mkdir -p "$dl"
  get "$DIST/$file" >"$dl/$file" 2>/dev/null || { rm -rf "$dl"; say fail install "Downloading wisp failed. Check that computer’s internet connection."; return 1; }
  [ "$(sha "$dl/$file")" = "$sum" ] || { rm -rf "$dl"; say fail install "The wisp download was damaged (its checksum didn’t match). Try again."; return 1; }
  rm -rf "$WISP_DIR.new"; mkdir -p "$WISP_DIR.new"
  tar -xzf "$dl/$file" -C "$WISP_DIR.new" 2>/dev/null && [ -x "$WISP_DIR.new/wisp" ] || { rm -rf "$dl" "$WISP_DIR.new"; say fail install "Unpacking wisp failed."; return 1; }
  rm -rf "$WISP_DIR" "$dl"; mv "$WISP_DIR.new" "$WISP_DIR"
}
H=$(health)
if [ -n "$CMD" ]; then say step install done "your start command"
elif [ -x "$WISP_DIR/wisp" ]; then say step install done "wisp $VERSION"
elif [ -n "$H" ]; then say step install done "not needed: something answers on $PORT"
elif [ "$INSTALL" = 1 ]; then install_wisp || exit 0; say step install done "wisp $VERSION"
else say fail install "wisp isn’t installed there."; exit 0
fi
[ -n "$CMD" ] || CMD='"$WISP_DIR/wisp"'
if [ -n "$H" ]; then
  set -- $H
  if [ "$1" != wisp ]; then say fail wisp "Port $PORT is used by another program there. Pick another port under Advanced."; exit 0; fi
  if [ "$API" != any ] && [ "$3" -lt "$API" ]; then say stale "$4"; say fail wisp "wisp $2 is already running there and speaks an older protocol. Restart it to update."; exit 0; fi
  say step wisp done "already running · $2"
else
  LOG=$WISP_HOME; [ -n "$LOG" ] || LOG=$HOME/.wisp
  mkdir -p "$LOG"; LOG=$LOG/machine.log
  say step wisp run "starting wisp $VERSION"
  nohup sh -c "exec $CMD --no-open --port $PORT" >"$LOG" 2>&1 </dev/null &
  PID=$!
  i=0
  until H=$(health) && [ -n "$H" ]; do
    if ! kill -0 "$PID" 2>/dev/null; then say fail wisp "wisp stopped while starting: $(tail -n 4 "$LOG" | tr '\n' ' ')"; exit 0; fi
    i=$((i + 1)); if [ "$i" -ge 330 ]; then say fail wisp "wisp didn't answer within 5 minutes: $(tail -n 4 "$LOG" | tr '\n' ' ')"; exit 0; fi
    sleep 1
  done
  set -- $H
  say step wisp done "started · $2"
fi
say ready "$2" "$4"
exec cat >/dev/null
