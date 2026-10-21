# One user's wisp, as wisp Grid's container driver runs it (grid/hostd.js containerRun).
# Build from the repo root:  docker build -f grid/deploy/image/Dockerfile -t wisp-grid-user .
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

COPY package.json /opt/wisp/
COPY bin /opt/wisp/bin
COPY server /opt/wisp/server
COPY web /opt/wisp/web
COPY skills /opt/wisp/skills

# uid 1000 (the image's "node" user), home on the user's own folder from the host.
RUN usermod -d /home/wisp node && mkdir -p /home/wisp && chown node:node /home/wisp
USER node
ENV HOME=/home/wisp
WORKDIR /home/wisp
