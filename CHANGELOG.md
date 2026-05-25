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

### Security

- **Bumped `uuid` to ≥11.1.1** via an `overrides` entry to fix
  [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq)
  (missing buffer bounds check in v3/v5/v6 when `buf` is provided).
  The vulnerable copy was pulled transitively by `exceljs@4.4.0`,
  which declares `uuid: ^8.3.0`; the override forces it past the
  range. exceljs's actual usage is `v4`-only, which is API-compatible
  across the major bump, so the override is safe at runtime
  (verified by `test-session-export.ts`).
- **Bumped `qs` to ≥6.15.2** via an `overrides` entry to fix
  [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26)
  (DoS via `qs.stringify` crash on null/undefined comma-format array
  entries when `encodeValuesOnly` is set). Vulnerable copy was pulled
  transitively by `@modelcontextprotocol/sdk → express → body-parser`.

### Changed

- **Pi SDK trio bumped 0.74.0 → 0.75.5** (`@earendil-works/pi-coding-agent`,
  `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`). Notable
  behaviour change absorbed: `session.compact()` on a session with no
  provider configured now throws `"No API provider registered for api: X"`
  instead of the older `"No API key found"`. The `mapSdkError` helper in
  `routes/control.ts` was extended with a regex case so the new wording
  still maps to the typed `no_api_key` 400 response that clients depend on.
- **Dev-tooling bumps**: `eslint` 10.3.0 → 10.4.0, `typescript-eslint`
  8.59.3 → 8.59.4, `@types/node` 25.8.0 → 25.9.1, `@types/react`
  19.2.14 → 19.2.15, `vite` 8.0.13 → 8.0.14, `marked` 18.0.3 → 18.0.4.
  No code-level fallout — typecheck + lint + full test suite clean.

### Added

- **Session orchestration — one session can spawn, observe, and
  coordinate other sessions.** Off by default; the operator opts
  in with `ORCHESTRATION_ENABLED=true`, and each session that
  should act as a supervisor opts in separately via the chat-view
  `Orch` toggle. Hard-disabled under MINIMAL_UI regardless of the
  env flag.

  Topology: strict hub-and-spoke at depth=1. A supervisor session
  gets a new `orchestrate_*` tool group; workers do not, so they
  have no way to talk to each other. Workers cannot themselves
  become supervisors (no fork-bombs by buggy prompts). Same-
  project only — cross-project orchestration is intentionally out
  of scope for v1.

  Tool surface (8 tools, supervisor-only):
  - `orchestrate_spawn_worker` — create a new worker session in
    the same project. `name` is required so the picker stays
    legible when several workers run in parallel. Optional
    `contextSummary` parameter prepends a handoff summary to the
    worker's initial prompt.
  - `orchestrate_list_workers` — current state of every linked
    worker (streaming / idle / cold) with message counts.
  - `orchestrate_read_worker` — fetch the most recent messages
    from a worker's transcript (auto-resumes cold workers).
    Default `limit` is 1 — the worker's single latest message is
    enough context for most supervisor decisions, and bigger
    pulls burn the supervisor's own context window. Messages are
    serialized into the tool-result *text* as a readable
    transcript (per-message role + extracted text + tool_use
    names + tool_result previews); the supervisor LLM cannot see
    fields placed only in `details`, so the read tools have to
    encode their payload into the content.
  - `orchestrate_send_to_worker` — inject a message into a
    worker's prompt stream as `prompt | steer | followUp`.
    Tagged `[supervisor:<id>]` in the worker's transcript.
  - `orchestrate_interrupt_worker` — abort a worker's current
    turn.
  - `orchestrate_kill_worker` — dispose the worker session,
    optionally also delete the .jsonl from disk.
  - `orchestrate_detach_worker` — drop the supervisor↔worker
    link; the worker continues as a standalone session.
  - `orchestrate_read_inbox` — drain pending worker events
    (ended / asked / retry-failed / process-alert / deleted).

  Wake-up: worker events route into a per-supervisor inbox queue
  (`${FORGE_DATA_DIR}/orchestrator-inbox.json`, FIFO-capped at
  200 / supervisor). When the supervisor is live and idle, a
  `[orchestration]` system prompt is injected so the agent
  starts a new turn that processes the inbox via
  `orchestrate_read_inbox`. If the supervisor is mid-turn, the
  push skips and the items wait — recovery fires another push
  when the supervisor's own `agent_end` lands.

  Safety:
  - Per-supervisor live-worker cap (default 8, configurable via
    `ORCHESTRATION_MAX_WORKERS_PER_SUPERVISOR`).
  - Every orchestration tool that names a workerId verifies
    ownership against the store first — a supervisor cannot
    touch another supervisor's workers by id-guessing.
  - Worker spawn/kill events route through the existing webhooks
    event bridge AND the orchestration inbox in parallel — the
    two systems are independent.
  - Audit trail is `process.stderr` JSON-line logs
    (`orchestration-inbox-enqueued`, `orchestration-wake-
    delivered`, etc.) — no separate audit-log UI by design,
    operators tail container logs.

  UI: a `Orch` toggle button in the chat-view toolbar (visible
  only when the instance flag is on) opens the per-session
  Orchestration panel. Standalone sessions get an "Enable
  supervisor mode" button; supervisors see their workers list
  with detach / kill / resume controls and an inbox-history
  drawer; workers see a back-link to their supervisor. The
  panel polls every 4s while open. Enable / disable rebuild
  the live AgentSession in-place (same SessionManager, new
  `customTools`, SSE clients stay attached) so the
  orchestrate_* tools appear or disappear immediately — no
  reconnect, no risk of a pre-prompt session being lost to
  the cold-resume 404 race or a post-prompt session hitting
  the dispose tombstone's 410.

