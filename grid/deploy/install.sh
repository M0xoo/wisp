#!/bin/sh
# Set up wisp Grid on a fresh Debian 12 / Ubuntu 24.04 server, as root:
#   DOMAIN=wisp.example.com ./install.sh          (run from a copy of the wisp repo)
# Installs Node 22, Docker with gVisor (runsc), Caddy; builds the user image; makes the "wisp"
# system user (not in the docker group: boxd runs the containers for it), /var/lib/wisp-grid,
# boxd and the grid's services, and the Caddyfile.
set -eu
: "${DOMAIN:?DOMAIN=wisp.example.com}"
REPO=$(cd "$(dirname "$0")/../.." && pwd)
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -y -q ca-certificates curl gnupg iptables debian-keyring debian-archive-keyring apt-transport-https

# Node.js 22
if ! node -v 2>/dev/null | grep -q '^v2[2-9]'; then
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

docker build -q -f "$REPO/grid/deploy/image/Dockerfile" -t wisp-grid-user "$REPO"
"$REPO/grid/deploy/firewall.sh"

# boxd runs this checkout's grid/boxd.js as root: nobody but root may be able to change it.
[ "$(stat -c %u "$REPO/grid/boxd.js")" = 0 ] && [ "$(stat -c %u "$REPO/grid")" = 0 ] ||
  echo "! $REPO isn't root's: boxd runs its code as root, so chown -R root: it (or copy it to /opt/wisp-grid)." >&2
sed "s#/opt/wisp-grid#$REPO#g" "$REPO/grid/deploy/wisp-grid-boxd.service" > /etc/systemd/system/wisp-grid-boxd.service
systemctl daemon-reload
systemctl enable --now wisp-grid-boxd

sed "s#wisp.example.com#$DOMAIN#g" "$REPO/grid/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

sed -e "s#/usr/bin/npx -y wisp-agents#/usr/bin/node $REPO/bin/wisp.js#" \
    -e "s#^ExecStart=#ExecStartPre=+$REPO/grid/deploy/firewall.sh\nExecStart=#" \
    "$REPO/grid/deploy/wisp-grid.service" > /etc/systemd/system/wisp-grid.service
systemctl daemon-reload
echo "Installed. Next: sudo -u wisp node $REPO/bin/wisp.js grid init --domain $DOMAIN --data /var/lib/wisp-grid, then set up sign-in in grid.json, then systemctl enable --now wisp-grid"
