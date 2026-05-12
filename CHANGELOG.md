# Changelog

All notable changes to pi-forge are documented in this file. (Formerly
`pi-workbench` through v1.0.3 — see the v1.1.0 entry for the rename
details.)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Pi SDK trio (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`,
`@earendil-works/pi-ai` — formerly under the `@mariozechner/*` scope through
v1.1.4; see the v1.1.5 entry for the scope migration) is pinned to exact
versions; any breaking SDK absorption is called out in its own release notes
section. See the "Versions" section of the README for the support window policy.

## [Unreleased]

### Fixed

- **Inline edit-diff gutter line numbers no longer wrap.** Multi-digit
  line numbers in the chat's inline edit-tool diff (e.g. `16`, `100`)
  rendered as digits stacked vertically (`1` over `6`) when the gutter
  cell got compressed under `table-layout: auto`, making the inline
  view visibly taller than the matching git-diff and turn-diff for
  the same change. Adds `white-space: nowrap` and
  `font-variant-numeric: tabular-nums` to `.pi-diff-block .diff-gutter`.
  Same fix benefits GitPanel and TurnDiffPanel since they share the
  scope. (#115)
- **Per-row session delete swaps the modal for inline click-to-confirm.**
  Single-row delete on a session now uses a two-click pattern: first ×
  click arms the row (icon flips to a red-outlined `Confirm` button);
  second click within 3 s actually deletes. Click anywhere else,
  Escape, or the auto-disarm timer cancel without deleting. Bulk-
  delete (multi-select toolbar) keeps the existing confirm modal
  because the count-of-N context is part of the prompt. Sidesteps the
  modal-centering regression for the common case AND reduces sidebar-
  flow interruption. (#116)
- **Sidebar modals (ProjectPicker, project-delete, session bulk-
  delete) center on screen again.** A non-`none` transform on the
  sidebar at md+ — emitted by the `md:translate-x-0` counter that was
  trying to neutralize the mobile drawer-slide — was creating a CSS
  containing block, so every `fixed inset-0` modal rendered as a
  descendant of the sidebar got positioned inside the sidebar's
  bounding box instead of against the viewport. Visually: modals
  "squished into the session browser." Fix scopes the drawer
  translate to `max-md:` so no transform is emitted at md+ at all.
  (#117)

### Changed

- **Hero carousel images refreshed.** img0, img1, and img2-6 now
  share a consistent 4112×2580 (~16:10) aspect ratio. img1 was
  previously stale from before the recent in-session diff render
  fixes. (#114, #118, #119)

## [1.2.1] — 2026-05-11

### Added

- **Cross-session text search.** New search bar at the top of the app
  searches user / assistant message text and tool-call args across every
  session in every project. ⌘K / Ctrl+K focuses, ↑↓ navigates the
  dropdown, Enter opens the matched session and scrolls the matched
  message into view. Server-side `GET /api/v1/search/sessions?q=…`
  uses ripgrep when available with a Node fallback over
  `${SESSION_DIR}/**/*.jsonl`. Hidden on mobile. (#109)
- **Single-conversation export.** New toolbar button in the chat view
  exports the current session as Markdown (user/assistant headings,
  fenced bash blocks, blockquoted tool results capped at 2 KB) or raw
  JSONL (with subagent children inlined between the parent's `subagent`
  tool call and result, bracketed by synthetic
  `subagent_inline_start` / `subagent_inline_end` envelopes).
  `GET /api/v1/sessions/:sessionId/export?format=jsonl|markdown`.
  Hidden on mobile. (#110)
- **Hunk-level git staging.** Each hunk in the git panel diff now has an
  inline Stage / Unstage button on its header row (sticky-positioned so
  it stays visible during horizontal scroll). Backed by
  `POST /api/v1/git/apply-hunks`, which feeds a hunk-extracted patch
  through `git apply --cached --recount [--reverse]`. Closes the
  Phase 12 deferred item. (#111)

### Changed

- **Docs refresh pass.** README rewrite (245→166 lines) with grouped
  doc index; AGENTS.md / CLAUDE.md realigned with current architecture
  (`cli.ts` env↔flag table, `mcp/` manager, per-project override
  files, `config-export.ts`); new `docs/mobile.md`; `CONTAINERS.md`
  renamed to `containers.md`; landing quickstart restructured around
  two install paths (npm vs Docker); pi-subagents card replaces
  standalone auth card on landing; hero carousel screenshots refreshed
  and extended to nine slides. (#112)

## [1.2.0] — 2026-05-09

### Added

- **CLI flag interface for every operationally-relevant env var.**
  `pi-forge` now accepts `--port 4000`, `--workspace-path ~/Code`,
  `--api-key @/run/secrets/api-key`, etc. — single source of truth
  in `packages/server/src/cli.ts` drives parsing, env writes, and
  `--help`. Sensitive flags (`--ui-password`, `--api-key`,
  `--jwt-secret`) accept `@<path>` to read from a file (curl/gh-
  style) so secrets stay out of shell history. Boolean flags
  accept `--foo`, `--foo=value`, and `--no-foo`. Flag values win
  over env when both are set; env still works as a fallback. Run
  `pi-forge --help` for the grouped table. Removes the npm-install
  user's need to write env wrappers just to set a port. (#101)
- **Mobile-friendly PWA.** Four-PR push to make pi-forge usable on
  a phone without sacrificing any desktop functionality:
  - **Mobile breakpoint + slide-in drawer** (#102): viewport
    detection via `window.matchMedia('(max-width: 767px)')`. The
    project / session sidebar becomes a slide-in drawer behind a
    hamburger button, with both tap-toggle and left-edge swipe
    gestures. Auto-closes on selection, on Esc, and when the
    viewport leaves mobile. Tablets are treated as desktop. The
    "Request Desktop Site" toggle works for free because the
    breakpoint reacts to viewport width, not user-agent.
  - **Off-scope panels hidden on mobile** (#106): editor, files,
    git, and terminal panes are unmounted (not just `display:
    none`) at `< 768 px` so the mobile viewport doesn't load
    CodeMirror or hold a server-side PTY for surfaces the user
    can't see. Header pane-toggle buttons hide together with no
    spacing change at md+.
  - **Chat-view polish** (#107): auto-grow composer (44 px min,
    30vh cap), drag-resize handle hidden on mobile, sticky
    composer above the on-screen keyboard via the new
    `interactive-widget=resizes-content` viewport hint, keyboard
    auto-dismisses on send, Enter inserts newline (mobile virtual
    keyboards don't surface Shift conveniently — Send is the
    explicit button), Send + Abort stack vertically with constant
    row height so the model picker doesn't shift when streaming
    starts, attach popover (Photo / File) replaces side-by-side
    buttons, slash + `@` palette items bumped to ≥ 44 pt with
    stacked descriptions. Touch targets ≥ 44 pt across copy /
    raw / file-ref / sub-agent buttons, all gated with
    `md:min-h-0` so the desktop layout stays compact.
  - **PWA install polish** (#107): safe-area insets on header,
    composer, and drawer (no clipping under iPhone notches /
    Android cutouts; composer rides above the home indicator);
    per-theme `theme-color` meta tag (Android Chrome address bar
    blends with the active theme across all 5 themes); PWA
    manifest tuning (description, categories, lang, orientation);
    install prompt banner (Android `beforeinstallprompt` →
    Install button; iOS Safari → "tap Share, then Add to Home
    Screen" hint); new `docs/mobile.md` covering install paths,
    the HTTPS-required-for-install gotcha for self-hosted, and
    the mobile-specific behaviors.

### Changed

- **`HOST` defaults to `127.0.0.1` in every mode** (was `0.0.0.0`
  in production). Binding loopback by default protects against
  silently exposing the agent's `bash` / `edit` tools to anyone on
  the same WiFi/VLAN/Docker bridge — opt-in, not opt-out. Operators
  who want LAN access set `HOST=0.0.0.0` (or `--host 0.0.0.0`)
  explicitly. The shipped Docker image's `Dockerfile` already pins
  `HOST=0.0.0.0` so the documented `docker compose up` flow works
  unchanged. (#101)
- **`REQUIRE_PASSWORD_CHANGE` defaults to `false`** (was `true`).
  pi-forge is single-tenant and a user setting their own
  `--ui-password` does so deliberately — forcing a password change
  on first login was friction without a real threat-model win.
  Sealed-secret deploys (helm, vault, sealed-secrets) that DO want
  the operator to rotate on first login can opt back in with
  `--require-password-change` or the env equivalent. The shipped
  `docker-compose.yml` and `docker/.env.example` updated to match
  the new default. (#101)
- **TypeScript bumped to 6.0.3** (#95), **`@fastify/multipart`
  bumped to 10.0.0** (#97), **`@types/node` bumped to 25.6.2**
  (#98), **`@xterm/addon-fit` bumped to 0.11.0** (#99),
  **`@xterm/addon-web-links` bumped to 0.12.0** (#96). Major
  bumps; no API surface changes pi-forge actually uses. The
  `@types/node` 25 jump exposed one Buffer-vs-BlobPart type
  inconsistency in `tests/test-config-export.ts` that was fixed
  in the same change.

### Fixed

- **Login no longer 500's when only the persisted `password-hash`
  file exists** (no `UI_PASSWORD` env, no `JWT_SECRET` env). Pre-
  fix, `JWT_SECRET` was only loaded when `UI_PASSWORD !==
  undefined`, so `passwordAuthEnabled()` returned true (because
  the hash file existed) but `jsonwebtoken.sign(payload,
  undefined)` threw. Now the JWT secret is also loaded (or
  generated) when the password-hash file exists. Models the real
  deployment shape where the operator boots once with `UI_PASSWORD`
  set, the user changes their password through the UI (which
  persists the hash; the env value becomes ignored), and on
  subsequent boots the operator drops `UI_PASSWORD` from env.
  Regression test added as `scenarioPersistedHashOnly` in
  `tests/test-auth.ts`. (#106)
- **Slash command palette ran the wrong command on touch.** Tap
  handlers updated `slashSelectedIdx` via React state and then
  called `slashRunSelected()` immediately, which read the *stale*
  state — desktop got away with this because `onMouseEnter` fired
  before `onMouseDown`, but touch has no enter event. Every tap
  ran whatever was last selected (typically `/compact`).
  `slashRunSelected()` now accepts an optional index override;
  tap handlers pass `i` directly. (#107)

## [1.1.6] — 2026-05-09

### Added

- **Pi prompt templates as a first-class surface.** Markdown templates
  under `<dir>/prompts/` (mirrors `<dir>/skills/`) now appear in the
  chat-input slash-command palette as `/<promptname>` entries with
  description + argument hint, and in a new **Settings → Prompts**
  management tab modeled on Settings → Skills (per-project tri-state
  toggles, cascade view across projects). Pi's `session.prompt()`
  already expands `/<name> args` to the template body via
  `expandPromptTemplates: true`, so pi-forge's role is purely
  discovery + management — no server-side expansion. Per-project
  state lives in `${FORGE_DATA_DIR}/prompts-overrides.json`. Toggling
  in Settings → Prompts immediately drops/adds the prompt in the
  chat-input palette without a project switch (cross-component
  refresh trigger via ui-store).
- **Settings → Backup now bundles per-project override files.** Export
  tarball gains `skills-overrides.json`, `tool-overrides.json`, and
  `prompts-overrides.json` alongside the existing `mcp.json` /
  `settings.json` / `models.json`. Pairs the global state with the
  per-project tool/skill/prompt toggles so a backup → restore cycle
  preserves both. `projectId` keys in the override files are local
  UUIDs — importing onto a different installation leaves orphan
  entries that are silently ignored at session-create (deliberate
  trade-off; the alternative would defeat the point of carrying
  per-project config across installs that share workspaces).
- **`npm run dev:remote`** — same as `npm run dev` but binds both
  halves (Fastify + Vite dev server) to `0.0.0.0` so other devices
  on the LAN can reach the dev workbench. Useful for testing on a
  phone, pair-debugging from another laptop, or demoing in a room.
  Set `UI_PASSWORD` or `API_KEY` first — auth is OFF by default in
  dev. macOS will prompt to allow incoming connections on first run.
- **Folder name on project sidebar rows.** Each project row now shows
  the on-disk folder basename below the display name in a smaller
  mono font. Useful when the display name has been renamed away from
  the folder name and you're debugging which checkout the project
  points at.

### Changed

- **Settings panel widened from `max-w-3xl` (768 px) to `max-w-4xl`
  (896 px)** to give the now-9-tab bar (Providers, Agent, MCP, Tools,
  Skills, Prompts, Appearance, Backup, General) breathing room. The
  panel is a modal so the extra width doesn't compete with the chat.
- **Unsaved file indicator on editor tabs is now a 10 px filled
  amber circle.** Was a 12 px bullet character (`•`) at the
  surrounding text size which mostly disappeared into the filename.
  Sized independently of the text so the dirty cue is unmissable;
  `aria-label="Unsaved changes"` for screen readers.

## [1.1.5] — 2026-05-08

### Added

- **Right-click context menu in the file tree, with full action sets per
  target.** File rows: Add as @ context, Add file, Add folder, Rename,
  Download, Delete. Folder rows: same set (folders are valid `@`-references
  too — the model uses ls/grep on them via its tools, with the trailing-
  slash convention disambiguating files from directories). Empty area
  (below the last row): Add file, Add folder. The previous menu had a
  single entry ("Add as @ context") and the empty area surfaced the
  browser's native context menu. Item set is conditional on target kind —
  inapplicable items don't render rather than rendering greyed out.
- **+ buttons for file/folder creation directly on folder rows.** Hover a
  folder in the file tree and the action group now includes
  `FilePlus2`/`FolderPlus` icons that open a create dialog scoped to that
  folder. The dialog title/label/placeholder reflect the parent path
  (`(in src/utils/)` instead of `(relative to project root)`) so users see
  exactly where the new entry will land before confirming. Toolbar
  buttons keep their existing project-root-anchored behaviour.
- **Folder `@`-references in chat.** `@<path>` markers resolving to a
  directory now preserve the marker as `@<path>/` (trailing slash
  appended; `ls -F` convention) so the model can ls/find/grep the folder
  via its tools. Previously rejected as `[@<path> not included: path is
  a directory, not a file]`. Quoted form (`@"docs with spaces/"`) handled
  too. The chat input's `@`-autocomplete surfaces folders in the
  popover automatically — same `/files/complete` endpoint, no client
  change needed.
- **Aggregate-byte budget on `@`-reference inlining.** Previously every
  `@<path>` got an independent per-file decision (inline if ≤ 128 KB,
  defer otherwise) with NOTHING tracking the running total across all
  markers in a single prompt. A user `@`-ing 50 files at 100 KB each
  pushed ~5 MB / 1.25M tokens into one prompt and blew the context
  window. New: classify each marker, sort eligible-for-inline candidates
  ascending by size, walk a 512 KB running budget; survivors inline and
  the rest fall back to defer. Smallest-first walk maximises useful
  inlines (a 2 KB `package.json` + 90 KB README both fit; the 50th
  mid-sized file is the one that defers, not whichever happened to be
  parsed first). Per-file 128 KB cap unchanged — aggregate cap is
  additive.
- **LaTeX math rendering in chat.** `$\rightarrow$` used to render as
  literal text — the markdown renderer (react-markdown 10 + remark-gfm)
  had no math plugin. Wires KaTeX in via remark-math + rehype-katex; both
  `$inline$` and `$$block$$` math now render properly. Bundle grew
  ~280 KB (KaTeX fonts/CSS).
- **Resizable chat composer via drag divider.** The static hairline
  `border-t` above the composer became a real drag handle. Pointer-
  capture-driven (touch/pen/mouse all work) with the textarea height
  persisted to localStorage and clamped to `[60 px, 60% of viewport]`.
  A `RotateCcw` reset button appears in the existing model-picker chip
  row only when the height has been customized — clicking it restores
  the default `rows={3}` layout. Composer stays `resize-none`; the
  divider is the only resize affordance.

### Fixed

- **`Add as @ context` from the file-browser context menu sometimes
  silently dropped.** Root cause was a seq-counter desync in
  `ui-store.ts`: `requestChatInsert` derived its next seq from the
  current request slot (`prev = chatInsertRequest?.seq ?? 0`), which
  reset to 0 every time the consumer cleared the slot. After the first
  successful insert the consumer's `lastChatInsertSeqRef` ratchet (=1)
  silently dropped subsequent requests because they too came in at
  seq=1. Fixed by moving the counter to producer-side ratcheting state
  fields (`_settingsSeq`, `_chatInsertSeq`) that NEVER reset on clear.
  Same bug applied to `settingsRequest` (manifested as `/settings`
  sometimes not opening the panel after the first time) and is fixed
  by the same change.
- **Project-scope skills authored at `<project>/.pi/skills/foo.md`
  silently failed to load.** Pi's `loadSkillFromFile` derives a skill
  name as `frontmatter.name || basename(dirname(filePath))` — the
  fallback is the PARENT DIR NAME, not the file basename. So
  `<project>/.pi/skills/foo.md` (no `name:` in frontmatter) loads as
  `name: "skills"` and collides with any other top-level `<dir>/*.md`
  that hits the same fallback; the SDK keeps the first one and silently
  emits a `type: "collision"` diagnostic for the loser. pi-forge was
  discarding `result.diagnostics` from `loadSkills`. Now surfaced
  through `GET /config/skills` and rendered in the SkillsTab as a red
  banner showing both winner and loser file paths plus an actionable
  hint ("add `name: <unique>` to the loser's frontmatter, or move it
  to `<unique>/SKILL.md`").
- **About panel showed `0.0.0` on npm-installed pi-forge.** `health.ts`'s
  `SERVER_VERSION` walks up exactly two levels from `routes/health.js`
  to find package.json — works for the in-repo + Docker layouts but the
  npm-publish synthetic flat layout puts the code at
  `<install>/dist/server/routes/health.js` where up-two has no
  package.json. Now tries up-two first (workspace + Docker authority)
  then up-three (publish flat layout); first resolvable hit wins.
- **README missing the npm install path.** v1.1.2 added npm
  distribution but Quick start only documented Docker. Added
  `npx pi-forge` / `npm i -g pi-forge` paths alongside Docker, plus a
  cross-link to `docs/configuration.md` for env var overrides. Source-
  build instructions stay in `CONTRIBUTING.md`; README just links to it.
- **Multiselect highlighting on file tree + session sidebar was nearly
  invisible.** Selected rows used `bg-emerald-900/20` (20% opacity over
  neutral-950) plus a `hover:bg-neutral-900` rule that completely hid
  the selection on cursor-over. Now: 2-px saturated LEFT BORDER
  (`border-blue-400`) + `bg-blue-500/15` + `hover:bg-blue-500/25` so
  selection stays legible. Border lives on every row (transparent when
  unselected) so toggling selection doesn't shift content by 2 px.
  Blue, not emerald, to disambiguate from the file-tree's emerald drop-
  target ring.

### Dependencies

- **Pi SDK trio migrated to `@earendil-works/*` scope.** Upstream
  renamed: `@mariozechner/pi-{coding-agent,agent-core,ai}@0.73.1` →
  `@earendil-works/pi-{coding-agent,agent-core,ai}@0.74.0`. The 0.74.0
  release is a clean rename — upstream commit log shows
  "chore: migrate pi packages to earendil works scope" plus internal
  tooling. No API changes affecting pi-forge's integration surface.
  Mechanical sed replacement of import paths and doc references across
  16 source / doc files. Eliminates 4 of the deprecation warnings in
  `notes/DEPREC.md`.
- **Vite stack upgraded to v8.** `vite ^6.3.3 → ^8.0.11` (skip major
  v7), `@vitejs/plugin-react ^4.7.0 → ^6.0.1`,
  `vite-plugin-pwa ^0.21.1 → ^1.3.0`,
  `@tailwindcss/vite + tailwindcss ^4.1.4 → ^4.3.0`. Drop-in upgrade —
  zero code changes. Vite v8 ships rolldown as the default bundler:
  production build dropped from ~1.78 s to **463 ms**, dev server boots
  in **108 ms**. `npm dedupe` collapsed the duplicate vite installs
  introduced by hoisting (lockfile shrank by ~275 lines). Closes
  dependabot PRs #72 and #74.
- `fast-xml-builder 1.1.5 → 1.2.0` (transitive bump; picks up 1.1.6 +
  1.1.7 security fixes for comment / attribute-value handling).
- CI: `actions/configure-pages 5 → 6`, `docker/setup-buildx-action 3 → 4`
  (both Node 24 runtime upgrades; bare action calls so the v4 "Remove
  deprecated inputs/outputs" change has no effect on our usage).

### Packaging

- **Terminal no longer fails to spawn on the npm-installed
  pi-forge.** The npm tarball ships `node-pty`'s prebuilt
  `spawn-helper` at `0644` (no exec bit), which makes every PTY spawn
  fail with `posix_spawnp failed`. Upstream node-pty's postinstall
  handles the from-source build path but not the prebuilt path, so the
  bug shipped with every install. Added a `scripts.postinstall` in the
  synthetic publish package.json that walks
  `node_modules/node-pty/prebuilds/*/spawn-helper` and chmods +x.
  Idempotent and failure-tolerant. Lands invisibly for the v1.1.5
  release; v1.1.4 users still need the manual `chmod +x` workaround.

## [1.1.4] — 2026-05-08

### Fixed

- **Diff scrollbar marks now stay pinned to the scrollbar.** The
  CodeMirror file viewer's container had `overflow-auto` while the
  editor itself had no forced height, so `.cm-editor` grew to the
  document's full content height and the parent div became the actual
  scroll container instead of CM6's `.cm-scroller`. The diff overview
  overlay (mounted on `view.dom` / `.cm-editor`) translated along with
  the editor on every scroll, making the colored marks "follow" the
  text instead of staying anchored to the scrollbar. Forcing
  `.cm-editor { height: 100% }` and switching the wrapper to
  `flex-1 min-h-0` puts the scroll back where CM6 expects it — marks
  are pinned, and viewport virtualization works again so large files
  no longer render every line into the DOM.
- **pi-subagents now works inside the Docker image.** The plugin
  shells out via `child_process.spawn("pi", ...)` and on Linux has no
  fallback resolution — the container previously failed every subagent
  call with `spawn pi ENOENT`. The runtime image now prepends
  `/app/node_modules/.bin` to `PATH`, exposing the `pi` bin shim
  shipped by `@mariozechner/pi-coding-agent` (already a server
  dependency, so no extra install). Verifiable with
  `docker compose exec pi-forge sh -c 'which pi && pi --version'`.
- **Session sidebar refreshes around sub-agents.** The list now
  refetches when (a) a parent session finishes a `subagent` tool call
  (so newly-spawned children appear without a manual refresh), and
  (b) a parent session is deleted (so the server's cascade-removed
  child JSONLs disappear from `byProject` instead of lingering as
  sidebar orphans). Cross-tab `session_deleted` receivers refetch on
  the same paths.
- **Cascade-delete now disposes LIVE sub-agent children before
  removing their JSONLs.** Previously, opening a sub-agent session in
  the UI promoted it to a `LiveSession` in the in-memory registry,
  and deleting the parent's JSONL would `rm -rf` the sibling subagent
  dir but leave the live child entry pointing at the now-deleted
  file. Any SSE clients still attached to the zombie kept emitting
  events that couldn't be persisted. `deleteColdSession` now disposes
  every registered child of the deleted parent (in parallel — each
  dispose can wait up to 5 s on its own LLM-call abort) before
  unlinking. Test coverage added in `tests/test-subagent-discovery.ts`
  via a resume-then-cascade fixture.
- **Terminal panel render crash on cold mount.** A stale
  `packages/client/node_modules/@xterm/xterm@6` install was getting
  picked over the hoisted `@xterm/xterm@5.5` at the root, while the
  addons (`addon-fit`, `addon-web-links`) still expected v5's
  `_viewport.scrollBarWidth` shape. First terminal mount threw
  `e2.viewport is undefined` at the React error boundary. Lockfile
  dedupe drops the workspace-local v6, leaving the hoisted v5.5 as
  the single resolution.
- **Dev-server crash on every TSX request.** `@vitejs/plugin-react@6`
  peer-deps `vite ^8.0.0`, and v8 routes its React Refresh wrapper
  through rolldown's new transform hook — which
  `vite-plugin-pwa@0.21.x`'s dev middleware doesn't speak. Every
  `/src/*.tsx` returned `Pre-transform error: Missing field
  'moduleType'`. Production builds were unaffected (rollup, not
  rolldown), so `npm run build` and `npm run test:ci` both passed;
  only `npm run dev` was broken. Plugin reverted to `^4.7.0` and the
  verification protocol in `notes/DEPENDABOT.md` now requires a
  dev-server boot-and-fetch alongside check + build + test:ci for any
  client-touching dep change.
- **`react`/`react-dom` version-pair mismatch white-screen.** A
  Dependabot solo bump of `react` 19.2.5 → 19.2.6 left `react-dom`
  at 19.2.5 in the lockfile. React 19 enforces exact-version pairing
  at runtime; production survived because the assertion is
  `__DEV__`-gated and gets dead-code-eliminated by rollup, but
  `npm run dev` threw "Incompatible React versions" on first paint.
  Both packages are now pinned to 19.2.6 in lockstep.
- **`release.yml` couldn't install npm@latest.** Node 22.22.2's
  hostedtoolcache image ships a corrupted bundled npm — the
  `promise-retry` module is missing from `@npmcli/arborist`'s
  node_modules, so any `npm install -g npm@<anything>` crashes with
  `MODULE_NOT_FOUND` before completing the upgrade. Confirmed
  regression vs 22.22.1 (nodejs/node#62425, actions/runner-images#13883).
  Pinned `node-version: 22.22.1` in `release.yml`'s npm-publish job;
  revert to plain `22` once 22.22.3 ships with the fix from
  nodejs/node#62463.

### Changed

- **Dependabot config now ignores satellite-lag traps.** Two ignore
  rules added to `.github/dependabot.yml`:
  (a) Docker `node` major bumps to non-LTS lines (23, 25, 27, ...) —
  pi-forge tracks LTS only and shouldn't auto-bump to the unsupported
  "current" Node line. Re-evaluate when 24 reaches Active LTS in
  April 2027.
  (b) `@xterm/xterm` major bumps — the addon ecosystem
  (`@xterm/addon-fit`, `@xterm/addon-web-links`) only ships matching
  v6-compatible releases as `0.12.0-beta.X`/`0.13.0-beta.X`;
  auto-bumping xterm alone produces a peer-dep mismatch that
  soft-passes on existing lockfiles but breaks fresh `npm ci`. Both
  rules carry a comment with the recipe to re-evaluate them
  periodically.
- **GitHub Actions modernized.** Bumped `actions/checkout` 4 → 6,
  `actions/download-artifact` 4 → 8, `actions/upload-artifact` 4 → 7,
  `actions/upload-pages-artifact` 3 → 5, `actions/deploy-pages` 4 → 5,
  `actions/setup-node` 4 → 6, `docker/build-push-action` 6 → 7,
  `docker/login-action` 3 → 4, `docker/metadata-action` 5 → 6,
  `softprops/action-gh-release` 2 → 3. All first-party actions
  following backward-compatible deprecation cycles. Affects CI +
  release workflows; no change to runtime behavior.
- **Lint config pinned to canonical hooks rules.**
  `eslint-plugin-react-hooks@7`'s `recommended` config introduced the
  React Compiler rule pack (`set-state-in-effect`, `refs`, `purity`,
  `preserve-manual-memoization`, `immutability`, `static-components`,
  `error-boundaries`, etc.) — aspirational checks for code that opts
  INTO the React Compiler. pi-forge doesn't, and the patterns those
  rules flag are deliberate design choices. `eslint.config.js` now
  pins to `react-hooks/rules-of-hooks` (error) and
  `react-hooks/exhaustive-deps` (warn) explicitly. Adopting the
  compiler rules would be a separate explicit decision.

### Security

- **Transitive lockfile updates** for security advisories landed via
  Dependabot security PRs: `tar` + `@types/tar`, `ip-address` +
  `express-rate-limit`, `basic-ftp` 5.3.0 → 5.3.1
  (GHSA-rpmf-866q-6p89), `serialize-javascript` 6 → 7 +
  `workbox-build` patch. All lockfile-only changes; no API surface
  affected.

### Dependencies

- **Pi SDK trio bumped 0.73.0 → 0.73.1**
  (`@mariozechner/pi-coding-agent`, `@mariozechner/pi-agent-core`,
  `@mariozechner/pi-ai`). Patch-level; no breaking changes affecting
  pi-forge. Pi-side fixes that pi-forge benefits from passively:
  better handling of interleaved chat-completion deltas in
  OpenAI-compatible streams (vLLM, LiteLLM), OpenAI Responses
  reasoning text deltas for LM Studio, Codex Responses non-empty
  system prompt + OAuth stderr fix, JSONC parsing for custom
  `models.json` (forward-compat — pi-forge still writes strict JSON).
  Heads-up: pi has begun migrating from `@mariozechner/*` to
  `@earendil-works/*` org; doesn't affect this release but the next
  major SDK bump may switch dep names.
- **eslint v10 cluster.** Coordinated bump of the eslint family:
  `eslint` 9 → 10, `@eslint/js` 9 → 10, `eslint-plugin-react-hooks`
  5 → 7, `typescript-eslint` 8.31 → 8.59 (fold-in patch). pi-forge
  already used flat config so the v10 migration was straightforward;
  one new built-in (`no-useless-assignment`) caught a real
  dead-assignment in `McpStatusBadge.tsx`, fixed by collapsing an
  if/else chain to a ternary. Solo merging the family was impossible
  — each PR's CI was red because it needed its siblings.
- **Other dep bumps** (lockfile-only or dev-tool): `react` +
  `react-dom` 19.2.5 → 19.2.6, `eslint-plugin-react-refresh` 0.4.26 →
  0.5.2, `marked` 16 → 18 (dev), `globals` 16 → 17 (dev),
  `lucide-react` 0.503 → 1.14. The Dependabot-proposed
  `@vitejs/plugin-react` 4 → 6 + `vite-plugin-pwa` 0 → 1 cluster is
  intentionally HELD for a future coordinated `vite v8` stack
  upgrade — see ignore rules and the open #72/#74 PRs.

### Documentation

- README's "Tools & MCP" feature list now includes pi-subagents.
  `docs/configuration.md` gains a "Pi plugins" section documenting
  the `pi install npm:<package>` install path and the pi-subagents
  surface specifically. CLAUDE.md drops the "sub-agent dropdown"
  deferred entry and rewrites the Pi-SDK-key-fact line to point at
  the actual integration code.

## [1.1.3] — 2026-05-07

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
