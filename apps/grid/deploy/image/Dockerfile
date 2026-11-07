# One user's wisp, as wisp Grid's container driver runs it (apps/grid/src/boxd.ts containerRun):
# apps/server's bundle (the published wisp-agents, plain JS with no runtime dependencies), which the
# grid starts with WISP_GROUP=box, so it runs the BoxPlugins group (apps/server/src/groups.ts).
# Build from the repo root, after the bundle:
#   npm run build && docker build -f apps/grid/deploy/image/Dockerfile -t wisp-grid-user .
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep python3 openssh-client procps less \
 && rm -rf /var/lib/apt/lists/*

# GitHub CLI: Ship it pushes and opens pull requests with it; each person signs in from Settings → Agents.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*

# The agents. Each person signs in to theirs inside their own wisp (or uses opencode's free models).
RUN npm install -g @anthropic-ai/claude-code @openai/codex opencode-ai && npm cache clean --force

# Cursor, Grok and Antigravity only ship install scripts that write to $HOME, which is the user's
# own folder at run time. Install them under /opt (read-only for the user) and put them on PATH.
RUN mkdir -p /opt/agents \
 && HOME=/opt/agents bash -c 'curl -fsSL https://cursor.com/install | bash' \
 && HOME=/opt/agents bash -c 'curl -fsSL https://x.ai/cli/install.sh | bash' \
 && HOME=/opt/agents bash -c 'curl -fsSL https://antigravity.google/cli/install.sh | bash -s -- --dir /opt/agents/bin' \
 && ln -sf "$(readlink -f /opt/agents/.local/bin/cursor-agent)" /usr/local/bin/cursor-agent \
 && ln -sf "$(readlink -f /opt/agents/.grok/bin/grok)" /usr/local/bin/grok \
 && ln -sf /opt/agents/bin/agy /usr/local/bin/agy \
 && rm -rf /opt/agents/.cache /opt/agents/.bashrc /opt/agents/.profile \
 && chmod -R a+rX /opt/agents \
 && cursor-agent --version && grok --version && agy --version

# A browser agents drive and you watch (wisp-desktop: Xvfb, Chromium, noVNC on 6080), Playwright's
# MCP server for it (wisp-browser-mcp, the Browser connector in a sandbox), pip, and sudo. sudo only
# works in a sandbox: boxd starts one as root under gVisor (wisp-sandbox-init), whose root helper
# (rootd.mjs) is what this sudo talks to; gVisor doesn't honour setuid binaries. A cloud computer's
# box has no helper, no capabilities and no-new-privileges.
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium xvfb x11vnc x11-xserver-utils xdotool novnc websockify fonts-liberation fonts-noto-core fonts-wqy-microhei fonts-noto-color-emoji python3-pip python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix
RUN npm install -g @playwright/mcp && npm cache clean --force && command -v playwright-mcp
# apt and apt-get remember what a sandbox installs (secure_path puts /usr/local/sbin first under sudo).
COPY apps/grid/deploy/image/sandbox/apt apps/grid/deploy/image/sandbox/apt-get /usr/local/sbin/
COPY apps/grid/deploy/image/sandbox/wisp-desktop apps/grid/deploy/image/sandbox/wisp-browser-mcp apps/grid/deploy/image/sandbox/sudo /usr/local/bin/
COPY apps/grid/deploy/image/sandbox/wisp-sandbox-init /usr/local/sbin/
COPY apps/grid/deploy/image/sandbox/rootd.mjs /usr/local/lib/wisp/
COPY apps/grid/deploy/image/sandbox/wisp.html /usr/share/novnc/
# What the agent installs without root lands in the home, which stays: npm -g, pip.
ENV NPM_CONFIG_PREFIX=/home/wisp/.local PIP_USER=1 PIP_BREAK_SYSTEM_PACKAGES=1 PATH=/home/wisp/.local/bin:$PATH

# The bundle tools/bundle.ts writes (bin/wisp.js, the web page, skills): /opt/wisp/bin/wisp.js is what
# boxd's `docker run` starts (BOX_ENTRY).
COPY apps/server/dist /opt/wisp
# A box runs the BoxPlugins group whoever starts it (hostd sets it too).
ENV WISP_GROUP=box

# uid 1000 (the image's "node" user), home on the user's own folder from the host.
RUN usermod -d /home/wisp node && mkdir -p /home/wisp && chown node:node /home/wisp
USER node
ENV HOME=/home/wisp
WORKDIR /home/wisp
