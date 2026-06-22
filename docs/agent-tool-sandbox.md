# Agent tool identity sandbox

`AGENT_TOOL_SANDBOX_ENABLED=false` by default. In the Docker Compose setup,
regular mode starts the server as the legacy `pi` user directly and drops all
Linux capabilities. When sandbox mode is enabled with the sandbox compose
overlay, pi-forge keeps the HTTP server running as root and runs model/user tool
surfaces as a restricted UID/GID (`pi-tools` in the Docker image).

This is an operator-controlled hardening mode. It is useful only when the
container or pod mounts are permissioned carefully. Leave it disabled for
simple local installs or any deployment where the workspace, Pi config, forge
data, and secret mounts cannot be owned/mode-bit split as described below.

## What changes when enabled

Set:

```txt
AGENT_TOOL_SANDBOX_ENABLED=true
AGENT_TOOL_UID=<numeric uid>
AGENT_TOOL_GID=<numeric gid>
AGENT_TOOL_HOME=<writable sandbox tool home>
```

In the Docker image defaults, `pi-tools` is:

```txt
AGENT_TOOL_UID=1001
AGENT_TOOL_GID=1001
AGENT_TOOL_HOME=/home/pi-tools
```

When enabled:

- agent/model file tools are path-scoped
- `@file` expansion is path-scoped
- agent `bash` runs as `AGENT_TOOL_UID:GID`
- process-tool commands run as `AGENT_TOOL_UID:GID`
- integrated terminals run as `AGENT_TOOL_UID:GID`
- quick-action command chips run as `AGENT_TOOL_UID:GID`
- chat `!` / `!!` exec commands run as `AGENT_TOOL_UID:GID`
- shell/process/terminal env is scrubbed
- shell/process/terminal `HOME` points at `AGENT_TOOL_HOME` (the Docker
  default is `/home/pi-tools`) so CLIs such as `gh` can create sandbox-owned
  config without writing the server user's `/home/pi`

## What is protected

The sandbox is intended to protect server-side secrets from model/user tool
surfaces:

- model file tools can read the configured workspace root (`WORKSPACE_PATH`), not only the active project subfolder
- model file tools cannot read outside allowed roots
- model file tools cannot read protected Pi config files, even if `PI_CONFIG_DIR` is accidentally mounted inside `WORKSPACE_PATH`:
  - `${PI_CONFIG_DIR}/auth.json`
  - `${PI_CONFIG_DIR}/models.json`
  - `${PI_CONFIG_DIR}/settings.json`
- model file tools cannot read `${FORGE_DATA_DIR}`
- model file tools reject `/proc`, `/etc`, `/run/secrets`, and
  `/var/run/secrets`
- model file tools reject traversal and symlink escapes
- bash/process/terminal children do not inherit server/provider env secrets
- with correct UID separation, `/proc/<server-pid>/environ` is not readable by
  tool children

## What is not protected

This mode does **not** protect:

- secrets placed in `/workspace`
- a compromised pi-forge server process
- host/container/pod misconfiguration
- third-party extensions or tools that bypass pi-forge's policy hooks
- anything readable by `AGENT_TOOL_UID:GID` at the filesystem layer

The model and user shell surfaces are intentionally allowed to read and write
the entire configured workspace root (`WORKSPACE_PATH`, `/workspace` in the
Docker image), including sibling project folders. Unlike model file tools,
`bash`, process-tool commands, integrated terminals, quick actions, and chat
exec commands are not path-policy scoped; after they drop to
`AGENT_TOOL_UID:GID`, access to `PI_CONFIG_DIR`, `FORGE_DATA_DIR`, and any
other path is controlled by Unix ownership and mode bits.

## Required mount permissions

Regular/non-sandbox mode keeps the historical simple contract: the server runs
as `pi`, and mounted workspace/config/data paths should be writable by `pi`.
Sandbox mode is different and requires the split below. The Docker image makes
the image-owned parent `/home/pi/.pi` traversable by `pi-tools`; the mounted
`/home/pi/.pi/agent` subtree still needs the permissions below.

The permissions that matter are numeric UID/GID and mode bits **as seen inside
the container or pod**.

