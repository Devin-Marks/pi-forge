# syntax=docker/dockerfile:1.6
#
# Multi-stage Dockerfile for pi-forge.
#
#   builder  → install deps, compile server TS, build Vite client
#   runtime  → minimal node:22-bookworm-slim with the compiled output
#              and hoisted node_modules; runs as a non-root user.
#
# Why bookworm-slim and not alpine: the Node native-module ecosystem
# (node-pty, bcrypt, sharp, better-sqlite3, …) ships prebuilt binaries
# against glibc. On musl/alpine, prebuild-install can't find a matching
# binary and falls back to a source build, which both slows the image
# build and breaks any package without source-build support. The image
# is ~80 MB larger than alpine; in exchange we get faster builds, fewer
# native-module footguns, and a friendlier interactive shell for the
# integrated terminal (bash + readline + a real coreutils).

# ---------- builder ----------
FROM node:22-bookworm-slim AS builder

# Native deps for node-pty (Phase 11 will use it; the dep is already in
# server/package.json, so install needs the toolchain regardless). On
# bookworm-slim, node-pty's prebuilds usually cover the linux-x64 and
# linux-arm64 paths — but we keep the toolchain so a source build still
# works on platforms without a prebuild, and so any other native module
# pulled in transitively still installs cleanly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
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
FROM node:22-bookworm-slim AS runtime

# `tini` for proper PID-1 signal handling (Ctrl-C → SIGTERM → graceful
# shutdown of pi-forge's onClose hook). Without it, dropped SIGTERMs
# leave SSE clients hanging on `docker compose down`.
#
# PUID/PGID build args let the user match the container's `pi` user to
# their host UID/GID. Default 1000 is the common Linux interactive UID.
# Without this, the system-allocated UID won't match the host owner of
# the bind-mounted /workspace + ~/.pi-forge dirs, and the container
# can't write to them. Override at build time:
#   docker compose build --build-arg PUID=$(id -u) --build-arg PGID=$(id -g)
ARG PUID=1000
ARG PGID=1000

# `node:22-bookworm-slim` ships a pre-baked `node` user/group at
# UID/GID 1000 — the same default we want for `pi`. Drop it before
# creating `pi`, otherwise `groupadd -g 1000` fails with "GID '1000'
# already exists." `|| true` keeps the build green on any future base
# image that drops the node user.
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
#   - gnupg: needed only to verify the GitHub CLI apt-source signing
#     key during install — kept in the same RUN so the keyring is
#     present when `apt-get install gh` runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tini git ripgrep bash curl ca-certificates less procps gnupg \
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
 && useradd -m -u $PUID -g $PGID -s /bin/bash pi

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

# Workspace + pi config + pi-forge data dirs are mounted at runtime;
# create them so non-root `pi` can read them on first start even if the
# host bind is currently empty.
RUN mkdir -p /workspace /home/pi/.pi/agent /home/pi/.pi-forge \
 && chown -R pi:pi /workspace /home/pi/.pi /home/pi/.pi-forge

USER pi

# SHELL=/bin/bash so node-pty spawns bash for the integrated terminal
# (pty-manager.ts uses `process.env.SHELL || '/bin/sh'`). TERM hint
# helps line-editing programs pick a sane terminfo entry inside xterm.
#
# PATH prepends /app/node_modules/.bin so the `pi` CLI shipped by
# @mariozechner/pi-coding-agent (already a server dep) is on PATH for
# the running server and any process it spawns. The pi-subagents
# plugin shells out via `child_process.spawn("pi", ...)` with no
# fallback resolution on Linux — without this, the subagent tool
# fails with `spawn pi ENOENT` inside the container.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PATH=/app/node_modules/.bin:$PATH \
    WORKSPACE_PATH=/workspace \
    PI_CONFIG_DIR=/home/pi/.pi/agent \
    FORGE_DATA_DIR=/home/pi/.pi-forge \
    SHELL=/bin/bash \
    TERM=xterm-256color

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "packages/server/dist/index.js"]
