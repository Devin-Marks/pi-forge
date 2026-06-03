# Configuration

pi-forge has four configuration surfaces:

1. **CLI flags** on the `pi-forge` command — see below
2. **Environment variables** — same surface as flags, lower precedence
3. **Pi SDK config files** under `${PI_CONFIG_DIR}` — provider keys,
   custom models, agent defaults
4. **Per-project overrides** under `${FORGE_DATA_DIR}` — toggle which
   skills, tools, and pi-prompts apply per project

## CLI flags

Every server env var has an equivalent kebab-case flag. **Flags win
over env when both are set.**

```bash
pi-forge --help                            # grouped flag list
pi-forge --port 4000 --workspace-path ~/Code
pi-forge --no-expose-docs --minimal-ui
pi-forge --api-key @/run/secrets/api-key   # @<path> reads from file
```

- **Sensitive flags** (`--ui-password`, `--api-key`, `--jwt-secret`,
  `--ldap-bind-password`) accept `@<path>` to read from a file (keeps
  secrets out of shell history and `ps`). Environment variables do not
  use `@` expansion; use the dedicated `*_FILE` env vars for mounted
  secret files.
- **Boolean flags** accept `true|false|on|off|1|0|yes|no`. Bare
  `--flag` means `true`; `--no-flag` means `false`.

[`packages/server/src/cli.ts`](../packages/server/src/cli.ts) is the
single source of truth — adding a new env var means adding one row to
the `FLAGS` table there.

## Environment variables

The exhaustive list lives in `pi-forge --help` (and the `FLAGS` table
in `cli.ts`). The most-touched ones:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Fastify listen port. |
| `HOST` | `127.0.0.1` | Loopback by default — set `0.0.0.0` to expose to the LAN. The shipped Dockerfile pins `0.0.0.0` so `docker compose up` works unchanged. |
| `WORKSPACE_PATH` | `~/.pi-forge/workspace` | Where project code lives. Point at an existing dir (e.g. `~/Code`) to reuse code on disk. |
| `PI_CONFIG_DIR` | `~/.pi/agent` | Pi SDK config dir (`auth.json`, `models.json`, `settings.json`). |
| `FORGE_DATA_DIR` | `~/.pi-forge` | Pi-forge state — `projects.json`, override files, `jwt-secret`, `password-hash`. |
| `UI_PASSWORD` | (unset) | Enables browser JWT auth. Literal env value only; it does not expand `@/path`. After the user changes it via the UI, a scrypt hash is persisted to `${FORGE_DATA_DIR}/password-hash` and the env value is ignored. |
| `UI_PASSWORD_FILE` | (unset) | File containing the browser login password (for Kubernetes/OpenShift mounted Secrets). Takes precedence over `UI_PASSWORD`. Equivalent CLI: `--ui-password-file`; CLI `--ui-password @/path` is also supported. |
| `API_KEY` | (unset) | Static bearer token for programmatic access. |
| `JWT_SECRET` | (auto-generated) | HS256 signing key. Auto-generated and persisted to `${FORGE_DATA_DIR}/jwt-secret` (mode 0600) when `UI_PASSWORD`, LDAP auth, or `password-hash` is in play. Set explicitly (`openssl rand -hex 32`) to override; delete the file to rotate. |
| `LDAP_ENABLED` | `false` | Enables LDAP username/password browser login. Requires the LDAP variables below. |
| `LDAP_URL` | (unset) | LDAP server URL, e.g. `ldap://ldap.example.com:389` or `ldaps://ldap.example.com:636`. |
| `LDAP_BIND_DN` | (unset) | Service-account bind DN used only to search for the user entry. |
| `LDAP_BIND_PASSWORD` | (unset) | Service-account bind password. Literal env value only; it does not expand `@/path`. Prefer `LDAP_BIND_PASSWORD_FILE` or `--ldap-bind-password @/path` for secret mounts. |
| `LDAP_BIND_PASSWORD_FILE` | (unset) | File containing the service-account password (for Kubernetes/OpenShift mounted Secrets). Takes precedence over `LDAP_BIND_PASSWORD`. |
| `LDAP_BASE_DN` | (unset) | Base DN for user searches. |
| `LDAP_USER_FILTER` | `(|(uid={{username}})(sAMAccountName={{username}})(mail={{username}}))` | Search filter. `{{username}}` is escaped per RFC4515 before substitution. Must match exactly one user. |
| `LDAP_REQUIRED_GROUP_DN` | (unset) | Optional required group DN. When set, the user's `memberOf` values must include it. |
| `LDAP_GROUP_ATTRIBUTE` | `memberOf` | User attribute checked for group DNs. Change only for directories that expose group membership under a different attribute. |
| `LDAP_TIMEOUT_MS` | `5000` | LDAP connect/operation timeout in milliseconds. |
| `LDAP_TLS_REJECT_UNAUTHORIZED` | `true` | Reject untrusted TLS certificates for `ldaps://` connections. Set `false` only for local/self-signed testing. |
| `MINIMAL_UI` | `false` | Hide terminal / git / last-turn / providers / agent-settings panels. Frontend gate; server routes unchanged. ALSO hard-disables webhook configuration, session orchestration, and the quick-actions runner. |
| `TRUST_PROXY` | `false` | Set when behind a reverse proxy so `req.ip` is the real client (required for per-user login rate limits). |
| `ORCHESTRATION_DISABLED` | `false` | Disable the chat-view `Orch` toggle and orchestration REST/tool surface. Orchestration is enabled by default; hard-disabled under `MINIMAL_UI` regardless. See [`orchestration.md`](./orchestration.md). |
| `ORCHESTRATION_ENABLED` | `true` | Legacy compatibility switch. `false` disables orchestration; `true`/unset keep the default enabled behavior. Prefer `ORCHESTRATION_DISABLED=true` for new deployments. |
| `ORCHESTRATION_MAX_WORKERS_PER_SUPERVISOR` | `8` | Per-supervisor live-worker cap. Bounded to `[1, 100]`. |
| `AGENT_TOOL_SANDBOX_ENABLED` | `false` | Opt-in identity/path sandbox for model/user tool surfaces. When `true`, `AGENT_TOOL_UID` and `AGENT_TOOL_GID` are required. |
| `AGENT_TOOL_UID` | (unset) | Numeric UID used for sandboxed bash/process/terminal/quick-action/exec children. Required only when sandbox is enabled. |
| `AGENT_TOOL_GID` | (unset) | Numeric GID used for sandboxed bash/process/terminal/quick-action/exec children. Required only when sandbox is enabled. |