| Path | Required sandbox posture |
|---|---|
| `/workspace` | Writable by `AGENT_TOOL_UID` and traversable/readable by the root server without `DAC_OVERRIDE`. Recommended: `AGENT_TOOL_UID:0` with group rwX (`1001:0` in the Docker examples). Secrets in the workspace are readable by the agent. |
| `/home/pi` when the entire home directory is mounted | Traversable by `AGENT_TOOL_UID:GID`, not writable by it. Recommended: `root:pi-tools` `0710`. Do this only for a dedicated container home mount, not your normal host login home. |
| `/home/pi/.pi` | Traversable by `AGENT_TOOL_UID:GID` so package skills and non-secret resources can be loaded. Recommended: `root:pi-tools` `0750`. |
| `/home/pi/.pi/agent` | Traversable/readable by `AGENT_TOOL_UID:GID` for non-secret resources. Recommended: `root:pi-tools` `0750`. |
| `/home/pi/.pi/agent/{skills,npm,git,extensions,prompts,themes}` | Writable by `AGENT_TOOL_UID`/`pi-tools` as needed for agent resource installs and updates. Create these directories before applying ownership because `pi-tools` cannot create missing children under a non-writable `/home/pi/.pi/agent`. Recommended: `1001:1001` with owner rwX and no other access. |
| `/home/pi/.pi/agent/auth.json` | Not readable by `AGENT_TOOL_UID:GID`. Recommended: `root:root` `0600`. Also blocked by file-tool policy. |
| `/home/pi/.pi/agent/models.json` | Not readable by `AGENT_TOOL_UID:GID`. Recommended: `root:root` `0600`. Also blocked by file-tool policy. |
| `/home/pi/.pi/agent/settings.json` | Not readable by `AGENT_TOOL_UID:GID`. Recommended: `root:root` `0600`. Also blocked by file-tool policy. |
| `/home/pi/.pi-forge` | Not readable by `AGENT_TOOL_UID:GID`. Recommended: `root:root` `0700`. |
| `/home/pi-tools` (`AGENT_TOOL_HOME`) | Writable by `AGENT_TOOL_UID:GID`; this is where sandbox terminals/processes/model bash create per-user CLI config such as `~/.config/gh`. Treat credentials stored here as available to model/user shell surfaces. |
| mounted secret dirs/files | Not readable by `AGENT_TOOL_UID:GID`; prefer root-owned `0700` dirs and `0600` files. |

Why `.pi` is partially readable: pi package skills and other non-secret pi
resources may live under the Pi config/home tree. The sandbox blocks the known
secret Pi config files by policy and filesystem mode, while leaving non-secret
resources loadable and the selected agent resource directories writable by
`pi-tools`.

The Docker image's built-in directory ownership remains optimized for regular
mode (`pi` owns `/home/pi` plus `/home/pi/.pi/agent` and `/home/pi/.pi-forge`) so
non-sandbox tools can create ordinary per-user config such as `~/.config/gh`.
Enabling sandbox with bind mounts or persistent volumes is an explicit operator
step: adjust the mount permissions to the table above before relying on
filesystem isolation. Sandbox tool children should still run as a different
`AGENT_TOOL_UID:GID` so they cannot write the `pi` user's home by default.
Switching an existing deployment between regular and sandbox mode may require
changing volume ownership/modes.

## Docker Compose: native Linux bind mounts

Use this section for regular Docker Engine on Linux. You can keep the default
bind mounts from `docker/docker-compose.yml`:

```yaml
volumes:
  - ${WORKSPACE_HOST_PATH:-../workspace}:/workspace
  - ${PI_CONFIG_HOST_PATH:-~/.pi/agent}:/home/pi/.pi/agent
  - ${FORGE_DATA_HOST_PATH:-~/.pi-forge-docker}:/home/pi/.pi-forge
```

Native Linux bind mounts normally preserve host numeric ownership in the
container. With default sandbox tool IDs (`1001:1001`; workspace group `0` for
the root server), run these commands on the **host** before starting the
container:

