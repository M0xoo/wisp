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