Production-tuning knobs (rate limits, JWT lifetime, TLS / proxy posture)
are documented in [`deployment.md`](./deployment.md).

### Agent tool identity sandbox

The identity sandbox is off by default and has a strict mount-permission
contract. Read [`agent-tool-sandbox.md`](./agent-tool-sandbox.md) before
enabling it. In short: pi-forge runs the server as root, drops
model/user shell surfaces to `AGENT_TOOL_UID:GID`, scopes model file
access, and requires workspace / Pi config / forge data mounts to have
specific ownership and mode bits.

When this mode is enabled, LDAP bind password file references are
rejected (`LDAP_BIND_PASSWORD_FILE` and CLI/env `@file` forms). Use a
literal environment value or an external secret broker instead; child
tool processes receive the scrubbed env and do not inherit it.

### LDAP browser login

LDAP is opt-in and off by default. When `LDAP_ENABLED=true`, pi-forge's
login form asks for a username and password. Username `admin` (and
password-only API calls) always use the local pi-forge admin password
from `UI_PASSWORD`, `UI_PASSWORD_FILE`, or the persisted password hash;
all other usernames use LDAP. The server binds with the
configured service account, searches under `LDAP_BASE_DN` using
`LDAP_USER_FILTER`, optionally checks the returned user's `memberOf`
(or `LDAP_GROUP_ATTRIBUTE`) against `LDAP_REQUIRED_GROUP_DN`, and then
binds as the returned user DN with the presented password. A successful
LDAP bind issues the same pi-forge JWT used by local `UI_PASSWORD`
login. API-key auth is unchanged, and protected routes still require a
valid bearer JWT or API key.

Minimal example:

```bash
LDAP_ENABLED=true
LDAP_URL=ldaps://ldap.example.com:636
LDAP_BIND_DN='cn=pi-forge,ou=svc,dc=example,dc=com'
LDAP_BIND_PASSWORD_FILE=/run/secrets/ldap-bind-password
LDAP_BASE_DN='ou=people,dc=example,dc=com'
LDAP_REQUIRED_GROUP_DN='cn=pi-forge-users,ou=groups,dc=example,dc=com'
# Local/self-signed test only:
# LDAP_TLS_REJECT_UNAUTHORIZED=false
```

`LDAP_BIND_PASSWORD_FILE` is intended for Kubernetes/OpenShift mounted
Secrets and takes precedence over `LDAP_BIND_PASSWORD`. `LDAP_BIND_PASSWORD`
is always a literal password value; unlike CLI sensitive flags, env vars
are not `@`-expanded. The password is read only in `config.ts`, never
returned by any API, and redacted from request logs. Do not put
service-account passwords in container images or command-line history;
use a mounted secret file or the CLI `--ldap-bind-password @/path/to/file`
form instead.

