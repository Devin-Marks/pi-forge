# Configuration

pi-forge's runtime behavior is shaped by **two** layers of configuration:

1. **pi-forge env vars** — read by `packages/server/src/config.ts` at
   startup. Controls ports, paths, auth, and the `MINIMAL_UI` frontend
   gate. Documented in [Environment variables](#environment-variables) below.
2. **Pi SDK config files** — JSON files under `${PI_CONFIG_DIR}` (default
   `~/.pi/agent`, container `/home/pi/.pi/agent`). Owned by the pi SDK,
   surfaced by the pi-forge's Settings panel and the
   `/api/v1/config/*` routes. See [Pi SDK config files](#pi-sdk-config-files)
   below.

## CLI flags

Every server env var below has an equivalent kebab-case flag on the
`pi-forge` command. **Flags win when both are set** — `pi-forge --port
4000` overrides `PORT=3000` in the environment. When no flag is given,
the existing env value persists. The flag table is exhaustive — anything
you'd set with `FOO_BAR=value` you can pass as `--foo-bar value`.

```bash
pi-forge --help              # full grouped flag list
pi-forge --port 4000 --workspace-path ~/Code
pi-forge --no-expose-docs --minimal-ui
```

**Sensitive flags** (`--ui-password`, `--api-key`, `--jwt-secret`)
accept `@<path>` to read the value from a file instead of argv (avoids
shell history / `ps` leakage):

```bash
pi-forge --api-key @/run/secrets/api-key
```

**Boolean flags** accept `true|false|on|off|1|0|yes|no`. Bare `--flag`
means `true`; `--no-flag` means `false`.

The single source of truth is
[`packages/server/src/cli.ts`](../packages/server/src/cli.ts) — adding a
new env var means adding one row to the `FLAGS` table there, which
auto-derives the parser, the `process.env` writes, and the `--help`
output.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | Fastify listen port. |
| `HOST` | `127.0.0.1` | Bind address. Defaults to loopback so a fresh install can't accidentally expose the agent's `bash`/`edit` tools to anyone on the same network. Set to `0.0.0.0` to expose to the LAN or to make Docker port-forwarding work (the shipped Dockerfile already does this). |
| `LOG_LEVEL` | `info` | Pino log level. |
| `WORKSPACE_PATH` | `~/.pi-forge/workspace` | Where project code lives. Docker image overrides to `/workspace` (mounted from host). Point at an existing dir (e.g. `~/Code`) to reuse code you already have on disk. |
| `PI_CONFIG_DIR` | `~/.pi/agent` | Pi SDK config dir (auth.json, models.json, settings.json — owned by the SDK). The Docker image overrides this to `/home/pi/.pi/agent` (mounted from the host's `~/.pi/agent`). |
| `FORGE_DATA_DIR` | `~/.pi-forge` | pi-forge-owned state (projects.json). Defaults to the same dotdir as the workspace (`projects.json` sits alongside `workspace/`). Kept separate from `PI_CONFIG_DIR` so we don't mix our state into the pi SDK's directory. Docker image points this at `/home/pi/.pi-forge` (mounted from the host's `~/.pi-forge-docker` by default — container has its own project list). |
| `CLIENT_DIST_PATH` | `<server-dist>/../../client/dist` | Built Vite output served by Fastify in production. |
| `SERVE_CLIENT` | `true` | Set to `false` to skip static-serving (useful when running the dev Vite server in front of the API). |
| `SESSION_DIR` | `${WORKSPACE_PATH}/.pi/sessions` | JSONL session storage. |
| `UI_PASSWORD` | (unset) | If set, enables browser JWT auth. `JWT_SECRET` is auto-generated on first boot if not supplied. After the user changes it via the UI, a scrypt hash is persisted to `${FORGE_DATA_DIR}/password-hash` and this env var is ignored on subsequent logins. |
| `REQUIRE_PASSWORD_CHANGE` | `false` | When `true` and the user logs in with the env-supplied `UI_PASSWORD` and no on-disk hash exists yet, the issued token is scoped to `POST /auth/change-password` and the UI forces the user to pick a new password before continuing. Defaults to `false` because pi-forge is single-tenant and a user setting their own `--ui-password` does so deliberately — forcing them to change it is friction without a real win. Set to `true` for deployments where `UI_PASSWORD` comes from a sealed secret (helm, docker-compose `.env`, vault) and should be rotated by the operator on first login. |
| `JWT_SECRET` | (unset, auto-generated) | HS256 signing key. **Optional** — when `UI_PASSWORD` is set and `JWT_SECRET` is not, the server generates one and persists it to `${FORGE_DATA_DIR}/jwt-secret` (mode 0600). The data dir is already a PVC / bind-mount in K8s and Docker, so tokens survive restarts with no extra wiring. Set this env var to override (e.g. `openssl rand -hex 32`). Delete the file to rotate. |
| `API_KEY` | (unset) | Static bearer token for programmatic access. |
| `JWT_EXPIRES_IN_SECONDS` | `604800` | JWT lifetime (default 7 d). |
| `RATE_LIMIT_LOGIN_MAX` | `10` | Max `/auth/login` attempts per window. |
| `RATE_LIMIT_LOGIN_WINDOW_MS` | `60000` | Login rate-limit window (ms). |
| `CORS_ORIGIN` | (reflect request origin) | Pin to a specific origin in production. |
| `TRUST_PROXY` | `false` | Set to `true` when running behind a reverse proxy (nginx, Caddy, Traefik) so `req.ip` reflects the real client IP — required for the login rate limit to work per-user. |
| `MINIMAL_UI` | `false` | Hide terminal / git / last-turn / providers / agent settings. Frontend gate; doesn't disable server routes. |

Production-relevant env tuning (rate limits, JWT lifetime, TLS / proxy
posture) lives in [`deployment.md`](./deployment.md).

## Pi SDK config files

This section covers layer 2 — what each pi config file does, how the
pi-forge reads/writes it, and how to wire up a custom provider.

## File layout

```
${PI_CONFIG_DIR}/
├── auth.json          — provider API keys + OAuth tokens
├── models.json        — custom provider definitions
└── settings.json      — agent defaults (model, thinking level, modes)
```

Skills (per-project Markdown files) live elsewhere — under `.pi/skills/`
inside each project directory and inside `~/.pi/agent/skills/` for global
skills. The pi-forge surfaces them but doesn't own their storage.

## auth.json — provider API keys

The pi SDK stores provider credentials here. Format is owned by the SDK;
schematically:

```json
{
  "anthropic": { "apiKey": "sk-ant-..." },
  "openai":    { "apiKey": "sk-..." },
  "google":    { "apiKey": "..." },
  "openrouter":{ "apiKey": "sk-or-..." }
}
```

Some providers use OAuth and store tokens here instead of bare API keys.
Pi handles the format; the pi-forge doesn't parse it.

### How the pi-forge surfaces it

The Settings → Providers tab shows every provider that has a key
configured (a green dot) or doesn't (an "Add key" button). It uses
**presence-only** information from `GET /api/v1/config/auth` — the
actual key values **never** leave the server. The route is enforced in
`config-manager.ts`'s `readAuthSummary()`; if you find a code path that
returns key values, that's a security bug — file a private advisory.

Adding a key uses `PUT /api/v1/config/auth/:provider` with `{ apiKey }`.
Removing uses `DELETE /api/v1/config/auth/:provider`. Both write
atomically (`tmp + rename`) so you can't end up with a corrupted file
on a crash mid-write.

In `MINIMAL_UI` mode the Providers tab is hidden; manage credentials
out-of-band (edit `auth.json` directly, then `kubectl rollout restart`
or `docker compose restart`).

## models.json — custom provider definitions

Built-in providers (Anthropic, OpenAI, Google, OpenRouter, Bedrock,
Vertex, etc.) are baked into pi-ai and don't need entries here. Use
`models.json` only for **custom** OpenAI-compatible endpoints — vLLM,
LiteLLM, Ollama, llama.cpp's `--api`, your company's internal proxy.

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
    },
    "ollama": {
      "api": "openai-completions",
      "url": "http://localhost:11434/v1",
      "models": [
        {
          "id": "llama3.1:70b",
          "name": "Llama 3.1 70B (Ollama)",
          "contextWindow": 128000,
          "maxTokens": 4000,
          "input": ["text"],
          "reasoning": false,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

### Field reference (per model entry)

| Field | Type | Notes |
|---|---|---|
| `id` | string | The exact `model` value the provider expects in API requests |
| `name` | string | Display name in the model picker |
| `contextWindow` | number | Tokens the model accepts as input. The Context Inspector uses this for the "context window" bar. |
| `maxTokens` | number | Max output tokens per response. Pi clamps `max_tokens` in API calls to this. |
| `input` | `("text" \| "image")[]` | What content types the model accepts. Image-capable models can receive multipart attachments. |
| `reasoning` | boolean | True if the model supports thinking / extended-reasoning blocks (OpenAI o1, Claude Sonnet 4.5 with thinking, etc.). Surfaces the thinking-level selector in Settings → Agent. |
| `cost` | `{ input, output, cacheRead, cacheWrite }` (numbers, USD per 1M tokens) | Required by the SDK type. Surfaces in the Context Inspector's per-turn cost telemetry. Set every field to `0` for self-hosted endpoints (vLLM, Ollama, llama.cpp) where you don't pay per token; for OpenAI-compatible commercial endpoints, copy the upstream provider's published rates. Without a `cost` block the model entry is rejected on next session creation. |

### Provider `api` field

Each provider entry's `api` field tells pi-ai which protocol adapter to use:

- `openai-completions` — `/v1/chat/completions` shape (OpenAI, vLLM,
  LiteLLM, Ollama, llama.cpp)
- `openai-responses` — OpenAI's newer Responses API
- `anthropic-messages` — Anthropic's Messages API
- `google-generative-ai` — Google's Generative Language API
- `bedrock-converse-stream` — AWS Bedrock Converse API (streaming)

For most third-party endpoints you'll use `openai-completions`. Check the
endpoint's docs to confirm wire-format compatibility.

### How the pi-forge surfaces it

Settings → Providers shows a collapsible "Custom providers (models.json)"
section with a raw-JSON editor. The editor is gated behind a `<details>`
to keep casual users from accidentally clobbering it; a typed form per
provider type is deferred to Phase 18 polish.

Reads via `GET /api/v1/config/models`, writes via
`PUT /api/v1/config/models` (full-document replace; the route validates
`{ providers: {...} }` shape but doesn't validate per-provider schemas
— pi-ai validates on next session creation).

In `MINIMAL_UI` mode this surface is hidden. Edit `models.json` directly
and restart.

## settings.json — agent defaults

Pi-side defaults that apply to new sessions:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5-20250929",
  "defaultThinkingLevel": "medium",
  "steeringMode": "all",
  "followUpMode": "all"
}
```

| Field | Values | Notes |
|---|---|---|
| `defaultProvider` | A provider key (`anthropic`, `openai`, `google`, custom from `models.json`, etc.) | Picked by new sessions when no per-session model is set. |
| `defaultModel` | A model id from the chosen provider | Same. |
| `defaultThinkingLevel` | `minimal` / `low` / `medium` / `high` / `xhigh` | For reasoning-capable models. Lower = faster + cheaper; higher = better at hard problems. |
| `steeringMode` | `all` / `one-at-a-time` | How the SDK delivers queued steering messages. `all` flushes the entire queue in one delivery to the agent at the next opportunity; `one-at-a-time` waits for the agent's response between queued messages. The per-call `mode` body field on `POST /sessions/:id/steer` is independent (`steer` vs `followUp` — that's the WHEN of delivery, not the BATCHING). |
| `followUpMode` | `all` / `one-at-a-time` | Same shape as `steeringMode` but for follow-up messages (delivered after the agent goes fully idle rather than at the next tool-call boundary). |

Other SDK keys (less commonly tuned) are accepted by the
`PUT /api/v1/config/settings` route and persist in this file.

### How the pi-forge surfaces it

Settings → Agent is a typed form for the common fields plus an
"Edit as JSON" toggle for the long tail of SDK keys. Form changes
fire `PUT /api/v1/config/settings` with a partial patch (Fastify
shallow-merges into the existing file).

The route preserves unknown fields the SDK might add in future
versions — you won't lose data by editing through the form.

### Per-session model override

The Settings → Agent default is the **fallback**. The chat input has a
model picker that overrides per-session. The override persists in
browser localStorage (`pi-forge/model/<sessionId>`) and re-applies
on session switch. It does NOT modify `settings.json`.

(See the commit history around `routes/control.ts:setModel` for the
gory details — the SDK's `setModel` writes the global default as a
side effect, which the pi-forge undoes by snapshot-and-restore around
the call so per-session selection doesn't mutate the global default.)

## Per-project skills

Pi supports project-scoped skill files (Markdown files with YAML
frontmatter the agent loads as additional instructions). They live
under:

- **Project-local:** `<project-path>/.pi/skills/*.md`
- **Global:** `~/.pi/agent/skills/*.md` — available across all projects

The pi-forge's Settings → Skills tab shows the merged list (global +
project-local) for the active project, with a toggle per skill to
enable/disable for THIS project. Disable state writes to the project's
`settings.json`; the skill files themselves are untouched.

## Container ergonomics

Inside Docker, the bind mounts are:

| Container path | Default host path | What lives here |
|---|---|---|
| `/home/pi/.pi/agent` | `~/.pi/agent` | `auth.json`, `models.json`, `settings.json` (shared with host pi CLI by default) |
| `/home/pi/.pi-forge` | `~/.pi-forge-docker` | `projects.json` (separate from host's `~/.pi-forge`) |
| `/workspace` | `../workspace` (relative to compose file) | User code; sessions under `.pi/sessions/` here |

Sharing `~/.pi/agent` with the host means the host CLI and the container
see the same provider keys + custom providers + agent defaults. Set
`PI_CONFIG_HOST_PATH` to a different host directory if you want
container-isolated config.

`projects.json` defaults to a SEPARATE host directory because mixing the
host CLI's project list with the container's would mean the container
can see projects whose paths point inside the host's home directory —
they'd resolve to invalid paths inside the container's filesystem.
Setting both to the same host path requires also using the same
workspace path semantics.

## MCP servers

MCP server definitions live in `${FORGE_DATA_DIR}/mcp.json` (global)
and `<projectPath>/.mcp.json` (project-scoped). Manage them from the
**Settings → MCP** tab in the browser, or edit the files directly. See
[`mcp.md`](./mcp.md) for the field reference, transport options,
auth model, and troubleshooting.

## Pi plugins

The pi CLI supports community plugins installed via
`pi install npm:<package>`. Plugin sources land under
`${PI_CONFIG_DIR}/packages/<name>` and register additional tools at
session-creation time. Because `PI_CONFIG_DIR` (default `~/.pi/agent`)
is bind-mounted into the container, host-side `pi install` automatically
exposes the plugin to the container as well.

### pi-subagents

[`pi-subagents`](https://github.com/nicobailon/pi-subagents) adds a
`subagent` tool that lets the agent delegate work to spawned child
sessions, sequentially or in parallel. pi-forge surfaces it without
extra config:

- Child sessions are discovered on disk under the parent's directory
  (`<sessionDir>/<projectId>/<basenameOfParentJsonl>/<runId>/run-N/session.jsonl`)
  and rendered nested under their parent in the session sidebar.
- The `subagent` tool result renders as a rich card with one row per
  child + a one-click jump into each child session.
- The project's session list refetches on every `subagent`
  `tool_execution_end` so newly spawned children appear without a
  manual refresh, and on parent dispose so cascade-deleted children
  disappear.
- Container-side, the plugin's `spawn("pi", ...)` works because
  `/app/node_modules/.bin` is on PATH (the `pi` CLI ships as a bin
  shim of `@earendil-works/pi-coding-agent`, which pi-forge already
  depends on).

To install: `pi install npm:pi-subagents` on the host. The plugin
files travel into the container via the mounted `~/.pi/agent`; no
in-container install step is needed.

## See also

- [`README.md`](../README.md) — pi-forge env vars + Docker quickstart
- [`docs/deployment.md`](./deployment.md) — production deploy with TLS +
  reverse proxy + auth
- [`docs/CONTAINERS.md`](./CONTAINERS.md) — container internals + bind
  mounts + UID/GID handling
- [`docs/architecture.md`](./architecture.md) — what config-manager.ts
  does + how the routes wire it
- [`SECURITY.md`](../SECURITY.md) — auth.json key safety + threat model
