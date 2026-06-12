# Containers

The shipped Docker image, compose recipe, volume layout, security model,
and resource tuning. For Kubernetes / OpenShift, see
[`kubernetes/DEPLOY.md`](../kubernetes/DEPLOY.md). For non-container
reverse-proxy + TLS recipes, see [`deployment.md`](./deployment.md).

## Why containers

Pi-forge is single-tenant. The agent's `bash` tool is a real shell;
`write` / `edit` touch the workspace; the integrated terminal spawns a
PTY with the server's permissions. The container bounds the blast
radius (workspace bind mount + ephemeral container fs), pins the
runtime (Node + native bindings), and makes deploys reproducible.

## Image overview

`docker/Dockerfile` is multi-stage:

| Stage | Base | Purpose |
|---|---|---|
| `python-base` | `python:3.12-slim-bookworm` | Source for the Python 3.12 + pip runtime copied into the shared Node base |
| `node-python-base` | `node:22-bookworm-slim` | Shared Debian slim base with Node.js 22 plus Python 3.12 + pip |
| `builder` | `node-python-base` | Installs all deps including devDeps, compiles native bindings (`node-pty`), runs `npm run build` for both packages |
| `runtime` | `node-python-base` | Production deps + built artifacts only. Adds `git`, `ripgrep`, `bash`, `curl`, `less`, `procps`, `gosu`, and the C++ toolchain needed for native-module rebuilds during in-container development. Default mode drops the server to `pi`; sandbox mode keeps the server as root so it can drop model/user tool processes to `pi-tools`; `SHELL=/bin/bash` so xterm sessions land in bash, not dash |

Final image size varies by architecture and cache state. Debian-based
(not Alpine) because the Node native-module ecosystem ships glibc
prebuilds; on musl, those packages fall back to source builds.

Installed at runtime:

- **Node.js 22**
- **Python 3.12 + pip** — callable as `python3`, `python`, or `py`
- **`tini`** — init for signal forwarding + zombie reaping
- **`git`** — required by the agent's `bash` tool and the GitPanel routes
- **`ripgrep`** — pi's `grep` tool delegates to `rg` when present;
  silently degrades to a Node walker without it
- **`make`, `g++`** — keeps `npm install` / `npm rebuild` working
  inside the running container when native modules such as `node-pty`
  need to compile against the container's Node ABI

### User and permissions

The image creates two users:

- `pi` (`PUID` / `PGID`, default `1000:1000`) owns the home layout and
  preserves legacy path/env expectations.
- `pi-tools` (`AGENT_TOOL_UID` / `AGENT_TOOL_GID` in compose, default
  `1001:1001`) is the restricted identity used when
  `AGENT_TOOL_SANDBOX_ENABLED=true`.

By default (`AGENT_TOOL_SANDBOX_ENABLED=false`), compose starts the
server as the legacy `pi` user directly and drops all Linux
capabilities. The entrypoint only falls back to `gosu pi` for ad-hoc
`docker run` invocations that still start as root. In sandbox mode,
the server remains root. This is deliberate: the identity sandbox needs
the server to call `setuid` / `setgid` for child tools while keeping
server-owned config, forge data, and mounted secrets unreadable by
`pi-tools`.

Sandbox mode has a stricter volume permission contract than the default
container. Read [`agent-tool-sandbox.md`](./agent-tool-sandbox.md)
before enabling it; the short version is:

- `/workspace` must be writable by `AGENT_TOOL_UID:GID`.
- `/home/pi/.pi` and `/home/pi/.pi/agent` must be traversable/readable
  by `AGENT_TOOL_UID:GID` for non-secret skills/resources.
- `/home/pi/.pi/agent/auth.json`, `models.json`, and `settings.json`
  must not be readable by `AGENT_TOOL_UID:GID`.
- `/home/pi/.pi-forge` and mounted secret dirs/files must not be
  readable by `AGENT_TOOL_UID:GID`.

On Docker Desktop / OrbStack / macOS, bind-mount ownership can be
virtualized; verify numeric ownership and mode bits inside the
container and from an app terminal. Use named volumes for sensitive
mounts if the host file-sharing layer makes ownership inconsistent.

## Volumes

Three bind-mounted volumes:

