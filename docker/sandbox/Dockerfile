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
#   Automated — pushes to `main` that touch `docker/sandbox/**` rebuild and
#   publish `:latest` + `:sha-<short>` via `.github/workflows/sandbox-image.yml`.
#   Manual `workflow_dispatch` can publish preview tags from any branch.
#
#   Local testing only:
#     docker build -t ghcr.io/eric-cielo/moflo-sandbox:latest docker/sandbox/
#     docker push ghcr.io/eric-cielo/moflo-sandbox:latest

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

# ── Non-root runtime user ────────────────────────────────────────────────
# node:20-bookworm ships a `node` user (uid 1000). Claude Code CLI refuses
# to run as root when --dangerously-skip-permissions is set, so switch
# before ENTRYPOINT. Pre-create /workspace and tool-home subdirs so
# bind-mounts land on node-owned paths instead of root-owned mountpoints.
RUN mkdir -p /workspace \
      /home/node/.claude \
      /home/node/.config/gh \
      /home/node/.npm \
      /home/node/.cache \
      /home/node/.local/share \
      /home/node/.local/state \
      /opt/fastembed-cache \
 && chown -R node:node /workspace /home/node /opt/fastembed-cache

# ── Git safe.directory ───────────────────────────────────────────────────
# Windows Docker Desktop bind-mounts expose /workspace with uid 0 or a uid
# that doesn't match the container's `node` user (1000). Git 2.35+ refuses
# to operate on repos owned by other users unless they're in safe.directory.
# Set this at /etc/gitconfig (system level) so the `node` user's own
# .gitconfig bind-mount (from the host via tool-home mounts) doesn't
# override it. `*` is appropriate for a sandbox image that only ever sees
# bind-mounted project dirs.
RUN git config --system --add safe.directory '*'

# ── Fastembed model cache (baked) ────────────────────────────────────────
# Bake the default all-MiniLM-L6-v2 model so sandboxed spell steps work
# with `--network none` and avoid re-downloading the ~90 MB ONNX model
# per container boot. `/opt/fastembed-cache` is not under `/home/node/.cache`,
# so the elevated/autonomous `.cache` tool-home bind mount does not shadow
# it. FASTEMBED_CACHE is read by FastembedEmbeddingService as the cacheDir
# fallback when no explicit cacheDir is configured.
ENV FASTEMBED_CACHE=/opt/fastembed-cache
USER node
# Pre-warm the model directly from Qdrant's GCS bucket — the same source the
# in-tree fastembed replacement uses. Avoids installing the upstream `fastembed`
# package (and its onnxruntime-node@1.21.0 transitive pin) in the image.
# Cache layout matches `fastembed-inline/model-loader.ts`: `<cacheDir>/<model>/`.
RUN set -e \
 && mkdir -p "$FASTEMBED_CACHE" \
 && curl -fsSL https://storage.googleapis.com/qdrant-fastembed/sentence-transformers-all-MiniLM-L6-v2.tar.gz \
      -o "$FASTEMBED_CACHE/model.tar.gz" \
 && tar -xzf "$FASTEMBED_CACHE/model.tar.gz" -C "$FASTEMBED_CACHE" \
 && rm "$FASTEMBED_CACHE/model.tar.gz" \
 && test -f "$FASTEMBED_CACHE/fast-all-MiniLM-L6-v2/model.onnx"

WORKDIR /workspace