```bash
# Workspace: writable by pi-tools and accessible to the root server.
# Group 0 matters because sandbox containers drop DAC_OVERRIDE, so root
# cannot bypass mode bits on host bind mounts.
sudo mkdir -p ./workspace
sudo chown -R 1001:0 ./workspace
sudo chmod -R u+rwX,g+rwX,o-rwx ./workspace

# Forge data: server-only.
sudo mkdir -p ~/.pi-forge-docker
sudo chown -R root:root ~/.pi-forge-docker
sudo chmod -R u+rwX,go-rwx ~/.pi-forge-docker

# Pi config parent: traversable by pi-tools so non-secret resources can load.
# The image-owned /home/pi/.pi parent is already traversable by pi-tools when
# only ~/.pi/agent is mounted. If you mount the whole ~/.pi directory, set the
# parent permissions too.
sudo chown root:1001 ~/.pi
sudo chmod 0750 ~/.pi
sudo chown root:1001 ~/.pi/agent
sudo chmod 0750 ~/.pi/agent

# If you mount an entire dedicated container home directory at /home/pi, make
# that mounted home traversable but not writable by pi-tools. Do not run this
# against your normal host login home.
# sudo chown root:1001 /path/to/dedicated/container-home
# sudo chmod 0710 /path/to/dedicated/container-home

# Agent resource directories: create missing children first because pi-tools
# cannot create them under a non-writable ~/.pi/agent. Then make these
# non-secret trees writable by UID/user 1001 (pi-tools) for installs/updates.
sudo mkdir -p ~/.pi/agent/skills
sudo mkdir -p ~/.pi/agent/npm
sudo mkdir -p ~/.pi/agent/git
sudo mkdir -p ~/.pi/agent/extensions
sudo mkdir -p ~/.pi/agent/prompts
sudo mkdir -p ~/.pi/agent/themes
sudo chown -R 1001:1001 ~/.pi/agent/skills
sudo chown -R 1001:1001 ~/.pi/agent/npm
sudo chown -R 1001:1001 ~/.pi/agent/git
sudo chown -R 1001:1001 ~/.pi/agent/extensions
sudo chown -R 1001:1001 ~/.pi/agent/prompts
sudo chown -R 1001:1001 ~/.pi/agent/themes
sudo chmod -R u+rwX,go-rwx ~/.pi/agent/skills
sudo chmod -R u+rwX,go-rwx ~/.pi/agent/npm
sudo chmod -R u+rwX,go-rwx ~/.pi/agent/git
sudo chmod -R u+rwX,go-rwx ~/.pi/agent/extensions
sudo chmod -R u+rwX,go-rwx ~/.pi/agent/prompts
sudo chmod -R u+rwX,go-rwx ~/.pi/agent/themes

# Pi config secrets/settings: server-only. Re-run this after broad permission
# changes so pi-tools cannot read provider auth, model config, or settings.
sudo chown root:root ~/.pi/agent/auth.json ~/.pi/agent/models.json ~/.pi/agent/settings.json 2>/dev/null || true
sudo chmod 0600 ~/.pi/agent/auth.json ~/.pi/agent/models.json ~/.pi/agent/settings.json 2>/dev/null || true
```

Set sandbox env in `docker/.env`:

```txt
AGENT_TOOL_SANDBOX_ENABLED=true
AGENT_TOOL_UID=1001
AGENT_TOOL_GID=1001
AGENT_TOOL_HOME=/home/pi-tools
```

Start sandbox mode with the sandbox compose overlay. The base compose file runs
regular mode as `pi` with no Linux capabilities; the overlay switches the server
container to root and adds back only `SETUID` / `SETGID` for sandbox child
processes:

```bash
cd docker
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build
```

To stop it later, pass the same file set:

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml down
```

## Docker Compose: OrbStack / Docker Desktop / macOS

Use this section for OrbStack or Docker Desktop on macOS. Host file sharing can
translate ownership differently depending on the container and the accessing
UID, so host-side `chown` may not produce stable results inside pi-forge.

Recommended differences from native Linux:

1. Keep `/workspace` as a host bind mount if you want to edit code from macOS.
2. Use Docker named volumes for `/home/pi/.pi/agent` and `/home/pi/.pi-forge`.
3. Initialize those named volumes with a one-shot helper container.
4. Add `DAC_OVERRIDE` only for local OrbStack/Docker Desktop testing if the root
   server cannot write the id-mapped `.pi-forge` volume.

### Compose volume changes

Change the service volumes from host binds for Pi config / forge data to named
volumes:

```yaml
services:
  pi-forge:
    volumes:
      - ${WORKSPACE_HOST_PATH:-../workspace}:/workspace
      - pi-config:/home/pi/.pi/agent
      - forge-data:/home/pi/.pi-forge

