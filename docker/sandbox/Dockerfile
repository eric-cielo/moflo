# MoFlo Spell Sandbox Image
#
# Pre-installs Claude Code CLI and GitHub CLI so spell steps that invoke
# `claude -p` or `gh` work inside Docker sandboxing on Windows.
#
# Base: node:20-bookworm (Debian 12) — same as the previous default image,
# so git, npm, and common POSIX tools are already present.
#
# Published to: ghcr.io/eric-cielo/moflo-sandbox
#
# Rebuild:
#   docker build -t ghcr.io/eric-cielo/moflo-sandbox:latest docker/sandbox/
#   docker push ghcr.io/eric-cielo/moflo-sandbox:latest

FROM node:20-bookworm

# ── GitHub CLI ────────────────────────────────────────────────────────────
# https://github.com/cli/cli/blob/trunk/docs/install_linux.md
RUN apt-get update \
 && apt-get install -y --no-install-recommends gpg \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/*

# ── Claude Code CLI ──────────────────────────────────────────────────────
RUN npm install -g @anthropic-ai/claude-code

# Verify both tools are on PATH
RUN claude --version && gh --version && git --version

WORKDIR /workspace