| Container path | Compose env var (default) | Contents |
|---|---|---|
| `/workspace` | `WORKSPACE_HOST_PATH` (`../workspace`) | User's project source. Projects are subfolders |
| `/home/pi/.pi/agent` | `PI_CONFIG_HOST_PATH` (`~/.pi/agent`) | Pi SDK config — provider keys, models, settings. Shared with host pi CLI by default so secrets aren't copied into the image |
| `/home/pi/.pi-forge` | `FORGE_DATA_HOST_PATH` (`~/.pi-forge-docker`) | Forge state — `projects.json`, MCP / overrides / `jwt-secret` / `password-hash`. **Separate default** from the host path so the container has its own project list (host paths wouldn't resolve inside the container anyway) |

Session JSONLs default to `${WORKSPACE_PATH}/.pi/sessions/` so they
live on the workspace bind mount — backing up the workspace backs up
conversation history. Override with `SESSION_DIR` to relocate.

### Persistent Python packages outside this project

The image includes Python 3.12 and pip. Python is callable as `python3`,
`python`, or `py`. The shipped compose file does not persist Python
package installs by default. If you want package installs
to survive image rebuilds/container replacement without storing them in
the pi-forge checkout or workspace, mount an external host directory or
named volume at `/home/pi/.local` from your own Docker Compose override
or deployment wrapper:

```yaml
services:
  pi-forge:
    volumes:
      - ~/.pi-forge-python:/home/pi/.local
```

Then install with:

```bash
python3 -m pip install --user <package>
```

The image sets `PYTHONUSERBASE=/home/pi/.local` and prepends
`/home/pi/.local/bin` to `PATH`, so console scripts installed by pip are
available automatically. On Linux, pre-create the host directory with the
same owner as `PUID` / `PGID` if Docker would otherwise create it as
root.

For per-project isolation, create virtual environments inside
`/workspace/<project>` instead; those persist because `/workspace` is a
bind mount.

## Environment variables

The full env-var reference lives in
[`configuration.md`](./configuration.md#environment-variables). The
container fixes the path-related vars; the shipped `docker/.env.example`
only includes the settings most Docker users edit on day one. Add
less-used server knobs (LDAP, CORS pinning, minimal UI, orchestration,
rate limits, terminal tuning, explicit JWT rotation, etc.) in your own
compose override (or by adding them to the compose `environment:` block)
when you need them.

| Variable | Container value |
|---|---|
| `PORT` | `3000` (map to host via `HOST_PORT`) |
| `HOST` | `0.0.0.0` (forced — required for Docker port-forward to work) |
| `WORKSPACE_PATH` | `/workspace` |
| `PI_CONFIG_DIR` | `/home/pi/.pi/agent` |
| `FORGE_DATA_DIR` | `/home/pi/.pi-forge` |
| `PYTHONUSERBASE` | `/home/pi/.local` |
| `AGENT_TOOL_SANDBOX_ENABLED` | `false` by default; set `true` to run tool children as `pi-tools` |
| `AGENT_TOOL_UID` / `AGENT_TOOL_GID` | `1001` / `1001` in compose defaults |

Set `UI_PASSWORD` and / or `API_KEY` in `.env` for any non-loopback
deploy — without them, auth is disabled. `JWT_SECRET` is intentionally
not in the sample `.env`; when auth is enabled, pi-forge auto-generates
and persists it under `${FORGE_DATA_DIR}/jwt-secret` unless you choose
to manage rotation yourself.

## Compose recipe

The shipped compose file (`docker/docker-compose.yml`) covers a typical
single-host deploy. Its `.env.example` is deliberately concise; advanced
server env vars remain supported but are documented instead of being
listed as runtime defaults. Quickstart:

```bash
cp docker/.env.example docker/.env
# edit docker/.env — at minimum set HOST_PORT and (for any non-loopback
# deploy) UI_PASSWORD (JWT_SECRET auto-generates), or API_KEY
cd docker && docker compose up -d --build
```

### Operations

```bash
# Logs (follow)
docker compose -f docker/docker-compose.yml logs -f

# Restart after editing .env
docker compose -f docker/docker-compose.yml restart

# Rebuild on code change
docker compose -f docker/docker-compose.yml up -d --build

# Tear down (preserves volumes)
docker compose -f docker/docker-compose.yml down

# Tear down + delete the named volumes (workspace stays — that's a bind mount)
docker compose -f docker/docker-compose.yml down -v
```

### Health check

The container has a baked-in health check that `fetch`s
`http://127.0.0.1:3000/api/v1/health` every 30 s. After the start period,
three failures in a row mark it unhealthy. `docker compose ps` reports the
health state.

## Resource recommendations

Default `docker-compose.yml` doesn't pin CPU / memory limits — pi-forge
is lightweight at idle and the agent's resource use depends entirely on
what your prompts ask for. Reasonable starting points:

```yaml
services:
  pi-forge:
    deploy:
      resources:
        limits:
          memory: 2G    # base + room for buffered SSE / one PTY
        reservations:
          memory: 512M
```

Bump if you:

- **Run heavy build commands inside the integrated terminal** (npm builds,
  cargo, etc.) — terminal output is buffered in the agent's session
  history, which lives in memory until the SSE clients drain it
- **Open many terminals** — each PTY is a separate node-pty + child shell,
  ~5-15 MB per shell at rest, more if you `tail -f` something
- **Have very long running sessions** — pi accumulates message history in
  memory; compaction trims it but cycles in and out

CPU is rarely the bottleneck — most pi-forge CPU is forwarding bytes
between the LLM provider and the browser.

## Networking

The compose file binds host-side to `127.0.0.1:${HOST_PORT}:3000` by
default — only the host can reach the container. To expose to the LAN,
remove the `127.0.0.1:` prefix; for production, leave it loopback-only
and front with a reverse proxy on the same host.

Reverse-proxy + TLS recipes (nginx, Caddy, Traefik) including the
SSE-buffering and WebSocket-upgrade settings live in
[`deployment.md`](./deployment.md).

## Security inside the container

- **Root server, restricted tools (opt-in).** By default the server runs as `pi`.
  When `AGENT_TOOL_SANDBOX_ENABLED=true`, the server runs as root and model/user shell surfaces run
  as `pi-tools` and file tools / `@file` references are path-scoped.
  Keep secrets out of `/workspace`; workspace content is intentionally
  readable by the agent.
- **Minimal capabilities.** Regular compose starts as `pi`, drops all
  capabilities, and does not need `SETUID` / `SETGID`. The optional
  `docker-compose.sandbox.yml` overlay starts as root and adds back
  only `SETUID` / `SETGID`, which are required for the sandbox identity
  switch. No privileged mode or host PID is needed.
- **Secret mounts.** Mount Pi config, forge data, LDAP/UI secret files,
  and cloud credentials so they are readable by the root server but not
  by `pi-tools` (for example mode `0600` root-owned files or `0700`
  directories). The sandbox also blocks `/run/secrets` and
  `/var/run/secrets` from model file tools.
- **Read-only root filesystem (optional).** Add `read_only: true` to
  compose with `tmpfs` mounts for `/tmp` and `/home/pi/.npm` if you
  want a hardened deploy. Native modules + node_modules live in the
  image, so they're already read-only.

## Updating

The image is **not** auto-updating. To pull a new release:

```bash
git pull origin main
cd docker && docker compose up -d --build
```

The build is incremental — npm dep resolution caches; only changed source
files trigger a rebuild. Cold builds are ~3-5 minutes; warm rebuilds are
~30 seconds.

If you've forked the project, pin to your fork's image tag in the compose
file and update the tag explicitly.

## Troubleshooting

### Container starts but can't write to `/workspace`

UID mismatch. Check the host owner (`ls -ln <host-workspace-path>`) and
either:

- Rebuild with matching `PUID` / `PGID` build args, OR
- `chown -R $(id -u):$(id -g) <host-workspace-path>` to match the
  container's defaults

### Terminal fails to spawn (`posix_spawnp failed`)

The native `node-pty` binding doesn't match the runtime Node version.
Rebuild the image first: `docker compose up -d --build` (note `--build`).
If you're using the running container as a development shell and running
`npm install` against a bind-mounted checkout, the runtime image includes
Python 3.12, `pip`, `make`, and `g++` so node-gyp can rebuild `node-pty`
in place.

### Health check failing on first start

The first request lazy-loads the project registry from disk, which on a
slow filesystem (NFS, network bind mount) can take a few seconds. The
health check has a 10 s start period; tune `start_period` in the compose
file's `healthcheck` block if needed.

### Container can't reach LLM provider

The container needs egress to whatever provider domain you've configured
(`api.anthropic.com`, `api.openai.com`, etc.). On corporate networks behind
an HTTP proxy, set `HTTPS_PROXY` in the environment block.

### `git` commands fail with "fatal: detected dubious ownership"

Recent git versions reject working trees owned by a different UID than
the running process. Either match UIDs (per the bind-mount section
above) or run inside the container:

```bash
docker compose exec pi-forge git config --global --add safe.directory /workspace/<project>
```

The setting persists across container restarts because it lives in the
`pi` user's git config inside `/home/pi/.gitconfig`, which is on the
container filesystem — not on a bind mount. To persist across rebuilds,
add it to the Dockerfile (or use a config-only bind mount).