volumes:
  pi-config:
  forge-data:
```

If you want stable names for helper commands:

```yaml
volumes:
  pi-config:
    name: docker_pi-config
  forge-data:
    name: docker_forge-data
```

### Compose capability changes

Start with the sandbox compose overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build
```

The base compose file already drops all capabilities. The sandbox overlay adds
back `SETUID` / `SETGID` and runs the server container as root.

If OrbStack/Docker Desktop shows `.pi-forge` as `1000:1000 0700` inside the
pi-forge container even after the helper volume init chowns it to `root:root`,
add `DAC_OVERRIDE` for local testing:

```yaml
cap_add:
  - SETUID
  - SETGID
  - DAC_OVERRIDE # local OrbStack/Docker Desktop workaround only
```

Keep production/native-Linux deployments to `SETUID` and `SETGID` when mounts
can be permissioned normally.

### One-shot volume init commands

This example assumes the named volumes are `docker_pi-config` and
`docker_forge-data`, and the sandbox UID/GID is `1001:1001`:

```bash
cd docker
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml down

# Optional: seed the named pi config volume from the host before locking it down.
docker run --rm \
  -v "$HOME/.pi/agent":/src:ro \
  -v docker_pi-config:/home/pi/.pi/agent \
  debian:bookworm-slim sh -lc 'cp -a /src/. /home/pi/.pi/agent/'

# Permission the named volumes for sandbox mode.
docker run --rm \
  -v docker_pi-config:/home/pi/.pi/agent \
  -v docker_forge-data:/home/pi/.pi-forge \
  debian:bookworm-slim sh -lc '
set -eux

# Forge data: server-only.
chown -R root:root /home/pi/.pi-forge
chmod 0700 /home/pi/.pi-forge
find /home/pi/.pi-forge -type d -exec chmod 0700 {} +
find /home/pi/.pi-forge -type f -exec chmod 0600 {} +

# Pi config: pi-tools can traverse/read non-secret resources.
chown root:1001 /home/pi/.pi/agent
chmod 0750 /home/pi/.pi/agent

# Agent resource directories: create missing children first because pi-tools
# cannot create them under a non-writable /home/pi/.pi/agent. Then make these
# non-secret trees writable by UID/user 1001 (pi-tools) for installs/updates.
mkdir -p /home/pi/.pi/agent/skills
mkdir -p /home/pi/.pi/agent/npm
mkdir -p /home/pi/.pi/agent/git
mkdir -p /home/pi/.pi/agent/extensions
mkdir -p /home/pi/.pi/agent/prompts
mkdir -p /home/pi/.pi/agent/themes
chown -R 1001:1001 /home/pi/.pi/agent/skills
chown -R 1001:1001 /home/pi/.pi/agent/npm
chown -R 1001:1001 /home/pi/.pi/agent/git
chown -R 1001:1001 /home/pi/.pi/agent/extensions
chown -R 1001:1001 /home/pi/.pi/agent/prompts
chown -R 1001:1001 /home/pi/.pi/agent/themes
chmod -R u+rwX,go-rwx /home/pi/.pi/agent/skills
chmod -R u+rwX,go-rwx /home/pi/.pi/agent/npm
chmod -R u+rwX,go-rwx /home/pi/.pi/agent/git
chmod -R u+rwX,go-rwx /home/pi/.pi/agent/extensions
chmod -R u+rwX,go-rwx /home/pi/.pi/agent/prompts
chmod -R u+rwX,go-rwx /home/pi/.pi/agent/themes

# Pi config secrets/settings: server-only. Re-run this after broad permission
# changes so pi-tools cannot read provider auth, model config, or settings.
chown root:root \
  /home/pi/.pi/agent/auth.json \
  /home/pi/.pi/agent/models.json \
  /home/pi/.pi/agent/settings.json 2>/dev/null || true
chmod 0600 \
  /home/pi/.pi/agent/auth.json \
  /home/pi/.pi/agent/models.json \
  /home/pi/.pi/agent/settings.json 2>/dev/null || true

stat -c "%u:%g %a %n" /home/pi/.pi/agent /home/pi/.pi-forge
'
```

Set sandbox env in `docker/.env`:

```txt
AGENT_TOOL_SANDBOX_ENABLED=true
AGENT_TOOL_UID=1001
AGENT_TOOL_GID=1001
AGENT_TOOL_HOME=/home/pi-tools
```

