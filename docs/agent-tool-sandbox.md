# Agent tool identity sandbox

`AGENT_TOOL_SANDBOX_ENABLED=false` by default. In the Docker image, the default
entrypoint drops the server to the legacy `pi` user. When sandbox mode is
enabled, pi-forge keeps the HTTP server running as root and runs model/user
tool surfaces as a restricted UID/GID (`pi-tools` in the Docker image).

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
```

In the Docker image defaults, `pi-tools` is:

```txt
AGENT_TOOL_UID=1001
AGENT_TOOL_GID=1001
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
| `/workspace` | Writable by `AGENT_TOOL_UID:GID`. Secrets in the workspace are readable by the agent. |
| `/home/pi/.pi` | Traversable by `AGENT_TOOL_UID:GID` so package skills and non-secret resources can be loaded. Recommended: `root:pi-tools` `0750`. |
| `/home/pi/.pi/agent` | Traversable/readable by `AGENT_TOOL_UID:GID` for non-secret resources. Recommended: `root:pi-tools` `0750`. |
| `/home/pi/.pi/agent/auth.json` | Not readable by `AGENT_TOOL_UID:GID`. Recommended: `root:root` `0600`. Also blocked by file-tool policy. |
| `/home/pi/.pi/agent/models.json` | Not readable by `AGENT_TOOL_UID:GID`. Recommended: `root:root` `0600`. Also blocked by file-tool policy. |
| `/home/pi/.pi/agent/settings.json` | Not readable by `AGENT_TOOL_UID:GID`. Recommended: `root:root` `0600`. Also blocked by file-tool policy. |
| `/home/pi/.pi-forge` | Not readable by `AGENT_TOOL_UID:GID`. Recommended: `root:root` `0700`. |
| mounted secret dirs/files | Not readable by `AGENT_TOOL_UID:GID`; prefer root-owned `0700` dirs and `0600` files. |

Why `.pi` is partially readable: pi package skills and other non-secret pi
resources may live under the Pi config/home tree. The sandbox blocks the known
secret Pi config files by policy and filesystem mode, while leaving non-secret
resources loadable.

The Docker image's built-in directory ownership remains optimized for regular
mode (`pi` owns `/home/pi/.pi/agent` and `/home/pi/.pi-forge`). Enabling sandbox
with bind mounts or persistent volumes is an explicit operator step: adjust the
mount permissions to the table above before relying on filesystem isolation.
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
container. With default sandbox IDs (`1001:1001`), run these commands on the
**host** before starting the container:

```bash
# Workspace: writable by pi-tools.
sudo mkdir -p ./workspace
sudo chown -R 1001:1001 ./workspace
sudo chmod -R u+rwX,g+rwX,o-rwx ./workspace

# Forge data: server-only.
sudo mkdir -p ~/.pi-forge-docker
sudo chown -R root:root ~/.pi-forge-docker
sudo chmod -R u+rwX,go-rwx ~/.pi-forge-docker

# Pi config: pi-tools can traverse/read non-secret resources.
# The image-owned /home/pi/.pi parent is already traversable by pi-tools when
# only ~/.pi/agent is mounted. If you mount the whole ~/.pi directory, set the
# parent permissions too.
sudo chown root:1001 ~/.pi
sudo chmod 0750 ~/.pi
sudo chown -R root:1001 ~/.pi/agent
sudo chmod 0750 ~/.pi/agent
sudo find ~/.pi/agent -type d -exec chmod 0750 {} +
sudo find ~/.pi/agent -type f -exec chmod 0640 {} +

# Pi config secrets: server-only.
sudo chown root:root ~/.pi/agent/auth.json ~/.pi/agent/models.json ~/.pi/agent/settings.json 2>/dev/null || true
sudo chmod 0600 ~/.pi/agent/auth.json ~/.pi/agent/models.json ~/.pi/agent/settings.json 2>/dev/null || true
```

Set sandbox env in `docker/.env`:

```txt
AGENT_TOOL_SANDBOX_ENABLED=true
AGENT_TOOL_UID=1001
AGENT_TOOL_GID=1001
```

Compose capabilities for native Linux should be:

```yaml
cap_drop:
  - ALL
cap_add:
  - SETUID
  - SETGID
security_opt:
  - no-new-privileges:true
```

Then rebuild/recreate:

```bash
cd docker
docker compose down
docker compose up -d --build
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

Start with the native capability set:

```yaml
cap_drop:
  - ALL
cap_add:
  - SETUID
  - SETGID
security_opt:
  - no-new-privileges:true
```

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
docker compose down

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
chown -R root:1001 /home/pi/.pi/agent
chmod 0750 /home/pi/.pi/agent
find /home/pi/.pi/agent -type d -exec chmod 0750 {} +
find /home/pi/.pi/agent -type f -exec chmod 0640 {} +

# Pi config secrets: server-only.
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
```

Start pi-forge:

```bash
docker compose up -d --build
```

Verify the actual mounts and ownership inside pi-forge:

```bash
docker compose run --rm pi-forge sh -lc '
id
stat -c "%u:%g %a %n" /workspace /home/pi/.pi /home/pi/.pi/agent /home/pi/.pi-forge
touch /home/pi/.pi-forge/probe && rm /home/pi/.pi-forge/probe
'
```

Then verify from the app terminal (which runs as `pi-tools`):

```bash
id
stat -c "%u:%g %a %n" /workspace /home/pi/.pi /home/pi/.pi/agent /home/pi/.pi-forge
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

        # Workspace: writable by pi-tools.
        mkdir -p /workspace
        chown -R 1001:1001 /workspace
        chmod -R u+rwX,g+rwX,o-rwx /workspace

        # Forge data: server-only.
        mkdir -p /home/pi/.pi-forge
        chown -R 0:0 /home/pi/.pi-forge
        chmod 0700 /home/pi/.pi-forge
        find /home/pi/.pi-forge -type d -exec chmod 0700 {} +
        find /home/pi/.pi-forge -type f -exec chmod 0600 {} +

        # Pi config: pi-tools can traverse/read non-secret resources.
        mkdir -p /home/pi/.pi/agent
        chown 0:1001 /home/pi/.pi
        chmod 0750 /home/pi/.pi
        chown -R 0:1001 /home/pi/.pi/agent
        chmod 0750 /home/pi/.pi/agent
        find /home/pi/.pi/agent -type d -exec chmod 0750 {} +
        find /home/pi/.pi/agent -type f -exec chmod 0640 {} +

        # Pi config secrets: server-only.
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
