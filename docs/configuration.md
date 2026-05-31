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

- **Sensitive flags** (`--ui-password`, `--api-key`, `--jwt-secret`)
  accept `@<path>` to read from a file (keeps secrets out of shell
  history and `ps`).
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
| `UI_PASSWORD` | (unset) | Enables browser JWT auth. After the user changes it via the UI, a scrypt hash is persisted to `${FORGE_DATA_DIR}/password-hash` and the env value is ignored. |
| `API_KEY` | (unset) | Static bearer token for programmatic access. |
| `JWT_SECRET` | (auto-generated) | HS256 signing key. Auto-generated and persisted to `${FORGE_DATA_DIR}/jwt-secret` (mode 0600) when `UI_PASSWORD` or `password-hash` is in play. Set explicitly (`openssl rand -hex 32`) to override; delete the file to rotate. |
| `MINIMAL_UI` | `false` | Hide terminal / git / last-turn / providers / agent-settings panels. Frontend gate; server routes unchanged. ALSO hard-disables webhook configuration, session orchestration, and the quick-actions runner. |
| `TRUST_PROXY` | `false` | Set when behind a reverse proxy so `req.ip` is the real client (required for per-user login rate limits). |
| `ORCHESTRATION_ENABLED` | `false` | Surface the chat-view `Orch` toggle so sessions can opt in to supervisor mode (`orchestrate_*` tool group, worker spawning, inbox). Hard-disabled under `MINIMAL_UI` regardless. See [`orchestration.md`](./orchestration.md). |
| `ORCHESTRATION_MAX_WORKERS_PER_SUPERVISOR` | `8` | Per-supervisor live-worker cap. Bounded to `[1, 100]`. |
| `TELEMETRY_ENABLED` | `false` | Opt in to OpenTelemetry export. Off by default for local/single-tenant use. |
| `OTEL_SERVICE_NAME` | `pi-forge` | OpenTelemetry `service.name` resource attribute. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` (OpenTelemetry SDK default) | Base OTLP/HTTP collector endpoint. Pi-forge appends `/v1/traces` and `/v1/metrics` unless signal-specific endpoints are set. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | (unset) | Signal-specific OTLP/HTTP traces endpoint. |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | (unset) | Signal-specific OTLP/HTTP metrics endpoint. |
| `OTEL_EXPORTER_OTLP_HEADERS` | (unset) | Comma- or newline-separated `key=value` headers for OTLP exporters. Use `--otel-exporter-otlp-headers @/path` to avoid shell history. |
| `OTEL_TRACES_ENABLED` | `true` | Export traces when `TELEMETRY_ENABLED=true`. |
| `OTEL_METRICS_ENABLED` | `true` | Export metrics when `TELEMETRY_ENABLED=true`. |

Production-tuning knobs (rate limits, JWT lifetime, TLS / proxy posture)
are documented in [`deployment.md`](./deployment.md).

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

## OpenTelemetry

OpenTelemetry is opt-in and disabled by default:

```bash
pi-forge \
  --telemetry-enabled \
  --otel-service-name pi-forge-dev \
  --otel-exporter-otlp-endpoint http://otel-collector:4318
```

Pi-forge uses standards-compatible OTLP/HTTP exporters. You can either set a
base endpoint (`OTEL_EXPORTER_OTLP_ENDPOINT`) or signal-specific endpoints
(`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`).
Exporter headers are supported for collectors that require authentication, but
header values are never logged by pi-forge.

Telemetry intentionally records only low-cardinality operational data:

- HTTP method, Fastify route pattern, status code, request duration/count
- server-side errors and exception class names
- session lifecycle counters/spans (`created`, `resumed`, `disposed`,
  `agent_start`, `agent_end`)

Telemetry does **not** attach prompt text, assistant output, file contents,
provider API keys, auth tokens, OTLP headers, raw URLs with query strings, or raw
workspace/file paths. The pi SDK also has a separate install/update telemetry
setting; pi-forge OpenTelemetry does not change that SDK behavior.

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
