# Changelog

All notable changes to pi-forge are documented in this file. (Formerly
`pi-workbench` through v1.0.3 — see the v1.1.0 entry for the rename
details.)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pi SDK trio (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`,
`@mariozechner/pi-ai`) is pinned to exact versions; any breaking SDK absorption
is called out in its own release notes section. See the "Versions" section of
the README for the support window policy.

## [Unreleased]

### Added

- **VS Code-style git diff gutter in the file viewer.** CodeMirror
  editor now renders a 3px colored gutter strip per changed line —
  green for additions, blue for modified, red triangle for the line
  below a deletion — plus a proportional overview overlay on the right
  scrollbar so changes are visible at a glance in long files. Diff
  data flows in via a `setDiffEffect` StateEffect so swaps don't
  require rebuilding EditorState (cursor / undo / scroll all
  preserved). Pure-function `parseUnifiedDiff` parses git diff output
  into per-line decorations keyed by new-file line numbers; full unit
  coverage in `tests/test-diff-parser.ts`.
- **Dependabot enabled.** `.github/dependabot.yml` configures weekly
  version updates across three ecosystems: `npm` (root + every
  workspace under `packages/*` via auto-discovery), `github-actions`
  (workflow YAMLs), and `docker` (`docker/Dockerfile` base image).
  Each stream tags PRs with `dependencies` plus an ecosystem label
  and uses a conventional-commit prefix (`chore(deps)`, `chore(ci)`,
  `chore(docker)`). The pi SDK trio is intentionally NOT ignored —
  Dependabot still surfaces those bumps as PRs even though the
  policy is "review carefully, never auto-merge" per `CLAUDE.md`.
- **pi-subagents integration.** When the `pi-subagents` plugin is
  installed (`pi install npm:pi-subagents`), spawned sub-agents are
  now first-class sessions in pi-forge: discoverable, navigable,
  cleanly grouped under their parent in the sidebar. Specifically:
  - The `subagent` tool's result message is rendered as a richer
    light-blue card in the chat (replaces the generic tool card),
    with collapsible Input + Output sections and a small Open button
    in the header that switches the active session to the spawned
    child's JSONL.
  - Server-side discovery walks the deeply-nested
    `<sessionDir>/<projectId>/<basename>/<runId>/run-N/session.jsonl`
    layout pi-subagents writes to, and tags each child with
    `parentSessionId` + `runId` for sidebar grouping. Recursive
    walker handles every layout variant the plugin emits without
    enumerating each by hand.
  - Sidebar shows children indented under their parent's row when
    the chevron is expanded. True orphans (parent JSONL deleted but
    child dir survived) fall back to top-level rendering.
  - Open click resolves `sessionFile` → canonical `sessionId` via
    a path lookup against the loaded session list (pi-subagents
    names children `session.jsonl`, not `<uuid>.jsonl`, so deriving
    the id from the basename is unreliable). Uses the JSONL header's
    real id instead.
  - Deleting a parent session cascades the entire pi-subagents
    sibling directory so orphan children don't accumulate. The
    project-scoped `subagent-artifacts/` dir is intentionally
    untouched.

### Fixed

- **`FST_ERR_REP_ALREADY_SENT` 500s on git/files routes.** Every
  handler that called `resolveProject` was ending with
  `if (project === undefined) return;` after the helper already
  called `reply.send(404)`. Fastify interpreted the resolved
  `undefined` as "send this," racing the helper's 404 — surfacing
  as a noisy 500 in the request log even though the client got
  the 404 fine. All call sites in `git.ts` (14) and `files.ts` (9)
  plus the shared `withProject` helper now `return reply` so
  Fastify knows the response was handled. Doc-comments on both
  helpers updated to make the contract explicit.

## [1.1.2] — 2026-05-06

### Added

- **npm distribution.** pi-forge now publishes to npm as `pi-forge` on
  every `v*` tag, in lockstep with the GHCR Docker image. Install via
  `npm i -g pi-forge` or `npx pi-forge` for a no-Docker run path with
  the embedded SPA. Published as a flat single-package layout — server
  + client + bin shim assembled by `scripts/build-publish-dir.mjs` from
  the workspace builds, with the server's runtime deps hoisted as the
  published package's dependencies. Authentication uses npm Trusted
  Publishers (OIDC) — no long-lived `NPM_TOKEN` secret in the repo —
  and every release ships with a sigstore-signed provenance attestation.
- **Inline compaction archive.** When the agent compacts its context,
  archived messages no longer disappear — they collapse into an
  expandable `CompactionCard` placed inline in the chat at the
  compaction boundary. New `GET /sessions/:id/compactions` API returns
  the per-compaction archived message arrays; the client lazy-loads on
  expand. The previously-rendered "unknown message" synthesized
  compaction summary is now hidden (its content already lives in the
  card's disclosure body).
- **Pi-package tools and skills surface in Settings.** Tools registered
  by installed pi packages (npm/git, managed by `DefaultPackageManager`)
  now appear in Settings → Tools grouped by package source, with the
  same global enable/disable + per-project tri-state override UX as
  builtin and MCP tools. Skills contributed by packages appear in
  Settings → Skills with `source: extension`. Both are also wired into
  the agent's tool allowlist so the model can actually invoke
  package-registered tools (previously silently filtered out).

### Changed

- **MCP tool result text capped at ~25k tokens.** `mcp/tool-bridge.ts`
  truncates over-cap text content with a 60/40 head/tail split and an
  imperative marker that nudges the model to refine its query rather
  than re-run the same call. Image content blocks pass through
  untouched. Defaults: 100,000 chars, configurable via constants at
  the top of the file.
- **Pi SDK bumped to 0.73.0** (`@mariozechner/pi-coding-agent`,
  `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai` from 0.70.5).
  No breaking changes affect pi-forge directly. End users running pi
  alongside pi-forge with custom `models.json` may need to migrate
  `compat.reasoningEffortMap` → `thinkingLevelMap` (v0.72.0 SDK
  rename). Free win: bash tool output now streams incrementally
  while commands run instead of only after completion (v0.73.0).

### Fixed

- **Disabling a per-project package-tool override no longer crashes the
  Tools tab.** `GET /config/tools/overrides`'s response schema was
  missing the `extension` family, so Fastify's serializer stripped the
  field and SettingsPanel exploded on `fam.enable.includes(...)`.
  Schema now requires it; client validator backfills defensively.
- **Per-project skill disable now works for package-contributed
  skills.** Pi's `DefaultPackageManager.collectPackageResources` marks
  package skills `enabled: true` unconditionally and never consults
  `settings.skills` patterns, so the existing pattern-based override
  silently no-op'd for them. Fix uses the SDK-supported
  `skillsOverride` callback on `DefaultResourceLoader` to apply a
  source-agnostic name-based filter at session create.
- **Test isolation.** Every spawned-server test now `mkdtemp`s its own
  `FORGE_DATA_DIR` so the user's real `password-hash` can't leak into
  CI auth scenarios.

## [1.1.1] — 2026-05-05

### Changed

- **Editor saves are now explicit.** Removed the 1-second autosave
  debounce. Saves go through Cmd/Ctrl+S (already wired in the
  CodeMirror keymap) or a new **Save** button in the editor's status
  bar. The status bar still shows the dirty / saving / save-error
  / saved-at indicator next to the button. The button is disabled
  when there's nothing to save (clean buffer, save in flight, or
  binary file).
- **File browser scopes to the active project.** Switching projects
  now clears the in-memory open editor tabs in place before
  restoring the new project's persisted tab list. Previously the
  old project's tabs stayed visible until the user closed them
  manually, because `restoreTabs` early-returned when any tab was
  open. The old project's persisted tab paths in sessionStorage are
  preserved (re-enter the project to restore them); only the
  in-memory state is cleared.

### Fixed

- **Editor refreshes when the agent edits an open file.** Replaces
  the per-tool-result detection (which was fragile against SDK
  changes — the latest `EditToolDetails` only exposes `{ diff,
  firstChangedLine }`, no path field) with a single
  `agent_end`-triggered refresh that re-reads every open editor
  tab from disk and reconciles per file: silent reload for clean
  buffers, externally-changed banner for dirty buffers. Catches
  every change source (built-in tools, MCP tools, terminal commands
  the agent shelled out to, git ops) without needing to know the
  shape of any tool's result.
- **Auto-scroll to bottom when a new user message lands.** The
  chat already auto-scrolled while following the bottom, but a
  user who'd scrolled up to read history and then submitted a
  prompt stayed parked in history while the agent's response
  streamed off-screen. New rule: any time a user-role message
  appears at the tail, force-scroll to bottom and re-engage
  follow mode. Catches both the local-submit path and cross-tab
  delivery.
- **New sessions get distinct names.** `createSession` now sets a
  `New session` default name (with `New session (2)`, `(3)`, …
  suffixes to disambiguate against existing siblings in the same
  project), mirroring the `(clone)` suffix logic the fork path
  added in v1.0.3. Previously fresh sessions all fell back to the
  `session abc1234` sessionId-based fallback in the sidebar, which
  reads as effectively-identical at a glance.

### Added

- **Git init button in the Git pane.** When the active project isn't
  a git repository yet, the Git tab shows an "Initialize git repo"
  button instead of the previous text-only hint. Click runs `git init
  -b main` (default branch `main`) on the project root via a new
  `POST /api/v1/git/init` route, then re-polls status so the panel
  flips into the normal Staged / Unstaged layout. Idempotent — the
  route returns `{ alreadyInitialised: true }` if the project is
  already a repo. Falls back to plain `git init` on git versions older
  than 2.28 (which don't recognise `-b`).
- **About tab in Settings.** New tab at the end of the settings tab
  bar showing the deployed server version (read from the server's
  `package.json` and surfaced via `/api/v1/ui-config`), plus links to
  the GitHub repo, CHANGELOG, and SECURITY policy. Useful for
  confirming a deploy actually rolled forward without shelling into
  the container.

### Fixed

- **Chat toggle now fully hides the chat column**, including the
  empty-state branches (project picker, "no project" placeholder,
  "+ New session" prompt). Previously the column stayed mounted when
  there was no active session even after the user toggled chat off,
  leaving the project-first-open page visible. The header chat button
  is the single source of truth for chat-column visibility now.
- **Skills export no longer 500s on an empty skills directory.**
  `GET /api/v1/config/skills/export` now returns `409
  skills_directory_empty` when `${piConfigDir}/skills/` is missing or
  contains no files, and the Settings → Backup tab surfaces this as a
  neutral "No skills to export" info line instead of a red error
  banner. (Background: tar 7.x's `create()` throws synchronously on
  an empty entries list, and a hand-rolled empty tar is rejected by
  tar 7.x's reader as `TAR_BAD_ARCHIVE` — refusing the export with a
  clear message is better than shipping a download nobody can use.)

## [1.1.0] — 2026-05-05

### Renamed

The project is renamed from **pi-workbench** to **pi-forge** in this
release. The bare `pi-workbench` slot on npm was already squatted by an
unrelated tmux-based tool, so a clean reservable identity end-to-end
(npm + Docker Hub + GitHub) made more sense than coexistence. No
features change in this release — every other line below describes the
breaking surface operators upgrading from v1.0.3 must know about.

#### Breaking — operators must take action

- **npm package**: `pi-workbench` → `pi-forge` (root). Workspace
  packages renamed too: `@pi-workbench/server` → `@pi-forge/server`,
  `@pi-workbench/client` → `@pi-forge/client`. The workspace packages
  are private and not published to npm; the rename is purely cosmetic
  for them.
- **Docker image**: `ghcr.io/devin-marks/pi-workbench` →
  `ghcr.io/devin-marks/pi-forge`. The previous image stream stops
  receiving new tags. Existing pinned tags (`:1.0.3`, `:1.0.2`, etc.)
  remain pullable from the old name; pull the new image for `1.1.0+`.
- **Env var**: `WORKBENCH_DATA_DIR` → `FORGE_DATA_DIR`. Update your
  `docker-compose.yml`, `.env`, helm values, and k8s manifests. The
  old name is **not** read as a fallback — set the new one or accept
  the default (`~/.pi-forge/`).
- **Env var (compose only)**: `WORKBENCH_DATA_HOST_PATH` →
  `FORGE_DATA_HOST_PATH` in the compose env. Default now points at
  `~/.pi-forge-docker`.
- **Default data dir**: `~/.pi-workbench/` → `~/.pi-forge/`. **No
  auto-migration**: before first boot of v1.1.0, move your data dir
  manually:

  ```sh
  mv ~/.pi-workbench ~/.pi-forge
  ```

  The directory carries `projects.json`, `mcp.json`,
  `tool-overrides.json`, `skills-overrides.json`, `password-hash`,
  `jwt-secret`, and the workspace subdir as a unit, so a single `mv`
  is sufficient. (For Docker bind-mounts, do the equivalent on the
  host path you use for `FORGE_DATA_HOST_PATH`; for k8s, rename the
  PVC.) Skipping this step on a fresh install of v1.1.0 produces a
  workbench with no projects / no saved password / no MCP servers.
- **HTTP response headers**:
  - `X-Pi-Workbench-Files` → `X-Pi-Forge-Files` (config export
    download)
  - `X-Pi-Workbench-File-Count` → `X-Pi-Forge-File-Count` (skills
    export download)
- **Browser localStorage / sessionStorage keys** are renamed from the
  `pi-workbench/*` and `pi.*` prefixes to `pi-forge/*` and `forge.*`
  respectively (auth-token, theme, panel widths, view-mode prefs,
  editor / terminal tab lists, model picker history, input history,
  every UI preference). **Every existing browser session is logged
  out and every UI preference reverts to defaults** on first load of
  v1.1.0. Re-login + re-set preferences is the expected one-time cost.
- **BroadcastChannel name**: `pi-workbench` → `pi-forge`. Two browser
  tabs running mixed builds (one pre-rename, one post-rename) lose
  cross-tab session sync until both reload onto the same build.
- **Kubernetes manifests**: PVC names, app labels, service / route /
  deployment names, secret name, mount path all renamed
  (`pi-workbench-*` → `pi-forge-*`, `/home/pi/.pi-workbench` →
  `/home/pi/.pi-forge`). Existing operators must rename their PVCs
  (or recreate from a snapshot) since k8s does not auto-rebind a PVC
  to a renamed claim. See `kubernetes/DEPLOY.md` for the procedure.
- **Compose container / service name**: `pi-workbench` → `pi-forge`.
- **MCP client identifier name**: the `name` field the workbench
  presents to MCP servers as their connecting client is now
  `pi-forge` (was `pi-workbench`). Visible only in MCP server logs;
  no behavioral change.
- **Swagger / OpenAPI spec title**: `pi-workbench API` →
  `pi-forge API`. Programmatic clients that key off the spec title
  must update; auth and route shapes are unchanged.

#### Non-breaking project metadata

- **GitHub repo**: renamed from `Devin-Marks/pi-workbench` to
  `Devin-Marks/pi-forge` after this release ships. GitHub permanent
  redirects keep every old URL functional (clones, HTTP, API).
- **GitHub Pages site** rebuilt under the new name. The Pages URL
  follows the repo rename automatically.
- **README, AGENTS.md, CLAUDE.md, all of `docs/`, all of `docs/site/`**
  rewritten with the new identity. Historical CHANGELOG entries
  (1.0.0 → 1.0.3) are not retroactively edited; they describe the
  product as it shipped under the old name, and that history stays
  intact.

#### What did NOT change (intentionally)

- **Pi SDK packages** (`@mariozechner/pi-coding-agent`,
  `@mariozechner/pi-agent-core`, `@mariozechner/pi-ai`). Upstream;
  not ours to rename.
- **`PI_CONFIG_DIR`** env var and `~/.pi/agent` default. Owned by
  the SDK.
- **`.pi/sessions` JSONL session storage path**. SDK convention.
- **Session JSONL contents and shape**. Sessions roll forward
  unchanged.

## [1.0.3] — 2026-05-04

### Added

- **Copy buttons on chat messages and code blocks.** Each user and
  assistant message bubble now has a Copy icon next to the
  raw/rendered toggle that copies the message text to the clipboard.
  Fenced code blocks rendered by `ChatMarkdown` get an additional
  hover-revealed Copy button in the top-right corner. Both fall back
  to a synthetic textarea + `document.execCommand('copy')` when the
  async clipboard API is unavailable (older Safari, insecure HTTP).
- **Default model named in the model picker.** The "Use agent
  default" row in the chat-input model dropdown now shows the
  resolved provider/model from `settings.json` (e.g. `anthropic /
  claude-sonnet-4-5 (default)` in the trigger label, monospace name
  in the dropdown row). The picker now fetches `settings.json`
  alongside the providers listing.
- **`API Docs ↗` button in the Settings header.** Opens the
  OpenAPI / Swagger UI in a new tab and carries the user's auth
  token across via a one-shot `?token=...` query param. The server-
  side bootstrap script strips the token from the URL on page load
  and re-presents it as a Bearer header on every API call swagger
  UI makes — so logged-in users can explore and exercise the API
  surface without manually pasting their JWT into the swagger
  Authorize dialog.

### Changed

- **Forked sessions get disambiguated names.** When a session is
  forked from another, the new session's name is set to
  `<source name> (clone)` (or `(clone)` if the source has no
  explicit name). Subsequent forks within the same project bump the
  suffix (`(clone) 2`, `(clone) 3`, …) so the sidebar doesn't show
  multiple identically-named entries.

### Fixed

- **Text selection no longer bleeds across chat message bubbles.**
  Selection in Safari (and other browsers) was extending past the
  bubble's rounded border and across adjacent messages, making it
  impossible to copy a single message cleanly. The chat message
  list is now `user-select: none` and each `.message-bubble` re-
  enables `user-select: text` with `isolation: isolate` so each
  bubble is its own selection root.

## [1.0.2] — 2026-05-04

### Added

- **Pane toggles for chat and editor.** New **Chat** and **Editor**
  buttons in the header alongside the existing **Files** and
  **Terminal** toggles. Each pane is independently hideable so a
  user can collapse the workbench down to whichever surface
  matters for the task at hand (e.g. just editor + terminal for a
  test-running flow, or just chat for an agent-driving flow).
  Persistence mirrors the existing toggles: `localStorage` keys
  `pi-workbench/chat-open` and `pi-workbench/editor-open`, both
  defaulting to OPEN.
- **Editor pane decoupled from the file browser.** The Files
  toggle previously controlled both the file tree AND the editor
  visibility; closing the tree also hid any open tabs. Now the
  Editor toggle is independent — keep one file open without the
  280px file tree taking room, or browse the tree without the
  editor pane materialising.
- **Editor tabs persist across page reloads.** Open tab paths and
  the active path are now saved to `sessionStorage` per project
  (`pi.editor.tabs.v1:<projectId>`), mirroring the terminal store's
  per-browser-tab persistence. On reload the tabs reopen via the
  existing `openFile` read; files that have been deleted since
  persist time are silently dropped. Only paths + active path are
  stored — file content stays on the server.
- **Chat-hidden layout fills the viewport.** When the chat pane is
  toggled off, the leftmost visible pane (editor, then files) expands
  to `flex-1` and its leading ResizableDivider is dropped, so two
  visible panes fill the entire main area with a single slider between
  them instead of leaving blank space on the right.
- **Editor/Files button order matches pane order.** The **Editor**
  toggle button now appears before **Files** in the header bar,
  matching the left-to-right render order (chat → editor → files).
- **Close-all tabs button in editor.** An XSquare icon at the left
  edge of the editor tab bar closes every open tab at once; prompts
  for confirmation when any tab has unsaved changes.
- **MCP status badge opens MCP settings.** Clicking the MCP badge in
  the header navigates directly to **Settings → MCP** instead of
  doing nothing.
- **Dismissable project picker.** When no projects exist, the project
  picker can be dismissed with the X so the user can explore the
  workbench before creating a project. A "New project" link in the
  empty state re-opens it.
- **New-session shortcut in chat pane.** When a project is selected
  but no session is active, the chat column shows a "+ New session"
  button that creates and navigates to a new session directly.
- **Always-visible sidebar controls.** The + (new session) and X
  (delete project) buttons in the project sidebar are now always
  visible instead of appearing only on hover.
- **Always-visible tab close buttons.** X buttons on editor tabs and
  terminal tabs are always visible (previously required hovering over
  the tab).
- **8 px left padding in terminal pane.** The xterm viewport now has a
  small left inset so terminal text isn't flush against the panel edge.
- **Prompt history includes slash commands and bash execs.** All
  submitted prompts (agent prose, `/` slash commands, `!` / `!!` bash
  execs) are now persisted to `localStorage` per session
  (`pi.input.history.v1:<sessionId>`, capped at 100, consecutive
  duplicates skipped). The up-arrow history merges this store with the
  existing message-derived history.
- **Block workspace-root folder as a project path.** The folder picker
  rejects the workspace root itself; the "Select this folder" button
  is disabled and a tooltip explains why.
- **Recursive folder delete with confirmation.** Deleting a non-empty
  folder now opens a second confirmation dialog (instead of returning
  an error); the confirmed action sends `?recursive=true` to the server
  and removes the directory tree atomically.
- **Multiselect for files.** Cmd/Ctrl+click in the file browser
  toggles rows into a selection set; a toolbar appears with a
  "Delete selected" action that removes all selected items.
- **Multiselect for sessions.** Same Cmd/Ctrl+click pattern in the
  session list enables bulk-delete of multiple sessions at once.
- **Skills backup.** New section in **Settings → Backup**:
  - **Export**: downloads a `.tar.gz` of every file under the skills
    directory (`${piConfigDir}/skills/`) via
    `GET /api/v1/config/skills/export`.
  - **Import**: uploads either a `.tar.gz` archive or a folder
    (via `<input webkitdirectory>`) via
    `POST /api/v1/config/skills/import`; paths are validated before
    write (no `..`, no absolute paths); existing files at colliding
    paths are overwritten atomically.

### Changed

- **Markdown + syntax-highlighted code in chat messages.** User
  text bubbles, assistant text blocks, and the streaming preview
  now render through `react-markdown` + `remark-gfm` +
  `remark-breaks` — headings, bold / italic, lists, tables,
  blockquotes, links, fenced code blocks, and chat-style single-
  newline preservation (so the line breaks the user typed survive
  the round-trip; CommonMark default would have folded them into
  whitespace). Fenced code blocks get prism-react-renderer syntax
  highlighting (same library DiffBlock and ContextInspectorPanel
  already use, so the dark surfaces stay visually consistent).
  Inline `` `code` `` gets a styled monospace span. Raw HTML in
  message content is ignored (no `rehype-raw`); links open in a
  new tab with `noopener noreferrer`. Each user / assistant message
  has a small `raw` / `rendered` toggle in the corner so the
  underlying text (literal `**`, backticks, exact whitespace)
  stays one click away. Tool calls, file-reference badges, bash
  exec messages, and image attachments still use their dedicated
  renderers — markdown is for prose only.
- **Tool calls render as one collapsed entry per call.** Previously
  the assistant-side `toolCall` block and its matching `toolResult`
  message rendered as two separate boxes in the chat — one showing
  `→ <tool>` plus a JSON dump of arguments, the other showing the
  tool's output. Now each tool invocation is paired by `toolCallId`
  and rendered as a single entry with three rows: header
  (`→ <tool>` + an error / running badge), collapsible **Input**
  (closed by default), and collapsible **Output** (closed by
  default). The `edit` tool keeps its specialized diff renderer
  inside the Output row so file diffs still display as +/- lines
  once expanded. Mid-stream calls without a result yet show a
  "running…" badge in the header.

### Added

- **Agent gets `grep`, `find`, and `ls` tools.** Pi's SDK ships
  seven built-in coding tools — `read`, `bash`, `edit`, `write`,
  `grep`, `find`, `ls` — but only the first four are activated
  when `tools` is left undefined on `createAgentSession`. We now
  pass the full set on every session so the agent has first-class
  filesystem-read affordances instead of shelling out via `bash`
  for every directory listing or content search. MCP tool names
  are unioned into the same allowlist at each call site so the
  added `tools: [...]` arg doesn't filter custom tools.
- **Per-tool enable / disable, with per-project overrides.** Every
  tool the agent could call is now toggleable individually.
  **Settings → Tools** lists pi's seven built-ins (read, bash, edit,
  write, grep, find, ls). **Settings → MCP** gets a cascade under
  each server: an expand chevron reveals that server's tools (with
  the bridged `<server>__<tool>` name + the unprefixed shortName +
  description). Every row carries a `Global: enabled/disabled`
  toggle plus an `▸ Overrides (N)` expand button that opens an
  inline cascade — each project that already overrides this tool
  shows a tri-state Inherit / Enabled / Disabled picker, and an
  `+ Add override for…` dropdown lets you add or change overrides
  for any other project from the same screen (no need to switch
  active projects). Same UX as the Skills tab. Project overrides
  win over the global default in both directions (project enable
  beats global disable; project disable beats global enable);
  absence inherits global. Allow-by-default; global disables and
  per-project overrides are stored in
  `${WORKBENCH_DATA_DIR}/tool-overrides.json` (atomic write, same
  shape as `skills-overrides.json`). Changes apply on the NEXT
  `createAgentSession` — live sessions keep the tool set they
  booted with. Routes: `GET /api/v1/config/tools[?projectId=]` for
  the unified view (response per row carries `enabled`,
  `globalEnabled`, and the optional `projectOverride`),
  `GET /api/v1/config/tools/overrides` for the cascade across every
  project (mirrors the skills cascade endpoint),
  `PUT /api/v1/config/tools/:family/:name/enabled` toggles either
  scope (`scope: "global"` default, or `scope: "project"` with
  `?projectId=`), and `DELETE` on the same path with `?projectId=`
  clears a per-project override (idempotent). The Tools tab stays
  visible in `MINIMAL_UI` mode so locked-down deployments can still
  disable `bash` / `edit` / `write` without the rest of the
  settings surface.
- **Config export / import as `.tar.gz`.** New `Settings → Backup`
  tab and matching API routes — `GET /api/v1/config/export` streams a
  flat tar with `mcp.json`, `settings.json`, and `models.json`;
  `POST /api/v1/config/import` accepts a multipart upload and writes
  each file atomically (`.tmp` + rename). Import is all-or-nothing:
  every accepted file must parse as JSON before any rename runs, so a
  corrupted entry can't half-restore. **Provider auth is NOT included
  in exports** (`auth.json` — API keys / OAuth tokens) — the UI
  reminds operators to re-authenticate providers after restoring on a
  new install. Installation-bound files (`jwt-secret`, `password-hash`,
  `projects.json`) are also excluded.
- **Terminal venv auto-activation.** When a new terminal tab is opened
  in a project containing a Python virtualenv at `.venv/`, `venv/`, or
  `env/`, the workbench automatically runs `source <dir>/bin/activate`
  in the freshly-spawned shell. Reattach to an existing PTY does not
  re-source so manually-switched venvs are preserved.

### Fixed

- **`@<path>` file references preserved in chat history.** When a
  referenced file was small enough to inline, the server previously
  emitted only the fenced code block — the user's prose lost the
  `@<filename>` they typed (`look at @README.md and explain` rendered
  as `look at and explain`). The server now keeps the literal marker
  for every outcome (inline, defer, error), the client no longer
  strips bare markers from the rendered bubble, and the fence-stripper
  consumes adjacent newlines so the marker flows inline with
  surrounding prose instead of leaving an orphan blank line.
- **Trailing-punctuation file references resolve correctly.**
  `@README.md?`, `@src/foo.ts,`, `@build.js)` etc. used to greedy-match
  the trailing punctuation as part of the filename, so the server
  couldn't resolve the file. The bare-form regex is now lazy + uses a
  lookahead so trailing `?,;:!)]` followed by whitespace or EOS
  isn't pulled into the path. Dot is intentionally not in the strip
  set (filenames have dots); the autocomplete now always inserts the
  quoted form (`@"src/foo.ts"`) so users can type any punctuation
  directly after an autocompleted reference.

### Security

- **Agent secret-hygiene system-prompt rule (opt-in).** When
  `AGENT_SECRET_HYGIENE_RULE=true`, every `createAgentSession` ships
  an `appendSystemPrompt` addendum telling the model to treat env-var
  values as credentials by default and not echo them into responses
  or tool outputs unless explicitly asked. Phrased around *displaying
  values* (not accessing variables) so legitimate skill workflows
  that need `$GITHUB_TOKEN`, `$AWS_*`, etc. continue to work —
  `curl -H "Authorization: Bearer $X"` is fine, `printenv X` to
  reflect the value back to the user is not. Default OFF: kept opt-in
  so the workbench doesn't ship invisible behavioral rules. The flag
  is intentionally absent from `docker-compose.yml` and
  `.env.example` — operators discover it via [SECURITY.md](./SECURITY.md)
  alongside the threat-model caveats (behavioral nudge, not a
  security control).
- **Terminal env-var allowlist.** The integrated terminal and the `!`
  exec route now start from an allowlist of harmless system vars
  (`PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LANG`/`LC_*`, `TZ`, …)
  instead of inheriting the workbench process's full env minus a
  named denylist. Workbench secrets, provider API keys, cloud
  credentials, and any other host-env var are dropped before spawn,
  so `printenv` / `echo $X` returns nothing for them. Operators who
  need a specific var in-shell opt it back in via the new
  `TERMINAL_PASSTHROUGH_ENV` env (comma- or whitespace-separated).
  Closes the previous fail-open denylist that leaked any
  newly-named secret variable until added to the list. See
  [SECURITY.md](./SECURITY.md) for the full rationale and a note on
  the unrelated terminal-can-read-pi-config-files limitation.

### Build & release

- **Release tooling.** New `scripts/bump-version.sh <new-version>` that
  bumps the root and workspace `package.json` files in lockstep, refreshes
  `package-lock.json`, and rewrites the `## [Unreleased]` section in
  `CHANGELOG.md` to a dated release header. Refuses to run on a dirty
  working tree, on a downward / equal version, or with an empty Unreleased
  body (overridable via `--allow-empty`).
- **Tag/version drift gate.** The release workflow now runs a
  `check-version` job on every `v*` tag push that fails the build if the
  tag doesn't match `package.json#version` in all three workspaces. Catches
  the "tagged but forgot to bump" mistake before any image is pushed.

## [1.0.0] — 2026-05-01

First tagged release. The browser workbench is feature-complete against the
Phase 1–18 development plan: project + session management, full pi SDK bridging
over REST + SSE, file browser and editor, integrated terminal, diff and git
panes, attachments, session tree, context inspector, MCP client, per-project
skill overrides, and a versioned API documented at `/api/docs`.

### Added

- **Sessions & agent bridge.** Live `AgentSession` registry with lazy resume
  from JSONL on disk; SSE event stream with snapshot-on-connect for instant
  hydration; fire-and-forget prompt with multipart attachments (text files
  inlined as fenced blocks, images forwarded as base64).
- **Projects.** Folder-pointer model rooted at `WORKSPACE_PATH`; project
  registry persisted to `WORKBENCH_DATA_DIR/projects.json`; one-time migration
  from the legacy `PI_CONFIG_DIR` location.
- **Authentication.** Browser JWT auth via `UI_PASSWORD`; programmatic access
  via `API_KEY` static bearer; auto-generated `JWT_SECRET` persisted to the
  data dir; scrypt-hashed password store; `REQUIRE_PASSWORD_CHANGE` first-login
  flow with a documented reset path.
- **Configuration.** Pi `auth.json` / `models.json` / `settings.json` editing
  through a presence-only API (key values never returned over the wire);
  `HIDE_BUILTIN_PROVIDERS` env var for locked-down deployments;
  per-project skill enable/disable overrides at
  `WORKBENCH_DATA_DIR/skills-overrides.json` applied at every
  `createAgentSession` site.
- **MCP client.** Direct `@modelcontextprotocol/sdk` integration with
  StreamableHTTP and SSE transports; per-project + global server scopes;
  master enable/disable; status badge in the header.
- **Files.** Workspace browser with tree view, file editor (CodeMirror 6 +
  one-dark), ripgrep-backed file search, multipart upload with SHA-256
  verification, and tar.gz download — all routed through `file-manager.ts`
  with strict path-traversal guards.
- **Terminal.** Per-project `node-pty` shells over WebSocket with
  reattach-by-tabId across reconnects, idle reaping, and per-tab persistence
  via `sessionStorage` so two browser tabs don't fight over the same PTY.
- **Diff + git.** Unified diff renderer for both pi `edit` tool results and
  `git diff`; per-turn aggregated diff; git pane with branch, modified-file
  count badge, and file-level staging.
- **Session tree + context inspector.** Indented depth-first session tree
  with fork/leaf badges; per-message inspector for token-level debugging.
- **Chat input affordances.** `!` / `!!` bash prefixes (pi-tui parity) with a
  colored border + corner pill (emerald = output goes to LLM context, amber =
  local-only) so the mode is unmissable while typing; `@<path>` file
  references with autocomplete; `/` slash-command palette.
- **Cross-tab sync.** Session create/delete/rename mirrored across browser
  tabs via the `BroadcastChannel` API; SSE 404 path retained as a safety net
  for out-of-band deletions.
- **Deployment.** Multi-stage Docker image (`node:22-bookworm-slim` — glibc
  base for friction-free native-module installs and a richer interactive
  shell) with PUID/PGID bind-mount support; Compose and Kubernetes
  manifests; healthcheck via
  `/api/v1/health`; pino structured logging with configurable level.
- **PWA.** Manifest, raster icons, branded offline page, service worker
  precaching the application shell.
- **Documentation.** README front-door with quickstart, architecture diagram,
  env var table, and "Versions" SDK-pinning policy; full reference set under
  `docs/` (architecture, deployment, configuration, containers, SSE events,
  API examples, MCP); governance files (LICENSE, CONTRIBUTING, SECURITY,
  PRIVACY, CODE_OF_CONDUCT) and `.github/` issue + PR templates.

### Security

- Path-traversal guards on every `file-manager.ts` operation (lexical +
  realpath verification).
- Provider auth values are never returned by the read API — only a presence
  map and the SDK-reported source.
- Container hardening in the shipped Compose: `no-new-privileges`,
  `cap_drop: ALL`, pids/mem/cpu limits, localhost-only port bind by default.
- Login rate limiting via `@fastify/rate-limit`.

### Reliability

- **SSE keepalives.** The SSE bridge sends a comment-line heartbeat every
  20 s on every open stream so any L7 proxy with the typical 30 s idle
  timeout (notably OpenShift's HAProxy router) doesn't drop the connection
  during quiet stretches between agent turns.
- **MCP route shape fixes.** Master toggle (`PUT /mcp/settings`) returns the
  full `{ enabled, connected, total }` shape so the header badge updates in
  one round trip; the upsert route's response schema explicitly declares
  `{ ok }` so Fastify's response serializer doesn't strip it; both
  unblocked the Settings → MCP page from `invalid_response_body` errors on
  every action.

[Unreleased]: https://github.com/Devin-Marks/pi-workbench/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Devin-Marks/pi-workbench/releases/tag/v1.0.0
