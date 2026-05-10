<p align="center">
  <img src="docs/images/icon.png" alt="pi-forge" width="120" height="120"/>
</p>

# pi-forge

[![CI](https://github.com/Devin-Marks/pi-forge/actions/workflows/ci.yml/badge.svg)](https://github.com/Devin-Marks/pi-forge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Devin-Marks/pi-forge?sort=semver)](https://github.com/Devin-Marks/pi-forge/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A self-hosted browser pi-forge for the [pi coding agent](https://github.com/badlogic/pi-mono).
Chat with the agent against your code, browse files, run a terminal, review
diffs, all from one tab.

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

- **Self-hosted, single-tenant.** Your code, your provider keys, your container. No cloud.
  No analytics. No multi-tenant cross-talk. The same machine that runs the agent owns the
  data the agent reads.
- **Container-native.** Ships as a Docker image; deploys to Docker Compose, Kubernetes, or
  OpenShift with the manifests in this repo. Bind-mount your project tree, add an API key,
  go.
- **Same API the UI uses.** Every browser interaction is a REST or SSE call documented at
  `/api/docs`. Scripts, CI pipelines, and the chat UI all hit the same endpoints — no
  shadow surface.

## Quick start

Two install paths depending on how you want to run it.

### Docker (recommended for ongoing use)

```bash
git clone https://github.com/Devin-Marks/pi-forge.git
cd pi-forge
cp docker/.env.example docker/.env       # edit auth + paths if you want
cd docker && docker compose up -d --build
```

### npm (no Docker, runs from your shell)

```bash
# One-shot, ephemeral — npx caches and you can wipe with `rm -rf ~/.npm/_npx`:
npx pi-forge

# Or install globally:
npm install -g pi-forge
pi-forge
```

By default pi-forge listens on `http://localhost:3000`, reads provider config
from `~/.pi/agent/` (shared with the host `pi` CLI if you have one), and
stores its own state in `~/.pi-forge/`. Override paths, port, auth, and the
rest with `--flags` or environment variables — every server env var has an
equivalent flag, so you don't need a wrapper script just to set a port:

```bash
pi-forge --port 4000 --workspace-path ~/Code
pi-forge --api-key @/run/secrets/api-key --no-expose-docs
pi-forge --help            # full flag table grouped by category
```

Flags win when both a flag and the matching env var are set. See
[`docs/configuration.md`](./docs/configuration.md) for the full
flag ↔ env mapping.

Either way: open the listed URL, add a project (point at a folder under
`WORKSPACE_PATH`), drop a provider API key into Settings, and start a session.

For source builds and a development setup, see
[`CONTRIBUTING.md`](./CONTRIBUTING.md). For production deploys, Kubernetes,
and the rest of the docs, follow the links in
[Documentation](#documentation) below.

## Features

### Tools & MCP

- **MCP server integration** — connect to remote Model Context Protocol servers
  over StreamableHTTP or SSE (auto-fallback). Per-project `<project>/.mcp.json`
  overrides global config on the same name. Header status badge shows connection
  state at a glance; master kill-switch in Settings disables every MCP tool with
  one click for restricted-environment audits. See [`docs/mcp.md`](./docs/mcp.md).
- **Per-tool enable / disable** — every tool the agent could call is enumerated
  in **Settings → MCP** (per-server cascade) and **Settings → Tools** (built-ins).
  Disable individual MCP tools without dropping the whole server, or pare back
  the built-in set (e.g. turn off `bash` or `edit` for read-only audit
  deployments). Allow-by-default; changes apply on the next session.
- **Built-in coding tools** — pi's seven shipped tools active out of the box:
  `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. The agent uses typed
  tools for filesystem search and listing instead of shelling out for every
  directory walk.
- **Bash tool with env scrub** — the agent's `bash` calls inherit a
  scrubbed environment (no `JWT_SECRET`, `API_KEY`, provider keys) so a stuck
  agent can't `printenv` pi-forge secrets back into the transcript. Same
  posture as the integrated terminal and the `!` exec route.
- **pi-subagents plugin support** — install the community
  [`pi-subagents`](https://github.com/nicobailon/pi-subagents) plugin
  (`pi install npm:pi-subagents`) and the agent gains a `subagent` tool for
  delegating work to spawned child sessions, sequentially or in parallel.
  pi-forge groups the children under their parent in the sidebar, renders the
  tool result as a rich card with one-click jump into each child, refreshes the
  list when new children appear, and cascade-deletes children when the parent
  is removed. Works in the Docker image out of the box.

### Sessions & chat

- **Streaming chat** — token-by-token rendering over SSE. Tool calls and their
  results materialize in the transcript as they happen, not just at the end of a turn.
- **Branchable session tree** — fork at any prior turn, navigate the resulting tree,
  bookmark abandoned branches with a label, summarize-on-navigate to keep context.
- **Per-turn diff panel** — every file the agent touched in the last turn, aggregated
  into one reviewable changeset. Inline-edit results and project-wide diffs use the
  same renderer (unified or side-by-side view, your pick).
- **Context inspector** — token + cost breakdown per turn, lifetime spend, raw
  message inspector with syntax highlighting, and search across long conversations.
- **Image + file attachments** — drop into the prompt; the agent sees images natively
  and gets text-file content as a fenced code block.
- **Auto-retry on provider errors** — exponential backoff with the retry banner +
  countdown surfaced in the UI; full error cause-chain logged to the server's stderr.

### Files, code, and git

- **File browser** — tree view with create / rename / delete / move, scoped to the
  project root with path-traversal protection.
- **Tabbed CodeMirror editor** — autosave, syntax highlighting, per-file-extension
  line-wrap toggle (persisted), reload-on-external-change banner.
- **Workspace search** — ripgrep when available with a Node fallback for substring
  searches; filter by path globs, regex, case sensitivity.
- **Git panel** — status, unified or split diff, stage / unstage per file, commit,
  push, fetch, pull, branch checkout / create / delete, remote management, log with
  ref decorations, branch graph view.
- **Integrated terminal** — `node-pty` over WebSocket, persistent across page
  refresh and project switch (PTY survives 10 minutes of detached idle), per-tab
  scrollback, multi-tab.

### Configuration & extensibility

- **Provider management** — built-in providers (Anthropic / OpenAI / Google /
  OpenRouter) plus custom OpenAI-compatible endpoints (vLLM, LiteLLM, Ollama,
  internal gateways) via `models.json`. Per-provider API keys stored in `auth.json`,
  presence-only in the API surface (key values never sent to the browser).
- **Skills with per-project overrides** — pi's skills (`.md` files) get a tri-state
  per-project toggle: enabled, disabled, or inherit-from-global. Cascade view in
  Settings shows every project's override at a glance.
- **Five themes** — runtime swap, persisted per browser. Color palettes apply to
  chrome, editor, and the integrated terminal.
- **Minimal-mode UI** — `MINIMAL_UI=true` hides terminal, git pane, last-turn pane,
  providers, and agent settings for locked-down deployments where provider config is
  managed at the deploy level.

### Auth & operations

- **Browser password + JWT** — short-lived tokens with auto-generated HS256 signing
  key persisted to the data dir (no `JWT_SECRET` plumbing needed). On first login
  with the env-supplied password, the user is forced to pick a new one; the new
  password's scrypt hash takes over and the env value is ignored.
- **Static API key** — independent of browser auth. Set `API_KEY` for scripts /
  CI; both can be set together.
- **Programmatic REST + SSE** — auto-generated OpenAPI 3 spec at `/api/docs/json`
  and an interactive Swagger UI at `/api/docs`. Same routes the React UI calls.
- **Installable PWA** — proper manifest with raster + maskable icons, offline page
  served when the server is unreachable, "Add to Home Screen" on desktop and mobile.
- **Operator diagnostics** — error cause-chain walker for the SDK's swallowed
  exceptions (TLS handshake, DNS, ECONNREFUSED), opt-in `DEBUG_FETCH=1` wraps every
  outbound `fetch` for full request-level visibility.

## Documentation

| Topic | File |
|---|---|
| Architecture & data flow | [`docs/architecture.md`](./docs/architecture.md) |
| Configuration & env vars | [`docs/configuration.md`](./docs/configuration.md) |
| MCP servers | [`docs/mcp.md`](./docs/mcp.md) |
| Mobile / PWA install | [`docs/mobile.md`](./docs/mobile.md) |
| Docker image | [`docs/CONTAINERS.md`](./docs/CONTAINERS.md) |
| Production deployment | [`docs/deployment.md`](./docs/deployment.md) |
| Kubernetes / OpenShift | [`kubernetes/DEPLOY.md`](./kubernetes/DEPLOY.md) |
| Scripting against the API | [`docs/api-examples.md`](./docs/api-examples.md) |
| SSE event catalogue | [`docs/sse-events.md`](./docs/sse-events.md) |
| Security model | [`SECURITY.md`](./SECURITY.md) |
| Privacy | [`PRIVACY.md`](./PRIVACY.md) |
| Contributing | [`CONTRIBUTING.md`](./CONTRIBUTING.md) |
| Code of Conduct | [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) |

For project conventions and the agent-facing architecture notes, see
[`CLAUDE.md`](./CLAUDE.md).

## Versions

pi-forge tracks the [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
SDK closely. Each pi-forge release pins an exact patch version of the
pi SDK trio (`pi-coding-agent`, `pi-agent-core`, `pi-ai`) — no
caret/tilde — so a transparent SDK upgrade can't surprise an existing
pi-forge install. The pinned versions live in
[`packages/server/package.json`](./packages/server/package.json).

Support window: only the latest pi-forge tag is supported. When a
new tag ships, the previous one is best-effort — security fixes may
be backported, feature work isn't. Breaking SDK changes that the
pi-forge had to absorb show up in the release notes' **Changed**
section so operators know what to re-test before upgrading. Per-tag
notes live in [CHANGELOG.md](./CHANGELOG.md).

## Heads up

pi-forge drives a coding agent that runs real commands (`bash`,
`write`, `edit`) as the pi-forge user — review what it does, set
provider-side spending limits, and don't expose the container to the
public internet. See
[`SECURITY.md`](./SECURITY.md) for the threat model and
[`docs/deployment.md`](./docs/deployment.md) for production notes.

## Related projects

- [pi-mono](https://github.com/badlogic/pi-mono) — the upstream pi
  agent SDK and reference TUI.

## License

MIT — see [`LICENSE`](./LICENSE).
