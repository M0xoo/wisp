#!/usr/bin/env bash
# wisp installer. Served from https://trywisp.dev/install.sh:
#
#   curl -fsSL https://trywisp.dev/install.sh | bash
#
# It checks for Node.js 20+ and npm, installs wisp-agents globally from npm, and confirms that
# the `wisp` command is on PATH. Set WISP_VERSION to pin a release (default: latest); it goes on
# the bash side of the pipe: curl -fsSL https://trywisp.dev/install.sh | WISP_VERSION=0.46.0 bash
# WISP_VERSION=next takes the beta and WISP_VERSION=nightly last night's build of main (npm's dist-tags).
#
# With --app (macOS) it installs the desktop app instead, no Node needed:
#
#   curl -fsSL https://trywisp.dev/install.sh | bash -s -- --app
#
# It downloads wisp.app from the GitHub release, checks it against the release's SHA256SUMS.txt
# and puts it in /Applications (~/Applications when that isn't writable). A download made by curl
# isn't quarantined, so macOS opens it without the "can't verify" warning a browser download of
# the not yet notarized app gets.
set -euo pipefail

PACKAGE="wisp-agents"
VERSION="${WISP_VERSION:-latest}"
APP=0
for arg in "$@"; do
  case "$arg" in
    --app) APP=1 ;;
    *) printf 'error: unknown option %s (try --app)\n' "$arg" >&2; exit 1 ;;
  esac
done

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# The desktop app, from the release's .zip (the same build the app updates itself from).
install_app() {
  [ "$(uname -s)" = Darwin ] \
    || die "--app installs the macOS app. On Linux, download the AppImage or .deb from https://github.com/M0xoo/wisp/releases/latest"
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) die "no wisp app for this Mac ($(uname -m))" ;;
  esac
  local base zip want got dest # tmp stays global: the EXIT trap reads it
  if [ "$VERSION" = latest ]; then base="https://github.com/M0xoo/wisp/releases/latest/download"
  elif [ "$VERSION" = nightly ]; then base="https://github.com/M0xoo/wisp/releases/download/nightly"
  else base="https://github.com/M0xoo/wisp/releases/download/v${VERSION#v}"; fi
  base="${WISP_DOWNLOADS:-$base}" # tests point this at a folder
  zip="wisp-mac-$arch.zip"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  say "Downloading $zip ($VERSION)"
  curl -fL --progress-bar -o "$tmp/$zip" "$base/$zip" || die "couldn't download $base/$zip"
  curl -fsSL -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" || die "couldn't download $base/SHA256SUMS.txt"
  want="$(awk -v f="$zip" '$2 == f { print $1 }' "$tmp/SHA256SUMS.txt")"
  got="$(shasum -a 256 "$tmp/$zip" | cut -d' ' -f1)"
  [ -n "$want" ] && [ "$want" = "$got" ] || die "$zip doesn't match the release's SHA256SUMS.txt; not installing it"
  ditto -xk "$tmp/$zip" "$tmp/out" || die "couldn't unpack $zip"
  [ -d "$tmp/out/wisp.app" ] || die "$zip has no wisp.app in it"

  dest="${WISP_APP_DIR:-/Applications}"
  if [ -z "${WISP_APP_DIR:-}" ] && [ ! -w "$dest" ]; then dest="$HOME/Applications"; fi
  mkdir -p "$dest"
  # A running wisp keeps working from the old copy until it restarts.
  rm -rf "$dest/wisp.app"
  mv "$tmp/out/wisp.app" "$dest/wisp.app"
  say "Installed $dest/wisp.app"
  [ -n "${WISP_NO_OPEN:-}" ] || open "$dest/wisp.app" || true

  cat <<'EOF'

wisp is in your Applications folder and updates itself from there.
You also need at least one agent CLI installed and signed in (Claude Code, Codex, opencode, ...).
EOF
}

if [ "$APP" = 1 ]; then
  install_app
  exit 0
fi

case "$(uname -s)" in
  Darwin | Linux) ;;
  *) die "this installer covers macOS and Linux. On Windows, download the app from https://trywisp.dev/#install or run: npm install -g wisp-agents" ;;
esac

command -v node >/dev/null 2>&1 \
  || die "Node.js 20+ is required but node was not found. Install it from https://nodejs.org (or 'brew install node'), then run this again."
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 20 ] \
  || die "Node.js 20+ is required, found $(node -v). Upgrade Node.js, then run this again."
command -v npm >/dev/null 2>&1 || die "npm was not found. It ships with Node.js; reinstall Node.js and run this again."

say "Installing $PACKAGE@$VERSION with npm (Node $(node -v))"
if ! npm install -g "$PACKAGE@$VERSION"; then
  die "npm install failed. On a permissions error, point npm at a folder you own: https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally"
fi

if command -v wisp >/dev/null 2>&1; then
  say "Installed wisp $(wisp --version)"
else
  bin_dir="$(npm prefix -g)/bin"
  die "installed, but 'wisp' is not on your PATH. Add $bin_dir to PATH (for example in ~/.zshrc), then open a new terminal."
fi

cat <<'EOF'

Next steps:
  wisp                                  open the desktop app
  wisp "fix the flaky auth test"        launch a task in the current folder
  wisp --browser                        use it in the browser at http://localhost:4477

You also need at least one agent CLI installed and signed in (Claude Code, Codex, opencode, ...).
EOF