Start pi-forge with the sandbox overlay:

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml up -d --build
```

Verify the actual mounts and ownership inside pi-forge:

```bash
docker compose -f docker-compose.yml -f docker-compose.sandbox.yml run --rm pi-forge sh -lc '
id
stat -c "%u:%g %a %n" /workspace /home/pi/.pi /home/pi/.pi/agent /home/pi/.pi-forge
# Expected /workspace owner/group is 1001:0 with owner+group rwX bits.
touch /home/pi/.pi-forge/probe && rm /home/pi/.pi-forge/probe
'
```

Then verify from the app terminal (which runs as `pi-tools`):

```bash
id
stat -c "%u:%g %a %n" /workspace /home/pi/.pi /home/pi/.pi/agent /home/pi/.pi-forge
# Expected /workspace owner/group is 1001:0 with owner+group rwX bits.
cat /home/pi/.pi-forge/jwt-secret
cat /home/pi/.pi/agent/auth.json
```

Expected: `id` shows `pi-tools`; workspace writes work; `.pi/agent` traversal
works; `.pi-forge` and protected config files are permission denied.

## Kubernetes

Use this section for vanilla Kubernetes. You do **not** need Docker named
volumes. Use PVCs and an initContainer to set the ownership/modes before the
pi-forge app container starts.

### App container security context

The app container must start as UID 0 so the server can drop tool children to
`AGENT_TOOL_UID:GID`:

```yaml
securityContext:
  runAsUser: 0
  runAsGroup: 0
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
    add: ["SETUID", "SETGID"]
  seccompProfile:
    type: RuntimeDefault
```

### Required env

```yaml
env:
  - name: AGENT_TOOL_SANDBOX_ENABLED
    value: "true"
  - name: AGENT_TOOL_UID
    value: "1001"
  - name: AGENT_TOOL_GID
    value: "1001"
  - name: AGENT_TOOL_HOME
    value: /home/pi-tools
```

### Init container

This example assumes default IDs (`pi=1000`, `pi-tools=1001`) and the shipped
volume names/mount paths:

```yaml
initContainers:
  - name: sandbox-volume-permissions
    image: busybox:1.36
    command:
      - sh
      - -lc
      - |
        set -eux

        # Workspace: writable by pi-tools and accessible to the root server.
        # Group 0 matters because sandbox containers drop DAC_OVERRIDE, so root
        # cannot bypass mode bits on PVCs.
        mkdir -p /workspace
        chown -R 1001:0 /workspace
        chmod -R u+rwX,g+rwX,o-rwx /workspace

        # Forge data: server-only.
        mkdir -p /home/pi/.pi-forge
        chown -R 0:0 /home/pi/.pi-forge
        chmod 0700 /home/pi/.pi-forge
        find /home/pi/.pi-forge -type d -exec chmod 0700 {} +
        find /home/pi/.pi-forge -type f -exec chmod 0600 {} +

        # If this deployment mounts the entire /home/pi home directory, keep
        # it traversable but not writable by pi-tools. Leave these commented
        # when only the child volumes below are mounted.
        # mkdir -p /home/pi
        # chown 0:1001 /home/pi
        # chmod 0710 /home/pi

        # Pi config parent: traversable by pi-tools so non-secret resources
        # can load.
        mkdir -p /home/pi/.pi/agent
        chown 0:1001 /home/pi/.pi
        chmod 0750 /home/pi/.pi
        chown 0:1001 /home/pi/.pi/agent
        chmod 0750 /home/pi/.pi/agent

        # Agent resource directories: create missing children first because
        # pi-tools cannot create them under a non-writable /home/pi/.pi/agent.
        # Then make these non-secret trees writable by UID/user 1001
        # (pi-tools) for installs/updates.
        mkdir -p /home/pi/.pi/agent/skills
        mkdir -p /home/pi/.pi/agent/npm
        mkdir -p /home/pi/.pi/agent/git
        mkdir -p /home/pi/.pi/agent/extensions
        mkdir -p /home/pi/.pi/agent/prompts
        mkdir -p /home/pi/.pi/agent/themes
        chown -R 1001:1001 /home/pi/.pi/agent/skills
        chown -R 1001:1001 /home/pi/.pi/agent/npm
        chown -R 1001:1001 /home/pi/.pi/agent/git
        chown -R 1001:1001 /home/pi/.pi/agent/extensions
        chown -R 1001:1001 /home/pi/.pi/agent/prompts
        chown -R 1001:1001 /home/pi/.pi/agent/themes
        chmod -R u+rwX,go-rwx /home/pi/.pi/agent/skills
        chmod -R u+rwX,go-rwx /home/pi/.pi/agent/npm
        chmod -R u+rwX,go-rwx /home/pi/.pi/agent/git
        chmod -R u+rwX,go-rwx /home/pi/.pi/agent/extensions
        chmod -R u+rwX,go-rwx /home/pi/.pi/agent/prompts
        chmod -R u+rwX,go-rwx /home/pi/.pi/agent/themes

        # Pi config secrets/settings: server-only. Re-run this after resource
        # permission changes so pi-tools cannot read provider auth, model
        # config, or settings.
        chown 0:0 \
          /home/pi/.pi/agent/auth.json \
          /home/pi/.pi/agent/models.json \
          /home/pi/.pi/agent/settings.json 2>/dev/null || true
        chmod 0600 \
          /home/pi/.pi/agent/auth.json \
          /home/pi/.pi/agent/models.json \
          /home/pi/.pi/agent/settings.json 2>/dev/null || true
    securityContext:
      runAsUser: 0
      runAsGroup: 0
      allowPrivilegeEscalation: false
      capabilities:
        drop: ["ALL"]
        add: ["CHOWN", "FOWNER"]
      readOnlyRootFilesystem: true
      seccompProfile:
        type: RuntimeDefault
    volumeMounts:
      - name: workspace
        mountPath: /workspace
      - name: pi-config
        mountPath: /home/pi/.pi/agent
      - name: pi-forge-data
        mountPath: /home/pi/.pi-forge
