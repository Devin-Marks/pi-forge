# Agent Notes: Configuration

Read this when changing environment variables, CLI flags, pi SDK config files, pi-forge data files, auth summaries, backup import/export, or persisted settings.

## Environment Variables & CLI Flags

**All `process.env` reads are centralized in `packages/server/src/config.ts`.**
Never read `process.env` directly in any other server file — always import the
frozen `config` object from there. The handful of `process.env` reads that DO
live outside config.ts are debug-only (`DEBUG_FETCH`, `DEBUG_AGENT_EVENTS`,
`SHELL`) — keep them out of operational config.

**Every operationally-relevant env var has an equivalent `--flag`** on the
`pi-forge` command. The table in `packages/server/src/cli.ts` is the single
source of truth for the env↔flag mapping. **Adding a new env var means adding
one row to that table** so the flag surface stays in sync. The bin shim
(`bin/pi-forge.mjs`) parses argv and writes the resolved values into
`process.env` BEFORE importing the server, so `config.ts` reads them as if
they came from the environment.

For the full list with defaults and grouping, point users at:

- `pi-forge --help` — grouped flag table generated from `cli.ts`
- [`docs/configuration.md`](../configuration.md) — same content with
  per-variable rationale + Pi SDK config-file context

If both `UI_PASSWORD` and `API_KEY` are unset, auth is disabled entirely.
Production deploys should set at least one. Setting both is common — browser
users log in with the password, scripts use the API key.

`AGENT_TOOL_SANDBOX_ENABLED` defaults false. When true, config startup requires
numeric `AGENT_TOOL_UID` and `AGENT_TOOL_GID`, sandbox shell surfaces receive
`HOME=${AGENT_TOOL_HOME}` (default `/home/pi-tools`), and LDAP bind-password file
references are rejected. Keep sandbox env parsing in `config.ts` and the CLI
surface in `cli.ts` together.

---

## Config Files

The SDK and pi-forge own DIFFERENT directories. Never put pi-forge
state into `PI_CONFIG_DIR` or vice versa.

**`PI_CONFIG_DIR` — pi SDK territory.** Managed by `config-manager.ts`.
Never write directly from routes.

| File | Purpose |
|---|---|
| `PI_CONFIG_DIR/models.json` | Custom providers: vLLM, LiteLLM, Ollama, any OpenAI-compatible endpoint |
| `PI_CONFIG_DIR/auth.json` | API keys and OAuth tokens for built-in providers |
| `PI_CONFIG_DIR/settings.json` | Default model, thinking level, steering/followUp mode |

**`FORGE_DATA_DIR` — pi-forge territory.** Pi-forge owns every file in this
directory. Each one has a dedicated reader/writer module (don't `fs.*` from
route handlers).

| File | Purpose | Owner module |
|---|---|---|
| `projects.json` | Project registry (id/name/path/createdAt) | `project-manager.ts` |
| `mcp.json` | MCP server registry (forge-private — pi has no native MCP) | `mcp/manager.ts` |
| `skills-overrides.json` | Per-project skill enable/disable patterns | `skill-overrides.ts` |
| `tool-overrides.json` | Per-project tool enable/disable (built-ins + MCP) | `tool-overrides.ts` |
| `prompts-overrides.json` | Per-project pi-prompt enable/disable patterns | `prompt-overrides.ts` |
| `theme.json` | Global server-side UI color overrides | `theme-config.ts` |
| `webhooks.json` | Webhook configs (HMAC secrets stored here — mode 0600) | `webhooks/store.ts` |
| `webhook-deliveries.json` | Rolling delivery history (cap 100 / webhook) | `webhooks/store.ts` |
| `session-orchestration.json` | Supervisor opt-in + supervisor↔worker links (mode 0600) | `orchestration/store.ts` |
| `orchestrator-inbox.json` | Per-supervisor pending event queue (cap 200 / supervisor) | `orchestration/store.ts` |
| `jwt-secret` | Auto-generated HS256 signing key (mode 0600) | `config.ts` (`loadOrGenerateJwtSecret`) |
| `password-hash` | scrypt hash of the user's persisted password (mode 0600) | `auth.ts` (`persistPassword`) |

`PI_CONFIG_DIR` defaults to `~/.pi/agent`; `FORGE_DATA_DIR` defaults
to `~/.pi-forge`. The Docker compose setup mounts the host's
`~/.pi/agent` into `/home/pi/.pi/agent` so the container inherits the
host's provider config and API keys, and binds a SEPARATE host path
into `/home/pi/.pi-forge` so the container has its own project
list (host vs container projects don't bleed unless you point both
mounts at the same host path on purpose).

**Legacy migration:** earlier versions stored `projects.json` inside
`PI_CONFIG_DIR`. `project-manager.ts` runs a one-time `rename()` on
first read to move it into `FORGE_DATA_DIR` if the new location
is empty.

**Export / import** (`config-export.ts`, `Settings → Backup` tab):
`GET /api/v1/config/export` streams a flat `.tar.gz` containing
`mcp.json`, `settings.json`, and `models.json`. `POST /api/v1/config/
import` accepts a multipart upload of the same shape and writes each
file atomically. Three deliberate exclusions: `auth.json` (provider
keys / OAuth tokens — sensitive enough that bundling them into a
download the user might forward by accident is the wrong default),
`projects.json` (paths are installation-bound), and the auto-
generated `jwt-secret` / `password-hash` (also installation-bound).
Import is all-or-nothing: every accepted file must parse as JSON
before any rename runs, so a corrupted entry can't half-restore.

---
