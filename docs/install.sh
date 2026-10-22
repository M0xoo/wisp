#!/usr/bin/env bash
# wisp installer. Served from https://trywisp.dev/install.sh:
#
#   curl -fsSL https://trywisp.dev/install.sh | bash
#
# It checks for Node.js 20+ and npm, installs wisp-agents globally from npm, and confirms that
# the `wisp` command is on PATH. Set WISP_VERSION to pin a release (default: latest); it goes on
# the bash side of the pipe: curl -fsSL https://trywisp.dev/install.sh | WISP_VERSION=0.30.3 bash
set -euo pipefail

PACKAGE="wisp-agents"
VERSION="${WISP_VERSION:-latest}"

say() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin | Linux) ;;
  *) die "this installer covers macOS and Linux. On Windows run: npm install -g wisp-agents" ;;
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
