<p align="center">
  <img src="docs/images/icon.png" alt="pi-forge" width="120" height="120"/>
</p>

# pi-forge

[![CI](https://github.com/Devin-Marks/pi-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/Devin-Marks/pi-forge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Devin-Marks/pi-forge?sort=semver)](https://github.com/Devin-Marks/pi-forge/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A self-hosted browser UI for the [pi coding agent](https://github.com/badlogic/pi-mono).
Chat with the agent against your code, browse files, run a terminal, and review
diffs — all from one tab.

<p align="center">
  <img src="docs/images/img0.png" alt="pi-forge in action" width="1200"/>
</p>

<details>
<summary>More screenshots</summary>

<p align="center">
  <img src="docs/images/img1.png" alt="Screenshot" width="1000"/>
  <br/><br/>
  <img src="docs/images/img2.png" alt="Screenshot" width="1000"/>
  <br/><br/>
  <img src="docs/images/img3.png" alt="Screenshot" width="1000"/>
  <br/><br/>
  <img src="docs/images/img4.png" alt="Screenshot" width="1000"/>
  <br/><br/>
  <img src="docs/images/img5.png" alt="Screenshot" width="1000"/>
  <br/><br/>
  <img src="docs/images/img6.png" alt="Screenshot" width="1000"/>
</p>

</details>

## Why pi-forge?

- **Self-hosted, single-tenant.** Your code, your provider keys, your container.
  No cloud, no analytics, no multi-tenant cross-talk.
- **Container-native.** Ships as a Docker image; deploys to Docker Compose,
  Kubernetes, or OpenShift with the manifests in this repo. Bind-mount your
  project tree, set an API key, go.
- **Same API the UI uses.** Every browser interaction is a REST or SSE call
  documented at `/api/docs`. Scripts, CI pipelines, and the chat UI hit the
  same endpoints — no shadow surface.

## Quick start

### Docker (recommended for ongoing use)

```bash
git clone https://github.com/Devin-Marks/pi-forge.git
cd pi-forge
cp docker/.env.example docker/.env       # edit auth + paths if you want
cd docker && docker compose up -d --build
```

### Rootless Podman (SELinux-enabled Linux)

Use the Podman overlay so the container user maps to your host user and Podman
can apply private SELinux labels to the three bind mounts:

```bash
git clone https://github.com/Devin-Marks/pi-forge.git
cd pi-forge
cp docker/.env.example docker/.env       # edit auth + paths if you want
cd docker
PUID=$(id -u) PGID=$(id -g) \
  podman-compose -f docker-compose.yml -f docker-compose.podman.yml up -d --build
```

Do not disable SELinux. The `:Z` mount labels are private to this container;
use a different host directory if another container must mount the same path.

### npm (no Docker, runs from your shell)

```bash
npx pi-forge                  # one-shot
npm install -g pi-forge       # or install globally, then `pi-forge`
```

By default pi-forge listens on `http://localhost:3000`, reads provider config
from `~/.pi/agent/` (shared with the host `pi` CLI if you have one), and
stores its own state in `~/.pi-forge/`. Override with flags or env vars —
every server env var has a matching `--flag`:

```bash
pi-forge --port 4000 --workspace-path ~/Code
pi-forge --api-key @/run/secrets/api-key --no-expose-docs
pi-forge --help            # full flag table grouped by category
```

Flags win when both a flag and the matching env var are set. See
[`docs/configuration.md`](./docs/configuration.md) for the full mapping.

Open the listed URL, add a project (a folder under your workspace path),
drop a provider API key into Settings, and start a session.

For source builds and a development setup see
[`CONTRIBUTING.md`](./CONTRIBUTING.md); for everything else follow the
[Documentation](#documentation) table below.

## Features

- **Streaming chat** — token-by-token rendering with inline tool calls and results.
- **Branchable session tree** — fork at any prior turn, navigate the tree,
  bookmark abandoned branches, summarize-on-navigate.
- **Per-turn diff panel** — every file the agent touched in the last turn,
  aggregated into one reviewable changeset.
- **Workspace tools in one tab** — file browser, tabbed CodeMirror editor with
  ripgrep search, integrated `node-pty` terminal (persists across page refresh),
  and a full git panel (status, diff, stage, commit, push, branch, log).
- **MCP integration** — connect remote servers (StreamableHTTP / SSE) AND
  local stdio servers; per-project `.mcp.json` with a per-project trust
  gate on stdio (you opt in once per project), per-tool toggles, master
  kill-switch in Settings.
- **Pi-subagents support** — built-in surfacing of the community
  [pi-subagents](https://github.com/nicobailon/pi-subagents) plugin (install
  separately): rich tool card for parent calls, child sessions in the project
  sidebar with cascade-delete on parent removal.
- **Session orchestration** — opt-in supervisor mode for a session
  (available by default; toggle per-session): adds an
  `orchestrate_*` tool group so the agent can spawn, observe, message,
  interrupt, and kill worker sessions in the same project. Worker
  events stream back into the supervisor's inbox; the supervisor's
  LLM wakes on activity and reacts.
- **Optional tool sandbox** — opt-in deployment mode that runs agent/user
  shell surfaces as a restricted UID/GID, scopes model file tools, and
  keeps server-side config, forge data, and mounted secrets out of that
  identity when mounts are permissioned for the split.
- **Webhooks** — HTTPS POST deliveries on agent and session events
  (`agent_end`, `ask_user_question`, `process_alert`, `auto_retry_end`,
  `compaction_end`, `session_created`, `session_deleted`). Global or
  per-project scope, optional HMAC-SHA256 signing, custom headers (Bearer
  tokens etc., redacted on the wire), delivery history with retries.
- **Background-process tool** — the `process` tool lets the agent
  spawn long-running processes (dev servers, watchers, builds) that
  outlive a single turn. Per-session manager, log capture, regex
  watches, alerts on exit.
- **Browser-native `todo` + `ask_user_question` tools** — drop-in
  contract-compatible implementations of the community plugins; live
  panel in the chat surface, per-session state.
- **Quick actions** — operator-defined chips in the chat toolbar
  that either run a shell command in the active project's cwd or
  insert/send a templated prompt to the active session.
- **Provider management** — Anthropic / OpenAI / Google / OpenRouter built-in,
  plus custom OpenAI-compatible endpoints (vLLM, LiteLLM, Ollama, internal
  gateways) via `models.json`.
- **Per-project overrides** — tri-state toggles (enable / disable / inherit)
  for skills, tools, and prompts; cascade view shows every project's override
  at a glance.
- **Auth that fits ops** — browser password + JWT (auto-generated signing key,
  persisted across restarts) and / or a static API key for scripts and CI.
  Loopback bind by default.
- **Programmatic API** — REST + SSE with auto-generated OpenAPI 3 spec at
  `/api/docs/json` and an interactive Swagger UI at `/api/docs`.
- **Installable PWA** — manifest with raster + maskable icons, offline page,
  mobile-tuned chat surface, "Add to Home Screen" on desktop and mobile.

The full feature grid (with categories and screenshots) is on the
[project site](https://devin-marks.github.io/pi-forge/#features).

## Documentation

**Install & deploy**
- [Docker image](./docs/containers.md) — image internals, volumes, env, troubleshooting
- [Private-network deployment](./docs/deployment.md) — reverse proxy, auth, multi-deploy patterns
- [Kubernetes / OpenShift](./kubernetes/DEPLOY.md) — manifests + walkthroughs
- [Optional tool sandbox](./docs/agent-tool-sandbox.md) — UID/GID split, mount permissions, and verification prompts
- [Security model](./SECURITY.md) — threat model + vulnerability reporting

**Configure & extend**
- [Configuration & env vars](./docs/configuration.md) — every flag, env var, and pi config file
- [MCP servers](./docs/mcp.md) — remote + stdio servers, per-project trust gate, per-tool toggles
- [Webhooks](./docs/webhooks.md) — HTTPS POSTs on agent/session events, HMAC signing, retry
- [Session orchestration](./docs/orchestration.md) — supervisor sessions that spawn and coordinate workers
- [Background processes](./docs/processes.md) — the `process` tool for dev servers, watchers, builds
- [`todo` tool](./docs/todo.md) · [`ask_user_question` tool](./docs/ask-user-question.md) — browser-native plugin tools
- [Quick actions](./docs/quick-actions.md) — operator-defined chat-toolbar chips
- [Mobile / PWA install](./docs/mobile.md) — "Add to Home Screen" on iOS / Android

**Use programmatically**
- [API examples](./docs/api-examples.md) — curl / Python / Node walkthroughs against `/api/v1`
- [SSE event catalogue](./docs/sse-events.md) — every event type with example payload

**Project**
- [Architecture & data flow](./docs/architecture.md) — component map, request lifecycles
- [Contributing](./CONTRIBUTING.md) — dev setup, PR process, release flow
- [`CLAUDE.md`](./CLAUDE.md) — agent-facing conventions and gotchas
- [Privacy](./PRIVACY.md) · [Code of Conduct](./CODE_OF_CONDUCT.md)

## Versions

Each pi-forge release pins exact patch versions of the pi SDK trio
(`pi-coding-agent`, `pi-agent-core`, `pi-ai`) — no caret/tilde — so a
transparent SDK upgrade can't surprise an existing install. Pinned versions
live in [`packages/server/package.json`](./packages/server/package.json).

Only the latest tag is supported. Breaking SDK changes pi-forge had to absorb
appear in the release notes' **Changed** section. Per-tag notes:
[CHANGELOG.md](./CHANGELOG.md).

## Heads up

pi-forge drives a coding agent that runs real commands (`bash`, `write`,
`edit`) as the container user. Review what it does, set provider-side spending
limits, and run it on a private network — pi-forge is not designed for
public-internet exposure. See [`SECURITY.md`](./SECURITY.md) for the threat
model and [`docs/deployment.md`](./docs/deployment.md) for deploy guidance.

## License

MIT — see [`LICENSE`](./LICENSE). Built on
[pi-mono](https://github.com/badlogic/pi-mono), the upstream pi agent SDK.
