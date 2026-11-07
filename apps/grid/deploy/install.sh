#!/bin/sh
# Set up wisp Grid on a fresh Debian 12 / Ubuntu 24.04 server, as root:
#   DOMAIN=wisp.example.com apps/grid/deploy/install.sh   (run from a copy of the wisp repo)
# Installs Node 22 (22.18+: it runs the grid's .ts directly), Docker with gVisor (runsc), Caddy; builds the user image; makes the "wisp"
# system user (not in the docker group: boxd runs the containers for it), /var/lib/wisp-grid,
# boxd and the grid's services, and the Caddyfile.
set -eu
: "${DOMAIN:?DOMAIN=wisp.example.com}"
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
DEPLOY="$REPO/apps/grid/deploy"
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q ca-certificates curl gnupg iptables debian-keyring debian-archive-keyring apt-transport-https

# Node.js 22
# 22.18 or newer: Node runs the grid's TypeScript as it is, with no build step.
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -q nodejs
fi

# Docker
command -v docker >/dev/null || { curl -fsSL https://get.docker.com | sh; }

# gVisor: a user-space kernel for each user's container
if ! command -v runsc >/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
  apt-get update -q && apt-get install -y -q runsc
  runsc install
  systemctl restart docker
fi

# Caddy
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q && apt-get install -y -q caddy
fi

# A little swap: agents' builds spike memory
if [ ! -f /swapfile ]; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# The grid's own user: a system account, so not uid 1000 (the boxes' user), and not in the docker
# group (that is root in effect): boxd, below, runs the boxes for it.
id wisp >/dev/null 2>&1 || useradd --system --create-home --home-dir /home/wisp --shell /bin/bash wisp
mkdir -p /var/lib/wisp-grid && chown wisp:wisp /var/lib/wisp-grid

# The box image runs apps/server's bundle (the published wisp-agents): build it first.
(cd "$REPO" && npm ci --no-audit --no-fund && npm run build)
docker build -q -f "$DEPLOY/image/Dockerfile" -t wisp-grid-user "$REPO"
"$DEPLOY/firewall.sh"

# boxd runs this checkout's apps/grid/src/boxd.ts as root: nobody but root may be able to change it.
[ "$(stat -c %u "$REPO/apps/grid/src/boxd.ts")" = 0 ] && [ "$(stat -c %u "$REPO/apps/grid/src")" = 0 ] && [ "$(stat -c %u "$REPO/apps/grid")" = 0 ] ||
  echo "! $REPO isn't root's: boxd runs its code as root, so chown -R root: it (or copy it to /opt/wisp-grid)." >&2
sed "s#/opt/wisp-grid#$REPO#g" "$DEPLOY/wisp-grid-boxd.service" > /etc/systemd/system/wisp-grid-boxd.service
systemctl daemon-reload
systemctl enable --now wisp-grid-boxd

sed "s#wisp.example.com#$DOMAIN#g" "$DEPLOY/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

sed -e "s#/opt/wisp-grid#$REPO#g" \
    -e "s#^ExecStart=#ExecStartPre=+$DEPLOY/firewall.sh\nExecStart=#" \
    "$DEPLOY/wisp-grid.service" > /etc/systemd/system/wisp-grid.service
systemctl daemon-reload
echo "Installed. Next: sudo -u wisp node $REPO/apps/grid/src/main.ts init --domain $DOMAIN --data /var/lib/wisp-grid, then set up sign-in in grid.json, then systemctl enable --now wisp-grid"
