# Agent tool identity sandbox

`AGENT_TOOL_SANDBOX_ENABLED=false` by default. In the Docker image, the default
entrypoint drops the server to the legacy `pi` user. When sandbox mode is
enabled, pi-forge keeps the HTTP server running as root and runs model/user
tool surfaces as a restricted UID/GID (`pi-tools` in the Docker image).

This is an operator-controlled hardening mode. It is useful only when the
container or pod mounts are permissioned carefully.

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

- model file tools cannot read outside allowed roots
- model file tools cannot read protected Pi config files:
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
the workspace.

## Required mount permissions

Regular/non-sandbox mode keeps the historical simple contract: the server runs
as `pi`, and mounted workspace/config/data paths should be writable by `pi`.
Sandbox mode is different and requires the split below.

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
mode (`pi` owns `/home/pi/.pi` and `/home/pi/.pi-forge`). Enabling sandbox with
bind mounts or persistent volumes is an explicit operator step: adjust the mount
permissions to the table above before relying on filesystem isolation. Switching
an existing deployment between regular and sandbox mode may require changing
volume ownership/modes.

## Native Linux host example

On native Linux bind mounts, host numeric ownership is normally what the
container sees. With default Docker sandbox IDs (`1001:1001`), run this on the
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
# IMPORTANT: include the parent ~/.pi directory, not only ~/.pi/agent,
# otherwise pi-tools cannot traverse into the mounted agent dir.
sudo chown root:1001 ~/.pi
sudo chmod 0750 ~/.pi
sudo chown -R root:1001 ~/.pi/agent
sudo find ~/.pi/agent -type d -exec chmod 0750 {} +
sudo find ~/.pi/agent -type f -exec chmod 0640 {} +

# Pi config secrets: server-only.
sudo chown root:root ~/.pi/agent/auth.json ~/.pi/agent/models.json ~/.pi/agent/settings.json 2>/dev/null || true
sudo chmod 0600 ~/.pi/agent/auth.json ~/.pi/agent/models.json ~/.pi/agent/settings.json 2>/dev/null || true
```

Then in `docker/.env`:

```txt
AGENT_TOOL_SANDBOX_ENABLED=true
AGENT_TOOL_UID=1001
AGENT_TOOL_GID=1001
```

Rebuild/recreate:

```bash
cd docker
docker compose down
docker compose up -d --build
```

## Docker Desktop / OrbStack / macOS note

On macOS file-sharing layers, bind-mount ownership can be virtualized. A host
path owned by your macOS user may appear as `pi`, `pi-tools`, or another mapped
identity inside the container. In some cases, ownership may appear differently
from a root shell and from the restricted app terminal.

Always verify inside the running container:

```bash
docker compose exec pi-forge sh -lc '
id
id pi-tools
stat -c "%u:%g %a %n" /workspace /home/pi/.pi /home/pi/.pi/agent /home/pi/.pi-forge
'
```

Then verify from the app terminal:

```bash
id
stat -c "%u:%g %a %n" /workspace /home/pi/.pi /home/pi/.pi/agent /home/pi/.pi-forge
cat /home/pi/.pi-forge/jwt-secret
```

If the restricted terminal can read `.pi-forge`, the host bind mount cannot
reliably test this isolation. Use Docker named volumes for sensitive mounts
while testing on macOS/OrbStack.

If host-side ownership changes are ignored or translated, apply the sandbox
permissions from a root shell **inside the running container** instead:

```bash
docker compose exec pi-forge sh -lc '
# Workspace: writable by pi-tools.
chown -R pi-tools:pi-tools /workspace
chmod -R u+rwX,g+rwX,o-rwx /workspace

# Forge data: server-only.
chown -R root:root /home/pi/.pi-forge
chmod -R u+rwX,go-rwx /home/pi/.pi-forge

# Pi config: pi-tools can traverse/read non-secret resources.
chown root:pi-tools /home/pi/.pi
chmod 0750 /home/pi/.pi
chown -R root:pi-tools /home/pi/.pi/agent
find /home/pi/.pi/agent -type d -exec chmod 0750 {} +
find /home/pi/.pi/agent -type f -exec chmod 0640 {} +

# Pi config secrets: server-only.
chown root:root /home/pi/.pi/agent/auth.json /home/pi/.pi/agent/models.json /home/pi/.pi/agent/settings.json 2>/dev/null || true
chmod 0600 /home/pi/.pi/agent/auth.json /home/pi/.pi/agent/models.json /home/pi/.pi/agent/settings.json 2>/dev/null || true

stat -c "%U:%G %u:%g %a %n" /workspace /home/pi/.pi /home/pi/.pi/agent /home/pi/.pi-forge
'
```

## Docker Compose requirements

The server must be able to switch child identity. Compose therefore needs:

```yaml
cap_drop:
  - ALL
cap_add:
  - SETUID
  - SETGID
security_opt:
  - no-new-privileges:true
```

No privileged mode or host PID is required.

## Kubernetes / OpenShift requirements

Vanilla Kubernetes example:

```yaml
securityContext:
  runAsUser: 0
  runAsGroup: 0
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
    add: ["SETUID", "SETGID"]
```

OpenShift `restricted-v2` random UID does not support this mode. Use `anyuid`
for a simple deployment, or a custom SCC that allows:

- UID 0 for the server container
- `SETUID`
- `SETGID`
- no privileged mode

Keep SCC RoleBindings in namespace/security bootstrap, not in the
DeploymentConfig.

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