If both LDAP and local `UI_PASSWORD` / `UI_PASSWORD_FILE` / stored-password
auth are present, username `admin` and password-only login use the local
pi-forge password. Other usernames use LDAP. The username `admin` is
reserved for local pi-forge admin auth while LDAP is enabled; an LDAP
account named `admin` cannot be used unless this policy changes later.
This preserves existing single-tenant admin access while allowing LDAP
to be enabled during migration. LDAP login attempts write sanitized
`[ldap]` lines to the server logs with the URL, base DN, username, TLS
validation mode, and failure category; passwords are not logged.

## Pi SDK config files

The pi SDK owns three JSON files under `${PI_CONFIG_DIR}` (default
`~/.pi/agent`). Pi-forge reads/writes them through the
`/api/v1/config/*` routes; never `fs.*` them from a route handler.

```
${PI_CONFIG_DIR}/
├── auth.json          — provider API keys + OAuth tokens
├── models.json        — custom provider definitions
└── settings.json      — agent defaults (model, thinking level, modes)
```

In `MINIMAL_UI` mode all three Settings tabs are hidden. Edit the files
directly and restart the server.

### `auth.json` — provider API keys

```json
{
  "anthropic": { "apiKey": "sk-ant-..." },
  "openai":    { "apiKey": "sk-..." }
}
```

Surfaced in **Settings → Providers** as a presence-only list (green
dot = configured, "Add key" otherwise). Key values **never** leave the
server — `config-manager.ts`'s `readAuthSummary()` enforces this. Adding
a key: `PUT /api/v1/config/auth/:provider` with `{ apiKey }`. Removing:
`DELETE`. Writes are atomic (`tmp + rename`).

### `models.json` — custom provider definitions

Built-in providers (Anthropic, OpenAI, Google, OpenRouter, Bedrock,
Vertex, etc.) are baked into pi-ai. Use `models.json` only for **custom
OpenAI-compatible endpoints** — vLLM, LiteLLM, Ollama, llama.cpp, an
internal proxy.

```json
{
  "providers": {
    "vllm-local": {
      "api": "openai-completions",
      "url": "http://localhost:8000/v1",
      "models": [
        {
          "id": "Qwen/Qwen2.5-Coder-32B-Instruct",
          "name": "Qwen 2.5 Coder 32B (vLLM)",
          "contextWindow": 32000,
          "maxTokens": 8000,
          "input": ["text"],
          "reasoning": false,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

**Per-model fields:**

| Field | Type | Notes |
|---|---|---|
| `id` | string | Exact `model` value the provider expects in API requests |
| `name` | string | Display name in the model picker |
| `contextWindow` | number | Input-token budget; drives the Context Inspector bar |
| `maxTokens` | number | Output cap; pi clamps `max_tokens` to this |
| `input` | `("text" \| "image")[]` | Image-capable models accept multipart attachments |
| `reasoning` | boolean | True for thinking-block models (o1, Claude w/ thinking, …); surfaces the thinking-level selector |
| `cost` | `{ input, output, cacheRead, cacheWrite }` USD per 1M tokens | Required. Set to `0` for self-hosted endpoints; copy upstream rates for commercial ones |

**Per-provider `api` field** picks the protocol adapter:

- `openai-completions` — `/v1/chat/completions` (OpenAI, vLLM, LiteLLM, Ollama, llama.cpp)
- `openai-responses` — OpenAI Responses API
- `anthropic-messages` — Anthropic Messages API
- `google-generative-ai` — Google Generative Language API
- `bedrock-converse-stream` — AWS Bedrock Converse (streaming)

Surfaced in **Settings → Providers** under a collapsible "Custom
providers" section with a raw-JSON editor (gated behind `<details>` so
casual users don't clobber it). Reads via `GET /api/v1/config/models`,
writes via `PUT` (full-document replace; pi-ai validates per-provider
schemas at session create).

### `settings.json` — agent defaults

Defaults applied to new sessions:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5-20250929",
  "defaultThinkingLevel": "medium"
}
```

| Field | Values | Notes |
|---|---|---|
| `defaultProvider` | provider key | Picked by new sessions when no per-session model is set |
| `defaultModel` | model id from the chosen provider | Same |
| `defaultThinkingLevel` | `minimal` / `low` / `medium` / `high` / `xhigh` | Reasoning-capable models only |

Other SDK keys are accepted by `PUT /api/v1/config/settings` and persist
verbatim. Pi-forge's typed form covers the common ones; an "Edit as
JSON" toggle exposes the long tail. The route shallow-merges so unknown
fields the SDK adds in future versions don't get clobbered.

