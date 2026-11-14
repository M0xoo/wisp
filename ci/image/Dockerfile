# wisp for CI and any container (ADR-0040): `docker run --rm -v "$PWD:/work" -e ANTHROPIC_API_KEY ghcr.io/wispagents/wisp
# "fix the failing test"`. wisp, git and gh; runs as a user, not root; the entrypoint is wisp.
FROM node:22-bookworm-slim
ARG WISP_VERSION=latest
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl jq gh \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g "wisp-agents@${WISP_VERSION}" \
 && npm cache clean --force
RUN useradd --create-home --uid 1001 wisp
USER wisp
WORKDIR /work
ENV WISP_UPDATE_CHECK=0
ENTRYPOINT ["wisp"]
CMD ["--help"]
