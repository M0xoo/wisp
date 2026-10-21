#!/bin/sh
# Rules for the users' containers (network wisp-users, bridge br-wisp), applied before the grid
# starts (wisp-grid.service ExecStartPre). Idempotent.
set -e
docker network inspect wisp-users >/dev/null 2>&1 || docker network create --driver bridge \
  -o com.docker.network.bridge.enable_icc=false -o com.docker.network.bridge.name=br-wisp wisp-users >/dev/null
add() { iptables -C "$@" 2>/dev/null || iptables -I "$@"; }
# No cloud metadata (it can hand out the server's own credentials).
add DOCKER-USER -i br-wisp -d 169.254.169.254 -j DROP
# Nothing on the host itself (the grid, other users' published ports, SSH): only the internet.
# Replies to connections the host opened (Docker's port proxy reaching the user's wisp) still pass.
add INPUT -i br-wisp -j DROP
add INPUT -i br-wisp -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# No mail servers (spam from a hijacked agent gets the server's IP blocked).
add DOCKER-USER -i br-wisp -p tcp --dport 25 -j DROP