```

Do not use `fsGroup` to make the sensitive volumes broadly group-readable; the
sandbox relies on `.pi-forge` and protected Pi config files staying unreadable
by `AGENT_TOOL_UID:GID`.

## OpenShift

OpenShift `restricted-v2` random UID does not support this mode. Use `anyuid`
for a simple deployment, or a custom SCC that allows:

- UID 0 for the server container
- `SETUID`
- `SETGID`
- no privileged mode

Keep SCC RoleBindings in namespace/security bootstrap, not in the
DeploymentConfig.

Example RoleBinding for `anyuid`:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: pi-forge-anyuid
  namespace: pi-forge
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: system:openshift:scc:anyuid
subjects:
  - kind: ServiceAccount
    name: pi-forge
    namespace: pi-forge
```

Use the Kubernetes initContainer permission commands above, plus the OpenShift
SCC binding. If you build a custom SCC, it needs UID 0 plus `SETUID`/`SETGID`;
it does not need privileged mode.

## pi-subagents package disabled in sandbox mode

The `pi-subagents` package/extension is disabled while
`AGENT_TOOL_SANDBOX_ENABLED=true`. The package shells out to the `pi` CLI and
manages child sessions outside pi-forge's normal in-process tool override path,
which makes its security boundary harder to reason about in this mode.

Built-in pi-forge orchestration tools remain separate from `pi-subagents`; if
you use them with sandbox mode, validate their worker behavior under your
mount/UID policy.

## LDAP bind password files

When sandbox mode is enabled, pi-forge rejects:

- `LDAP_BIND_PASSWORD_FILE`
- CLI `--ldap-bind-password @/path`
- env-style `LDAP_BIND_PASSWORD=@/path`

Use a literal environment value or an external secret broker instead. Tool
children receive a scrubbed env and do not inherit the LDAP bind password.

## Access model quick reference

Default Docker image identities:

| Surface | Regular mode (`AGENT_TOOL_SANDBOX_ENABLED=false`) | Sandbox mode (`AGENT_TOOL_SANDBOX_ENABLED=true`) |
|---|---|---|
| pi-forge HTTP server and session registry | `pi` (`1000:1000` by default) | `root` (`0:0`) |
| Model file tools (`read`, `write`, `grep`, `find`, `ls`, `edit`) | SDK defaults as the server identity | Server identity plus pi-forge path policy |
| Agent `bash`, process tool commands, terminal, quick actions, chat exec | `pi` (`1000:1000` by default) | `pi-tools` (`1001:1001` by default) |