**Per-session model override.** The chat-input model picker overrides
the default for one session, persisted in browser localStorage
(`pi-forge/model/<sessionId>`). It does NOT touch `settings.json` — the
SDK's `setModel` would mutate the global default, but `routes/control.ts`
snapshot-and-restores around the call to keep the override scoped.

## Per-project overrides

Pi-forge keeps three forge-private override files in `${FORGE_DATA_DIR}`
that gate which skills, tools, and pi-prompt templates apply per
project. Each follows the same pattern: a JSON map keyed by `projectId`,
with values using pi's pattern syntax (`!name` excludes, `+name`
force-includes; absence of `!name` means enabled by default).

| File | Surface | Purpose |
|---|---|---|
| `skills-overrides.json` | Settings → Skills | Per-project skill enable/disable. Skills themselves live in `<project>/.pi/skills/*.md` and `~/.pi/agent/skills/*.md`; this file just gates which apply |
| `tool-overrides.json` | Settings → Tools | Per-project enable/disable for built-in tools (`bash`, `edit`, `read`, …) and per-MCP-tool toggles |
| `prompts-overrides.json` | Settings → Prompts | Per-project pi-prompt-template enable/disable. Templates live in `<project>/.pi/prompts/*.md` and `~/.pi/agent/prompts/*.md` |

The merged effective list is rebuilt at every `createAgentSession` call
via `agent-resource-loader.ts`. Toggling in Settings refreshes the chat
input's slash palette without a project switch (cross-tab signal via
`ui-store`).

These files are **forge-private**, not pi-side state — pi has no native
concept of per-project skill/tool toggles. Backups via Settings → Backup
include them so a restore preserves per-project preferences.

## MCP servers

MCP server definitions live in `${FORGE_DATA_DIR}/mcp.json` (global)
and `<project>/.mcp.json` (project-scoped). Manage via **Settings →
MCP** or edit the files directly. See [`mcp.md`](./mcp.md) for the
field reference, transport options, auth model, and troubleshooting.

## Pi plugins

The pi CLI installs community plugins with `pi install npm:<package>`.
Plugin sources land under `${PI_CONFIG_DIR}/packages/<name>` and
register additional tools at session-creation time. Because
`PI_CONFIG_DIR` is bind-mounted into the container, host-side
`pi install` automatically exposes the plugin to the container too.

The most common community plugin is
[`pi-subagents`](https://github.com/nicobailon/pi-subagents), which
adds a `subagent` tool for delegating to spawned child sessions.
Install with `pi install npm:pi-subagents`; pi-forge picks it up with
no extra config and renders the result as a rich card in the chat
(integration detail in `CLAUDE.md` if you're modifying the discovery
or render path).

## Docker bind mounts

The shipped `docker-compose.yml` mounts these paths by default:

| Container path | Default host path | Notes |
|---|---|---|
| `/home/pi/.pi/agent` | `${PI_CONFIG_HOST_PATH:-~/.pi/agent}` | Shared with host pi CLI by default — same provider keys, custom providers, agent defaults |
| `/home/pi/.pi-forge` | `${FORGE_DATA_HOST_PATH:-~/.pi-forge-docker}` | **Separate** from the host's `~/.pi-forge` so the container has its own project list — host project paths wouldn't resolve inside the container anyway |
| `/workspace` | `${WORKSPACE_HOST_PATH:-../workspace}` | User code; sessions under `.pi/sessions/` here |

See [`containers.md`](./containers.md) for UID/GID handling, image
internals, and override env vars.

## See also

- [`deployment.md`](./deployment.md) — production deploy with TLS at a
  reverse proxy
- [`mobile.md`](./mobile.md) — mobile / PWA install
- [`containers.md`](./containers.md) — container internals + bind mounts
- [`mcp.md`](./mcp.md) — MCP server config reference (remote + stdio)
- [`webhooks.md`](./webhooks.md) — HTTPS POSTs on agent/session events
- [`orchestration.md`](./orchestration.md) — supervisor sessions that
  spawn and coordinate worker sessions
- [`processes.md`](./processes.md) — background-process tool the
  agent uses for dev servers, watchers, builds
- [`todo.md`](./todo.md) — browser-native `todo` tool
- [`ask-user-question.md`](./ask-user-question.md) — browser-native
  `ask_user_question` tool
- [`quick-actions.md`](./quick-actions.md) — operator-defined chat
  toolbar chips (shell commands + prompt templates)
- [`SECURITY.md`](../SECURITY.md) — `auth.json` key safety + threat model