### Changed

- **Clone-repository project setup gains an "Allow self-signed /
  invalid TLS certificate" checkbox.** Mirrors the same posture
  as the webhook `insecureTls` flag — necessary for internal Git
  hosts with self-signed certs (corporate GHE, on-prem GitLab
  with a private CA). When set, the spawn passes
  `GIT_SSL_NO_VERIFY=true` to git, and a
  `git-clone-insecure-tls` line gets written to stderr on every
  use so the relaxed posture is visible in `docker logs`. URL
  validation still enforces HTTPS — the flag relaxes cert
  validation, not the scheme.

### Added

- **Webhooks for agent and session events.** New Settings →
  Webhooks tab lets the user configure HTTPS POST destinations
  that fire when interesting things happen. Six event types in
  v1:
  - `agent_end` — turn finished. Payload includes stopReason,
    errorMessage (if any), assistant text, usage stats,
    provider/model.
  - `ask_user_question` — agent put up a multi-choice prompt and
    is waiting on the user. Payload includes the questions array.
  - `process_alert` — background process exited (success /
    failure / external kill). Same trigger conditions as the
    in-chat agent alert.
  - `auto_retry_end` (failures only) — provider-side retry
    exhausted. The kind of thing you'd want to page on.
  - `compaction_end` — context was compacted (not aborted).
  - `session_created` / `session_deleted` — lifecycle audit
    events.

  Scoping: each webhook is either **global** (fires for every
  project's events) or **per-project** (fires only for events
  with a matching projectId). Both can coexist.

  Delivery: fire-and-forget POST with retry on 5xx / network
  errors (exponential backoff: 1s, 5s, 30s — 3 attempts total).
  4xx responses are terminal (no retry; consumer's problem).
  Per-webhook delivery history is persisted at
  `${FORGE_DATA_DIR}/webhook-deliveries.json` capped at 100
  entries per webhook (rolling FIFO) and surfaced in the
  Settings tab for debugging.

  Security:
  - HTTPS-only URLs. HTTP is rejected even with the cert-bypass
    flag set — that flag relaxes cert validation, not the
    scheme.
  - Optional HMAC-SHA256 signing: when a secret is configured,
    every delivery includes `X-Pi-Forge-Signature: sha256=<hex>`
    over the raw JSON body. Same convention as GitHub webhooks.
  - Secrets stored in `${FORGE_DATA_DIR}/webhooks.json` (mode
    0600) and never returned over the wire (`hasSecret: boolean`
    presence flag instead).
  - Per-webhook "Allow self-signed / invalid TLS certificate"
    opt-in for internal hosts with custom CAs. Every fire with
    `insecureTls=true` logs to stderr so the relaxed posture is
    visible in `docker logs`.
  - Custom user-supplied request headers (e.g. `Authorization:
    Bearer ...`) are merged into every delivery, but reserved
    `X-Pi-Forge-*` headers cannot be overridden by config.
    Header VALUES are redacted on the wire — GET responses show
    the header NAME but replace the value with the
    `***REDACTED***` sentinel, the same convention
    `config-manager.ts` uses for inline `apiKey` in models.json.
    Editing in the UI preserves stored values: any header line
    left with the sentinel value on PATCH is "keep the existing
    value"; typing a new value replaces it; deleting the line
    removes the header. CREATE rejects the sentinel as a real
    header value (no prior to keep). Defense-in-depth in the
    dispatcher: if the sentinel ever sneaks into the stored
    config (hand-edit, future bug), it's skipped at outbound-
    POST time so consumers never see `Authorization:
    ***REDACTED***` on the wire.
  - Disabled under MINIMAL_UI: POST/PATCH/DELETE/test routes
    return 403; the Webhooks Settings tab is hidden entirely.
    Locked-down deploys can still GET to audit configured
    webhooks via the API.

  Headers on every delivery: `X-Pi-Forge-Event: <event>`,
  `X-Pi-Forge-Delivery: <uuid>` (idempotency key, same across
  retries of one logical delivery), `X-Pi-Forge-Signature:
  sha256=<hex>` when signing is enabled.

  Routes (all `/api/v1/`): `GET /webhooks` (optional
  `?projectId=` filter), `POST /webhooks`, `PATCH /webhooks/:id`,
  `DELETE /webhooks/:id`, `POST /webhooks/:id/test` (fire a
  synthetic `webhook.test` event for verification), `GET
  /webhooks/:id/deliveries` (newest-first history).

  New test: `tests/test-webhooks.ts` — 37 assertions covering
  URL validation, CRUD round-trip, wire shape (secret stripped),
  HMAC signature, custom header merge with reserved override
  protection, scope and event filtering, disabled webhooks
  skipped, retry policy (2xx no retry, 4xx no retry, 5xx
  retries), delivery history persisted + capped, and the
  MINIMAL_UI gate.

- **Mobile-only quick-list popovers for processes and todos on
  the chat-input footer badges.** The chat-input badges for
  running processes and todos route to right-pane panels on
  desktop (the existing behavior, unchanged). On mobile (narrow
  viewport detected via `useIsMobile`) the right pane stays
  collapsed and the same right-pane auto-expand logic in
  App.tsx is `!isMobile`-gated, so routing to it from the badge
  used to be a dead-end interaction. The mobile path now opens a
  small floating popover anchored above the badge, showing the
  list inline — the popover IS the panel for the mobile case.
  Outside-click and Escape close it. The processes popover
  surfaces live runtime (updates per second while open), pid,
  status badge, and an inline Kill button; the todos popover
  renders the checklist with status glyphs and strikethrough for
  completed items, skipping soft-deleted tombstones. Width clamps
  to the viewport via `max-w-[calc(100vw-1rem)]`.

### Fixed

- **"Full stdout/stderr log" buttons on a process navigated the
  current tab as a side-effect of opening the new one.** The
  `window.open(blobUrl, "_blank", ...)` call ran AFTER `await
  fetch(...)`, so by the time it fired the user-gesture chain was
  broken and the popup blocker kicked in. The fallback path then
  `window.location.assign(blobUrl)`'d, navigating the current tab.
  When the user clicked "allow" on the popup-blocker prompt the
  new tab opened too — hence "opens in a new tab AND changes the
  current tab." Fix: open the new tab synchronously to about:blank
  inside the click handler (counts as user-initiated, popup
  blocker stays quiet), then navigate it once the fetch resolves.
  If the synchronous open is still blocked (strictest popup
  configs), surface a clear "popup blocked" error instead of
  stealing the current tab. Additionally, the log content is now
  wrapped in a minimal HTML document with explicit dark CSS and a
  meaningful `<title>` — the prior single-step open landed on
  whatever the browser's default plain-text rendering happened to
  be (Chrome auto-dark, Safari/Firefox white), and the new
  about:blank-then-navigate sequence broke that heuristic and
  consistently showed white. The HTML wrapper makes the rendering
  deterministic (dark by default, respects
  `prefers-color-scheme: light`), gives the tab a useful label,
  and softens line wrapping.
- **Settings modal tab strip overflowed on narrow viewports.**
  With 10+ tabs the strip ran off the right edge of the modal —
  visible on mobile PWA, small desktop windows, and the iPad
  split-view layout. The tabs are now wrapped in a horizontally
  scrollable container with `overflow-x-auto`, `min-w-0` so the
  flex item can actually shrink, and `shrink-0` /
  `whitespace-nowrap` on each tab so labels stay intact under
  scroll. The trailing controls (API Docs / Close) stay fixed to
  the right.

- **Background processes notify the agent on completion.** The
  `process` tool's `alertOnSuccess` / `alertOnFailure` /
  `alertOnKill` flags were previously stored on `ProcessInfo` but
  never consumed — nothing fired when a process exited. Now: when
  a process exits and the matching alert flag is set, the manager
  emits a `process_alert` event that the SSE bridge translates
  into `session.sendUserMessage()` with `deliverAs: "followUp"`,
  giving the agent a turn to react. Message format:
  `[process alert] "<name>" (id=<id>) finished successfully (exit
  0).` (or `failed with exit code N`, or `was killed externally`)
  + a nudge to call `process output` to inspect what it produced.
  Defaults: alertOnFailure is on (the common case the agent
  usually wants to know about), alertOnSuccess + alertOnKill are
  off (would be noisy for the common cases). Tool-initiated kills
  (the agent calling `process kill` itself) never trigger an
  alert — would be redundant. The alert lands in the chat as a
  normal user-shaped bubble with the `[process alert]` prefix so
  it's obvious it's automated rather than typed by the user.

### Fixed

- **Spurious "Reconnecting" banner during long idle gaps on
  deployments behind HAProxy.** Same root cause as the
  compaction-banner fix: the 20-second heartbeat was only ~13
  bytes (`: heartbeat\n\n`), below HAProxy's small-write buffer
  threshold. During a long-running agent turn with no token output
  (slow LLM call, long-running tool, multi-second prefill),
  heartbeats sat in the router's response buffer and never reached
  the client. The connection eventually timed out somewhere on
  the path, and the browser showed a misleading "Reconnecting —
  server closed stream" banner even though the server side was
  still alive. Fix: pad every heartbeat to 2KB so it crosses the
  buffer-flush threshold and actually reaches the client. Same
  mechanism as the per-turn compaction-start padding flush, but
  applied to the every-20s heartbeat. Bandwidth cost is ~100
  bytes/sec/client sustained — negligible.

- **Clone a git repository as a new project.** New "Clone repository"
  tab in the project picker. Streams `git clone --progress` over SSE
  so the user sees a real-time progress bar + phase label
  ("Receiving objects 45%", "Resolving deltas 100%", etc.) instead
  of a blocked spinner during a multi-minute clone of a large repo.
  Form takes:
  - **Repository URL** — HTTPS or `file://`. SSH URLs are out of
    scope for v1.3.0; use `gh repo clone` from the integrated
    terminal for SSH-based clones.
  - **Branch** (optional) — defaults to the remote's HEAD.
  - **Folder name** (auto-filled from the URL's last path segment,
    overrideable) — relative to the workspace root.
  - **Project name** (auto-filled from the folder name).
  - **Access token** (optional, masked) — for private repos. Embedded
    as `x-access-token:<token>` in the clone URL (the GitHub
    convention; works for GitHub.com, GitHub Enterprise, GitLab PATs,
    Bitbucket app passwords, Gitea PATs). Stripped from
    `.git/config` after success; if the clone fails partway, the
    target directory is rm-rf'd so no leftover token bytes survive.
  Defense-in-depth: target path is validated to be inside
  `WORKSPACE_PATH` (403 otherwise); pre-existing non-empty target
  returns 409 before any spawn; clone is cancellable via the
  request `AbortSignal` (client disconnect kills the child with
  SIGTERM → 5s grace → SIGKILL). Same heartbeat-and-padding-flush
  pattern as the compaction SSE so the stream works behind
  OpenShift's HAProxy router.
- **`gh` (GitHub CLI) in the Docker image.** Installed from the
  official GitHub apt repository so `gh auth login`, `gh pr`,
  `gh issue`, `gh repo clone`, etc. work out of the box in the
  integrated terminal and via the agent's `bash` tool. Available on
  PATH for the running server and any process it spawns.

### Changed

- **Session DELETE always hard-deletes the JSONL.** Previously
  required `?hard=1` on the route and a `{hard: true}` opt in the
  client API — but the UI passed it unconditionally, so the
  non-destructive path was vestigial and confusing for programmatic
  clients. Now: `DELETE /api/v1/sessions/:id` always disposes the
  live session AND removes the JSONL AND cascade-removes any
  pi-subagents child JSONLs nested under it. Client API simplified
  to drop the `hard` parameter. Removing the JSONL was already what
  every UI delete did; this just makes the default match the user's
  mental model of "delete means gone."
- **Project DELETE always wipes the session directory + auto-disposes
  live sessions.** Same "delete means gone" framing as the session
  change above. Three things change:
  - The session-directory cleanup was previously opt-in via
    `?cascade=1` on the route + a checkbox in the delete-project
    dialog. The default-off behavior left a `<projectId>/`
    directory on disk that the UI had no way to reach ever again
    (even when individual sessions had been deleted earlier —
    `deleteColdSession` only unlinks the JSONL, not the parent
    dir). Now: `DELETE /api/v1/projects/:id` always removes the
    project record AND rm -rf's `${SESSION_DIR}/<projectId>/`,
    JSONLs and all. Route drops the `?cascade=` query param;
    client API drops the `{cascade}` opt.
  - The UI no longer blocks delete when the project has live
    sessions. The previous "dispose them first, then try again"
    alert was busy-work — live sessions are now disposed
    automatically as the first step of the delete (in parallel,
    best-effort), then the server-side rm -rf cleans up their
    JSONLs.
  - The sidebar delete dialog gains a required confirmation
    checkbox when the project has sessions: "Yes, I understand
    this will delete N session(s). This can't be undone." Forces
    a deliberate acknowledgment for the destructive case without
    re-introducing the old opt-in cascade toggle. Empty projects
    skip the checkbox.
  - The project's workspace folder
    (`${WORKSPACE_PATH}/<projectName>/`) is still never touched —
    that's almost always real work the user wants to keep.

### Added

- **`process` tool — browser-native implementation of the
  [`@aliou/pi-processes`](https://github.com/aliou/pi-processes)
  contract (MIT).** Lets the agent spawn and manage background
  processes (dev servers, watchers, builds, long-running scripts)
  as a separate lifecycle surface from `bash`. Contract-identical
  to the plugin: same tool name (`process`), action enum
  (`start | list | output | logs | kill | clear | write`), same
  `ProcessInfo` shape, same status state machine
  (`running → terminating → terminate_timeout → exited | killed`),
  same `logWatches` regex shape, same envelope
  (`{content:[{type:"text",text}], details:{action, success,
  message, process?, processes?, output?, logFiles?, cleared?}}`).
  Server spawns via `/bin/sh -c` with scrubbed env (no pi-forge
  or provider secrets leak — same posture as the integrated
  terminal); stdout/stderr each tee to a per-process disk log
  with a ring buffer + 10MB rotation. Termination is
  SIGTERM → 5s grace → SIGKILL. Log watches compile to regex and
  fan out as `process_watch` SSE events for agent-alerting UI.
  State is in-memory per session (no on-disk process registry);
  every live process is killed on session dispose and the log dir
  is cleaned up. Client surfaces a new right-pane "Processes" tab
  with grouped running/finished lists, expandable per-process
  details, kill button, and a "Full log" link that fetches the
  on-disk file through an authed-fetch blob URL (so the bare
  `<a href>` auth attachment problem doesn't bite). Activity icon
  badge on the chat input shows the running count and opens the
  pane on click. Defense-in-depth `MINIMAL_UI` gate refuses
  `start` at both the route and tool boundaries. Implementation
  is independent except for the prompt snippet + tool description
  + guidelines, which are ported verbatim with attribution. See
  `docs/processes.md` for the cross-reference.
- **Hover-revealed message timestamps.** Each user and assistant
  message bubble now shows its wall-clock timestamp next to the
  role label on hover (fades in via `group-hover`). Reads the
  SDK's `message.timestamp` (Unix ms) and renders short local
  time (e.g. `3:45 PM`); hovering the timestamp itself surfaces
  the full localized date+time in a native tooltip. Streaming
  messages without a stored timestamp render nothing. Chrome
  stays out of the way until the user actually wants the
  information.

### Changed

- **Chat hides the latest compaction's kept window inside the
  CompactionCard's expand drawer.** Pi's compaction summarizes the
  oldest messages and keeps `keepRecentTokens` worth (default 20k
  tokens, easily 30-50 messages) of recent context verbatim so the
  agent has working memory. The chat used to render those kept-
  window messages as inline bubbles below the CompactionCard,
  which made it look like compaction hadn't accomplished anything
  — the summary card appeared, but the same conversation was
  still visible below it. The kept-window messages are unchanged
  in `session.messages` (the agent still sees them); only the
  inline rendering is suppressed. The latest card's
  `archivedMessages` already includes everything between the
  previous compaction and this one — so expanding the card
  surfaces the full picture for anyone who wants to scroll back.
  Earlier compactions (`insertBeforeIndex=0`) had their kept
  windows re-archived by later compactions; their messages
  already lived in their own `archivedMessages` and were never in
  the post-compaction `messages` array, so no rendering change
  was needed for them.
- **Tighter MCP tool-result cap.** `MCP_TEXT_CAP_CHARS` lowered
  from 100,000 chars (≈ 33k real tokens) to 30,000 chars (≈ 10k
  tokens). The old ceiling let one chatty `list_everything` call
  dump 30k+ real tokens into a single round trip — most of a
  session's usable context budget — and triggered compaction far
  earlier than the operator expects. 10k tokens is the practical
  upper bound for a single tool response; anything bigger should
  be paginated, filtered, or written to disk for the agent to
  `read` incrementally. The 60/40 head/tail split and the
  truncation marker the agent reads stay the same; only the cap
  moved. Test suite reads the constant dynamically, so it
  auto-adapted.
- **Context Inspector token heuristic moved from chars/4 → chars/3.**
  All three local estimators (`categorizeContext` for the breakdown
  bar, `estimateTokens` for the per-row badge, the per-turn `New`
  delta) now share a single `CHARS_PER_TOKEN` constant. The textbook
  4:1 ratio comes from English prose; pi-forge sessions are
  predominantly tool-call JSON, code, diffs, and search results,
  where real tokenizers run closer to 3:1. Empirically the 4:1
  estimate was under-counting tool-result-heavy turns by 20–40%,
  making the inspector's breakdown bar disagree with the
  authoritative `usage.input` total in the top context-window bar.
  The authoritative count is unchanged (still pulled from the
  SDK's `getContextUsage().tokens`); only the local estimates that
  *bucket* it across categories shift.

### Fixed

- **"Compacting context…" banner doesn't appear when deployed
  behind an L7 proxy that buffers responses (OpenShift's HAProxy
  router most painfully).** The `compaction_start` SSE event is
  ~150 bytes — small enough that HAProxy holds it in its response
  buffer waiting for either a flush threshold or connection
  close. Compaction itself takes several seconds, during which
  nothing pushes the event through; by the time `compaction_end`
  arrives the buffer flushes both at once and the banner never
  has a chance to render. The 20-second heartbeat that prevents
  idle-timeout drops doesn't help — its 13-byte payload is too
  small to cross HAProxy's flush threshold on its own. Fix: emit
  a one-shot ~2KB SSE comment-line ("padding flush") immediately
  after every `compaction_start` write. The cumulative bytes
  exceed HAProxy's buffer-size threshold, forcing the router to
  release everything it's holding — including the
  compaction_start frame itself. EventSource ignores comment
  lines silently so the browser sees nothing visible; the line is
  tagged `: pad-flush ...` so an operator inspecting raw frames
  (`curl -N`, `tcpdump`) can identify it. Fires at most once per
  compaction, so the bandwidth cost is negligible. Local
  deployments without a buffering proxy in front of the server
  see no behavioral change either way.
- **Agent halts after overflow-driven auto-compaction (weaker
  models).** When the LLM rejects a request with a context-overflow
  error, the pi SDK auto-compacts and calls `agent.continue()` to
  resume the loop. The model then sees the structured compaction
  summary (`## Goal / ## Progress / ## Next Steps / ## Critical
  Context`) as the LAST message in context. Strong frontier models
  infer "I'm mid-task — pick up where I left off." Weaker / smaller
  local models (Gemma-class on vLLM in particular) read the
  structured summary as a status report addressed to them and
  respond with prose paraphrasing the "Next Steps" section instead
  of actually continuing the work — the agent stops making
  progress right when the user needs it to keep going. Fix: new
  in-process pi extension (`compactionContinuationExtension`)
  registered via `DefaultResourceLoader.extensionFactories`. It
  hooks the `context` event (fires before every LLM request) and,
  when the last message is a `compactionSummary`, appends a
  one-line imperative user message to the OUTBOUND copy only —
  "[continuation] Continue the task in progress — pick up from
  where you left off based on the summary above. Do not write a
  status update or summary of what you were doing; just proceed
  with the next action the task requires." Open-ended about what
  the next action is (tool call, final answer, follow-up question
  — whatever the task needs), focused on naming the observed
  failure mode (paraphrasing the summary). The nudge is sent to
  the LLM but NOT persisted to the session JSONL, so it doesn't
  leak into subsequent compactions, tree views, or session
  exports. Only fires when the last message is the summary
  (overflow-recovery path); threshold compactions don't auto-
  continue, so the user's next prompt naturally provides the
  imperative. No effect on strong models — the extra ~50 tokens of
  input is negligible and reinforces correct behavior.
- **Spurious "Reconnecting — server closed stream" banner after
  large tool results.** The SSE bridge's per-client outbound-
  buffer cap was set at 256KB to protect against truly wedged
  consumers, but that ceiling was tripping mid-session on
  legitimate slow consumers: a `tool_result` for an 11k-token
  tool output serializes to ~80–150KB on the wire, and the
  following stream of `message_update` token deltas pile more on
  top before the client drains. On a slow connection (mobile,
  ws-proxy that buffers, background tab), the threshold was
  reached and the bridge silently called `close()` — producing
  the misleading banner. Bumped the cap to 8MB (still bounds the
  wedged-tab case — a sustained 1MB/s of events fires within ~8s
  of zero consumption) and added a structured stderr log line
  (`sse-client-dropped-backpressure` with `sessionId` +
  `bufferedBytes`) so future occurrences are visible in
  `docker logs` instead of silent.
- **Context Inspector breakdown bar misattributing tool-call args
  and thinking content to "System + tools".** The categorizer's
  message walk was using stale Anthropic-wire block names
  (`type:"toolUse"`, `input` field; `type:"thinking"` reading `text`
  field) instead of the SDK's actual shape (`type:"toolCall"`,
  `arguments`; `type:"thinking"`, `thinking`). Result: the
  `toolCalls` and `thinking` buckets were always 0, and because
  `systemAndTools` is computed as a residual (`actualTotalTokens −
  messageTotal`), every byte those buckets should have held leaked
  into "System + tools" instead. End-effect: a tool-call turn made
  "System + tools" and "Tool results" appear to bump together,
  which looked like the SDK was double-counting the tool result —
  it wasn't. Fixed the categorizer plus two render-time sites
  (`extractPreview` and `renderExpanded`) that had the same
  wrong-name pattern, so tool calls now also show up in the
  inspector's one-line previews and the click-to-expand detail
  view rather than being silently invisible.

## [1.2.4] — 2026-05-22

### Added

- **Quick-action chips.** New left-aligned "Actions" dropdown in
  the chat-view toolbar. Two kinds, presence-discriminated:
  `command` chips run a shell snippet in the active project's
  folder via `/bin/sh -c` with scrubbed env (same posture as the
  integrated terminal — no pi-forge or provider secrets leak);
  `prompt` chips dispatch a templated prompt either auto-sent to
  the agent (`mode: "send"`) or prefilled into the composer
  (`mode: "insert"`). Command-chip output lands in an inline
  run card in the chat scroll with amber/green/red left border
  for running/success/fail, expandable stdout/stderr, and a
  "Use as context" button that pushes the captured output back
  into the composer. Stored globally in
  `${FORGE_DATA_DIR}/quick-actions.json`; CRUD via a new
  Settings → Quick Actions tab. Defense-in-depth MINIMAL_UI
  gate: server returns 403 on `/run` for command kind; menu hides
  command chips; settings disables the command radio with
  explanatory tooltip. Defaults: 30 s timeout per command (5 min
  cap), 1 MB per-stream output cap. (#144)
- **`ask_user_question` tool — browser-native implementation of
  the [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question)
  contract (MIT).** The agent can put up to 4 structured
  multi-choice questions to the user when its instructions are
  underspecified; instead of guessing, it gets back a structured
  envelope with the picks. Renders as an inline panel above the
  chat composer (not a modal — the chat scroll stays interactive
  while answering). Three layouts picked per-question: vertical
  list (single-select) with a "Type something" free-text fallback,
  checkbox list (multi-select), or side-by-side options + markdown
  preview (single-select with any `option.preview`). Multi-question
  forms are tabbed; "Chat about this" is the explicit escape
  hatch. Contract-identical to the plugin: same tool name, input
  schema (questions[1..4] with options[2..4], header ≤16 chars,
  label ≤60 chars, reserved sentinel labels), and response
  envelope (`{content:[{type:"text",text}], details:{answers,
  cancelled, error?}}` with answer kinds
  `option | custom | chat | multi`). Pending requests re-emit on
  SSE snapshot so a browser refresh resurfaces the panel without
  losing the agent's blocked state. Implementation is independent
  except for the prompt snippet + guidelines, which are ported
  verbatim with attribution. (#145)
- **`todo` tool — browser-native implementation of the
  [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
  contract (MIT).** The agent uses `todo` to plan and track
  multi-step work; the browser shows a checklist that updates
  live as tasks move through the 4-state machine
  (`pending → in_progress → completed`, plus `deleted` as a
  terminal tombstone). Contract-identical to the plugin: same
  action enum (`create | update | list | get | delete | clear`),
  same `blockedBy` model with cycle detection, same response
  envelope (`{content:[{type:"text",text}], details:{action,
  params, tasks, nextId, error?}}`). Persistence is by branch
  replay — every successful tool call writes the full state in
  `details.tasks/details.nextId`, which lands in the session
  JSONL; on resume/fork/compaction the server walks the branch
  and reads the latest todo result to rebuild state. No separate
  todo database; the message history is the source of truth.
  In-memory cache is just a fast path for read-heavy consumers
  (cache miss replays from the branch). UI: a `ListChecks`
  toggle icon in the chat-input top-right (visible only when the
  session has at least one task, with a `completed/total`
  progress badge) opens a bottom-strip panel inside the right
  pane that splits whatever tab is currently visible. Auto-opens
  the right pane on toggle. Implementation is independent except
  for the prompt snippet + tool description + guidelines, which
  are ported verbatim with attribution (the plugin author's
  wording is tuned against real model behavior). (#146)

### Changed

- **Widened the Settings modal.** Bumped from `max-w-4xl` (896px)
  / `max-h-[640px]` to `max-w-6xl` (1152px) / `max-h-[720px]`.
  The Quick Actions / MCP tabs render dense multi-column forms
  that wrapped awkwardly at the old size; settings is a modal so
  the extra width doesn't compete with the chat for screen real
  estate. (#146)
- **Collapsed consecutive `todo` tool cards in the chat.** A
  single planning turn often fires 5+ `todo create` calls
  back-to-back, each previously rendering as its own bordered
  card with redundant info (every todo result carries the full
  state — only the last one in a run is genuinely informative).
  Runs of adjacent todo toolCalls inside one assistant message
  now collapse into a single `TodoBatchCard`
  (`→ todo ×5 calls · 4 tasks after batch`, expand for
  per-call summaries). Single calls render unchanged. Cross-turn
  calls stay separate (each assistant message is its own
  bubble). (#146)

## [1.2.3] — 2026-05-20

### Added

- **Per-project system prompt addendum.** New Settings → System
  Prompt tab lets each project store a free-form text block that
  gets appended to the agent's base system prompt for every
  session created in that project. Append-only (pi's base prompt
  defines the tool-calling protocol; replacing it would break
  tool use) via pi's `appendSystemPrompt` extension hook. Stored
  per-project at `${FORGE_DATA_DIR}/system-prompt-overrides.json`
  (mode 0600, atomic write, 20 KB cap). Applies on the next
  session created in the project; running sessions keep the
  prompt they were built with. Cascade-deletes when the project
  is removed. (#129)
- **Stdio (subprocess) MCP servers.** Adds support for stdio MCP
  alongside the existing remote (HTTP/SSE) transports. Most
  official MCP servers (`server-filesystem`, `server-everything`,
  `server-memory`, `server-github`, etc.) are stdio-only; this
  closes that gap. Server kind is discriminated by which field is
  set — `url` ↦ remote, `command` ↦ stdio — matching the Claude
  Desktop / pi-mcp-adapter convention so existing `.mcp.json`
  files work unchanged. Env-passthrough preserves the MCP SDK's
  safe default: the subprocess sees `getDefaultEnvironment() ∪
  cfg.env`, never the pi-forge process env unless explicitly
  listed. Env values are secret-redacted on the GET path with
  the same `***REDACTED***` sentinel round-trip as remote
  headers. (#131)
- **Per-project stdio MCP trust gate.** Project-scoped stdio
  entries (declared in `<projectPath>/.mcp.json`) are gated
  behind a per-project trust decision stored at
  `${FORGE_DATA_DIR}/mcp-stdio-trust.json`. Until the operator
  grants trust via Settings → MCP, the entry sits in
  `trust_required` state and is not spawned. Global stdio entries
  (operator wrote those themselves) and remote project entries
  bypass the gate. Threat model: a hostile repo's `.mcp.json`
  shouldn't get free subprocess spawn on `git clone` + open.
  Trust persists per-project, indefinite; revoke from Settings
  at any time. (#131)

### Fixed

- **Thinking indicator now animates.** The chat "Thinking…"
  placeholder was a static italic string with no motion, leaving
  users wondering whether the SSE stream had silently dropped.
  Now renders three opacity-pulsed dots staggered 200 ms apart so
  the eye reads it as active. Honors `prefers-reduced-motion`;
  `aria-live="polite"` announces the state to screen readers.
  (#130)
- **Light-mode contrast pass across semantic-colored UI.** The
  existing `data-theme` scheme only remapped the neutral scale;
  semantic colors (red errors, sky subagent cards, blue links,
  amber warnings, emerald success, etc.) stayed as raw Tailwind
  palette values and collapsed into low-contrast washes on
  white. Adds a Tailwind `light:` custom-variant scoped to
  `[data-theme="light"]` and threads `light:` modifiers across
  every colored element: error banners + buttons, subagent
  cards + Open buttons, blue links, DiffBlock hunk-staging row,
  status badges (Skills / Prompts / Tools / Providers),
  compaction card, queue badges, search highlights, git
  changed-count badge, provider settings model list, terminal
  pane "New" button, role badges, and the raw-diff line classes.
  Also: `[data-theme="light"] .pi-diff-block { ... }` block
  re-declares the diff renderer's hardcoded dark colors (sticky
  gutter background, text color, add/delete tints, 8 syntax-
  token color families); ChatMarkdown code blocks swap Prism
  `vsDark` → `vsLight` based on the active theme; app logo at
  `/icons/icon.svg` is `filter: invert(1)`'d in light mode for a
  pure-black variant without shipping a parallel asset. (#130)

### Changed

- **Ignored `.claude/`** to keep Claude Code harness state out of
  version control (auto-created worktrees, transcripts, etc.).
  (#129)
- **Routine dependency updates.** Bumped `lucide-react`,
  `@types/node`, `typescript-eslint`, `@vitejs/plugin-react`,
  `@codemirror/legacy-modes`, `katex`, `protobufjs`, `tsx`,
  `ws`, and `vite` to their latest minor / patch versions.
  (#121–#128, #132, #133)

## [1.2.2] — 2026-05-11

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