Use this matrix when debugging `EACCES`. `rwx` means the identity should be able
to create/update entries there; `r-x` means traversal/read only; `denied` means
normal Unix mode bits should block the identity; `policy denied` means sandboxed
model file tools reject the path even if the server process could read it.

| Path | `pi` regular server/tools | `root` sandbox server | `pi-tools` sandbox shell tools | Sandbox model file tools |
|---|---|---|---|---|
| `/home/pi` | `rwx`; regular CLIs can create per-user config such as `~/.config/gh` | `rwx` | `r-x` when `AGENT_TOOL_UID` differs from `pi`; not used as HOME | usually not used directly |
| `/home/pi-tools` (`AGENT_TOOL_HOME`) | not used | `rwx` | `rwx`; sandbox CLIs create `~/.config`, `~/.gitconfig`, caches here | outside allowed roots |
| `/home/pi/.npm` | `rwx`; npm logs/cache | `rwx` | denied unless explicitly permissioned | outside allowed roots |
| `/home/pi/.local` | `rwx`; user installs and Python user base | `rwx` | denied unless explicitly permissioned | outside allowed roots |
| `/home/pi/.pi` | `r-x`; parent for Pi config | `rwx` | deployment-dependent traversal only | parent traversal only |
| `/home/pi/.pi/agent` (`PI_CONFIG_DIR`) | `rwx` for regular config writes | `rwx` | ideally denied by mode bits, except deliberate non-secret resources | allowed for non-secret files only |
| `auth.json`, `models.json`, `settings.json` | `rw` | `rw` | denied by mode bits | policy denied |
| `/home/pi/.pi-forge` (`FORGE_DATA_DIR`) | `rwx` | `rwx` | denied by mode bits | policy denied |
| `/workspace` (`WORKSPACE_PATH`) | mount-dependent; should be writable by `pi` in regular mode | mount-dependent; must be usable by the server for project/session setup | mount-dependent; should be writable by `pi-tools` in sandbox mode | allowed for the configured workspace root |
| `/tmp` | `rwx` | `rwx` | `rwx` | outside allowed roots unless explicitly requested by a denied path |
| `/app` | `r-x` app code | root can write but should treat as image-owned/read-only | `r-x` | outside allowed roots |

Do not rely on the model file-tool policy to protect secrets from shell tools.
Shell-like surfaces (`bash`, process commands, terminals, quick actions, and
chat exec) run as an OS identity and are protected by ownership/mode bits and a
scrubbed environment, not by the file-tool path policy.

If sandbox sessions start but skills or package extensions are missing, inspect
existing resource ownership. Previously installed trees often remain
`1000:1000` from regular mode. The relevant non-secret trees are usually:

- `${PI_CONFIG_DIR}/skills`
- `${PI_CONFIG_DIR}/npm`
- `${PI_CONFIG_DIR}/git`
- `${PI_CONFIG_DIR}/extensions`
- `${PI_CONFIG_DIR}/prompts`
- `${PI_CONFIG_DIR}/themes`

Those directories must exist and be writable by UID/user `1001` (`pi-tools`)
while `${PI_CONFIG_DIR}/auth.json`, `models.json`, and `settings.json` stay
`0600`.

## Suggested verification prompts

Ask the model:

```txt
Use your file tools, not bash, to test sandbox file access.
Try to read /workspace/sandbox-test.txt, list /workspace, read
/home/pi/.pi/agent/auth.json, /home/pi/.pi/agent/models.json,
/home/pi/.pi/agent/settings.json, /home/pi/.pi-forge/jwt-secret,
/proc/self/environ, /etc/passwd, and /run/secrets/anything.
Report which succeeded and which failed.
```

Expected: workspace succeeds; protected config, forge data, `/proc`, `/etc`,
and secret mounts are denied.

Ask the model:

```txt
Use bash to run: id; env | sort; echo ok > /workspace/bash-sandbox-test.txt;
cat /workspace/bash-sandbox-test.txt; cat /home/pi/.pi-forge/jwt-secret;
cat /home/pi/.pi/agent/auth.json; cat /proc/1/environ.
Report the output and explain what was protected.
```

Expected: `id` shows the restricted UID/GID, env is scrubbed, workspace write
works, and server secrets fail with permission denied.
