# syntax=docker/dockerfile:1.6
#
# Multi-stage Dockerfile for pi-forge.
#
#   builder  → install deps, compile server TS, build Vite client
#   runtime  → node:22-bookworm-slim with Python 3.12 + pip, compiled
#              output, and hoisted node_modules. The server runs as root
#              so the opt-in identity sandbox can drop tool processes to
#              the restricted pi-tools UID/GID.
#
# Why bookworm-slim and not alpine: the Node native-module ecosystem
# (node-pty, bcrypt, sharp, better-sqlite3, …) ships prebuilt binaries
# against glibc. On musl/alpine, prebuild-install can't find a matching
# binary and falls back to a source build, which both slows the image
# build and breaks any package without source-build support. The image
# is ~80 MB larger than alpine; in exchange we get faster builds, fewer
# native-module footguns, and a friendlier interactive shell for the
# integrated terminal (bash + readline + a real coreutils).

# ---------- shared Node + Python base ----------
FROM python:3.12-slim-bookworm AS python-base

FROM node:22-bookworm-slim AS node-python-base

# Keep the final image lineage on the official Node image — pi-forge is a
# Node app, so preserving Node/npm/corepack exactly as shipped is more
# important than preserving the Python image as the final base. Copy the
# official Python 3.12 runtime into /usr/local (Docker COPY merges into
# the existing Node-owned tree without deleting Node/npm/corepack) and
# install the Debian runtime libraries CPython extension modules commonly
# link against.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      libbz2-1.0 \
      libexpat1 \
      libffi8 \
      libgdbm-compat4 \
      liblzma5 \
      libncursesw6 \
      libreadline8 \
      libsqlite3-0 \
      libssl3 \
      libuuid1 \
      zlib1g \
 && rm -rf /var/lib/apt/lists/*
COPY --from=python-base /usr/local/ /usr/local/
RUN ln -sf /usr/local/bin/python3 /usr/local/bin/python \
 && ln -sf /usr/local/bin/python3 /usr/local/bin/py \
 && ldconfig \
 && node --version \
 && npm --version \
 && python3 --version \
 && pip3 --version

# ---------- builder ----------
FROM node-python-base AS builder

# Native deps for node-pty (Phase 11 will use it; the dep is already in
# server/package.json, so install needs the toolchain regardless). On
# bookworm-slim, node-pty's prebuilds usually cover the linux-x64 and
# linux-arm64 paths — but we keep the toolchain so a source build still
# works on platforms without a prebuild, and so any other native module
# pulled in transitively still installs cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy lockfiles + workspace manifests first so dependency installs are
# cached on source-only changes.
COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

# `npm ci --workspaces` honours the root lockfile across all packages.
RUN npm ci --workspaces --include-workspace-root

# Now bring in the source and build.
COPY . .

RUN npm run build

# ---------- runtime ----------
FROM node-python-base AS runtime

# `tini` for proper PID-1 signal handling (Ctrl-C → SIGTERM → graceful
# shutdown of pi-forge's onClose hook). Without it, dropped SIGTERMs
# leave SSE clients hanging on `docker compose down`.
#
# PUID/PGID build args let the legacy `pi` user match the host owner of
# mounted config/data directories. PTOOLS_UID/PTOOLS_GID create the
# restricted `pi-tools` identity used by AGENT_TOOL_SANDBOX_ENABLED.
# Override at build time when your host bind mounts require different
# ownership:
#   docker compose build --build-arg PUID=$(id -u) --build-arg PGID=$(id -g)
ARG PUID=1000
ARG PGID=1000
ARG PTOOLS_UID=1001
ARG PTOOLS_GID=1001

# Some upstream base images have shipped a pre-baked `node` user/group
# at UID/GID 1000 — the same default we want for `pi`. Drop it before
# creating `pi` if present; `|| true` keeps the build green on bases
# without that user.
#
# Runtime tools the agent + interactive terminal need:
#   - tini: PID-1 signal handling (see above)
#   - git: status / diff / commit / push / etc. — the GitPanel routes
#     and the agent's `bash` tool both expect git on PATH. Also used by
#     pi-forge's "clone repository" project-setup flow.
#   - gh: the GitHub CLI. Authenticates against github.com / GHE via
#     `gh auth login` (more ergonomic than wrangling raw PATs / SSH
#     keys), wraps git for HTTPS clones with stored credentials, and
#     gives the agent + interactive terminal a first-class surface for
#     `gh pr`, `gh issue`, `gh repo`, etc. Not in Debian's default
#     repos — installed from GitHub's apt source (the keyring and
#     sources.list lines below).
#   - ripgrep: pi's `grep` tool delegates to ripgrep when present.
#     Without it, code search inside the agent silently degrades.
#   - bash: replaces dash as the integrated terminal's interactive
#     shell. node-pty defaults to /bin/sh; we set SHELL=/bin/bash
#     below so xterm sessions land in bash with readline + history +
#     the prompt expansions users expect.
#   - curl, ca-certificates, less, procps: minimum interactive-terminal
#     hygiene. curl for fetching, ca-certificates so HTTPS works, less
#     so `git log` and similar pagers don't bomb, procps so `ps`/`top`
#     are present for users debugging long-running tool processes.
#   - python3/pip3: Python 3.12 package tooling from the official
#     Python image. `python` and `py` are aliases for `python3`.
#   - make, g++: native-module rebuild toolchain for people using the
#     container as a development environment. `npm install` can rebuild
#     node-pty when the mounted checkout's lockfile / Node ABI differs
#     from the baked image; without Python node-gyp fails before it can
#     compile the binding.
#   - gnupg: needed only to verify the GitHub CLI apt-source signing
#     key during install — kept in the same RUN so the keyring is
#     present when `apt-get install gh` runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini gosu git ripgrep bash curl ca-certificates less procps make g++ gnupg \
 && install -dm 0755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && (userdel node 2>/dev/null || true) \
 && (groupdel node 2>/dev/null || true) \
 && groupadd -g $PGID pi \
 && useradd -m -u $PUID -g $PGID -s /bin/bash pi \
 && groupadd -g $PTOOLS_GID pi-tools \
 && useradd -M -u $PTOOLS_UID -g $PTOOLS_GID -s /usr/sbin/nologin pi-tools \
 && usermod -aG pi-tools pi

WORKDIR /app

# Copy from the builder: hoisted node_modules + all built workspaces.
# npm workspaces hoists deps to the root /app/node_modules — there is
# no per-package node_modules directory to copy. Bringing the package
# manifests + built artifacts is enough; module resolution walks up
# from packages/server/dist into /app/node_modules.
COPY --from=builder --chown=pi:pi /app/node_modules ./node_modules
COPY --from=builder --chown=pi:pi /app/package.json ./package.json
COPY --from=builder --chown=pi:pi /app/packages/server/package.json ./packages/server/package.json
COPY --from=builder --chown=pi:pi /app/packages/server/dist ./packages/server/dist
COPY --from=builder --chown=pi:pi /app/packages/client/package.json ./packages/client/package.json
COPY --from=builder --chown=pi:pi /app/packages/client/dist ./packages/client/dist

# Workspace + pi config + pi-forge data dirs are mounted at runtime.
# Image-layer defaults preserve the historical non-sandbox posture:
# the server runs as `pi`, and pi-owned config/data dirs are writable by it.
# Sandbox deployments must explicitly permission their mounts; see
# docs/agent-tool-sandbox.md.
RUN mkdir -p /workspace /home/pi/.pi/agent /home/pi/.pi-forge /home/pi/.local \
 && chown -R pi-tools:pi-tools /workspace \
 && chown root:root /home/pi \
 && chown root:pi-tools /home/pi/.pi \
 && chown -R pi:pi /home/pi/.pi/agent /home/pi/.pi-forge /home/pi/.local \
 && chmod 0775 /workspace \
 && chmod 0755 /home/pi \
 && chmod 0750 /home/pi/.pi \
 && chmod 0700 /home/pi/.pi/agent /home/pi/.pi-forge /home/pi/.local

RUN cat >/usr/local/bin/pi-forge-entrypoint <<'EOF'
#!/bin/sh
set -eu
case "$(printf '%s' "${AGENT_TOOL_SANDBOX_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')" in
  1|true|yes|on)
    # Sandbox mode: keep the server as root so it can setuid/setgid
    # model/user tool children to AGENT_TOOL_UID:GID. Mount ownership is
    # an operator contract; see docs/agent-tool-sandbox.md.
    if [ "$(id -u)" != "0" ]; then
      echo "AGENT_TOOL_SANDBOX_ENABLED=true requires the container to run as root" >&2
      exit 1
    fi
    exec "$@"
    ;;
  *)
    # Legacy/default mode: run as whichever non-root user the runtime
    # selected. Compose starts as pi directly so regular mode does not
    # need SETUID/SETGID capabilities; the root fallback preserves
    # compatibility for `docker run` invocations without --user.
    if [ "$(id -u)" = "0" ]; then
      exec gosu pi "$@"
    fi
    exec "$@"
    ;;
esac
EOF
RUN chmod 0755 /usr/local/bin/pi-forge-entrypoint

USER root

# SHELL=/bin/bash so node-pty spawns bash for the integrated terminal
# (pty-manager.ts uses `process.env.SHELL || '/bin/sh'`). TERM hint
# helps line-editing programs pick a sane terminfo entry inside xterm.
#
# PATH prepends /home/pi/.local/bin for scripts installed by
# `python3 -m pip install --user ...`, then /app/node_modules/.bin so
# the `pi` CLI shipped by @mariozechner/pi-coding-agent (already a
# server dep) is on PATH for the running server and any process it
# spawns. The pi-subagents plugin shells out via
# `child_process.spawn("pi", ...)` with no fallback resolution on Linux
# — without this, the subagent tool fails with `spawn pi ENOENT` inside
# the container.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    HOME=/home/pi \
    USER=pi \
    LOGNAME=pi \
    PATH=/home/pi/.local/bin:/app/node_modules/.bin:$PATH \
    WORKSPACE_PATH=/workspace \
    PI_CONFIG_DIR=/home/pi/.pi/agent \
    FORGE_DATA_DIR=/home/pi/.pi-forge \
    PYTHONUSERBASE=/home/pi/.local \
    SHELL=/bin/bash \
    TERM=xterm-256color

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pi-forge-entrypoint"]
CMD ["node", "packages/server/dist/index.js"]
