# process tool

pi-forge ships a browser-native implementation of the `process`
tool: a session-scoped manager for background processes the agent
spawns (dev servers, test watchers, builds, log tails). Separate
from `bash` — that tool is for one-shot synchronous commands; the
`process` tool is for things that should keep running while the
conversation continues.

## Actions

| Action | Required | Notes |
|---|---|---|
| `start` | `name`, `command` | Spawns under `/bin/sh -c` with a scrubbed env (same posture as the integrated terminal — no pi-forge or provider secrets leak). Returns the process id. |
| `list` | — | Returns every process for the session, newest-first. |
| `output` | `id` | Recent in-memory tail of stdout/stderr (~200 lines). For the full history, use `logs` to get the file paths and read them. |
| `logs` | `id` | Absolute paths to the on-disk log files. Agents can read them with the `read` tool; the UI streams them via `GET /logs/file`. |
| `kill` | `id` | SIGTERM → 5 s grace → SIGKILL. Returns once the signal is sent; the lifecycle event fans out async on actual exit. |
| `clear` | — | Drop FINISHED processes from the list. Live ones stay. |
| `write` | `id`, `input`, optional `end` | Pipe data to stdin. `end: true` closes the stream (for programs reading until EOF). |

## Notifications

Per-`start` flags control whether the agent gets a turn to react
on lifecycle events:

- `alertOnSuccess` (default: `false`) — records an informational clean-exit card, but does not wake the agent
- `alertOnFailure` (default: `true`) — fires on crash / non-zero exit
- `alertOnKill` (default: `false`) — fires only on external signal; killing via the tool never triggers a turn

When one of these enabled lifecycle alerts fires, pi-forge appends a
`process-notify` status card. Clean success is informational and does
not wake the agent; failure and external-kill alerts start/steer an
agent turn because they usually require intervention.

`logWatches` adds runtime regex matchers per process. On match, the
manager emits a watch event the UI surfaces as an alert badge and a
`process-watch` status card that starts/steers an agent turn.
`stream: "stdout" | "stderr" | "both"`; `repeat: false` is the
default (single-fire) — set `true` for repeat alerts.

## UI

| Surface | Behavior |
|---|---|
| **Right-pane "Processes" tab** | Always present. Running on top, finished below. Per-row: status icon + name + truncated command + duration. Click to expand → stdout/stderr tails + Kill button + links to the full log files. |
| **Chat-input badge** | Small `Activity` icon in the top-right of the chat composer, visible only when the active session has ≥1 running process. Click → auto-opens the right pane (if collapsed) and switches the tab to Processes. |
| **Tab badge** | Numeric count of running processes on the Processes tab itself. |
| **Watch alerts** | A small amber header in the panel lists the latest match events. Click the rotate icon to dismiss. |

## Persistence

**In-memory only.** A server restart drops every process record;
the OS may leak the actual children if pi-forge crashes mid-
lifecycle (same posture as the upstream plugin). The panel footer
says so explicitly: *"In-memory only — processes don't survive a
server restart."*

Log files DO persist on disk at
`${FORGE_DATA_DIR}/processes/<sessionId>/<processId>/{stdout,stderr}.log`
(rotated at 10 MB → `.1`), and are cleaned up when the session is
disposed.

## Session lifecycle

When a session is disposed (`disposeSession` in
`session-registry.ts`):
1. Every live process for the session gets SIGTERM
2. Brief grace window
3. Any survivors get SIGKILL
4. The session's log directory is `rm -rf`'d
5. The manager's in-memory map drops the session entry

## MINIMAL_UI

`process.start` returns an error envelope under `MINIMAL_UI=1` —
spawning new processes is a trust surface peer to bash. Listing /
killing / clearing existing processes remains usable so an
operator who toggles `MINIMAL_UI` on can still see and stop
whatever was already running.

## Disabling the tool

The tool appears under **Settings → Tools → Built-in tools**.
Toggle it off there to filter `process` out of every new session's
tool allowlist. Live sessions keep the tool list they were created
with.

## Relationship to `@aliou/pi-processes`

The wire contract — tool name (`process`), action enum, per-
process `ProcessInfo` shape, status state machine (`running |
terminating | terminate_timeout | exited | killed`), `LogWatch`
shape with `pattern/stream/repeat`, and `ProcessesDetails`
response envelope — is **contract-compatible with
[`@aliou/pi-processes`](https://github.com/aliou/pi-processes)**
(MIT). An agent prompt authored against the plugin works against
this implementation unchanged.

Implementation is independent. The reducer, lifecycle, signal
handling, log capture, regex watches, SSE bridge, REST routes,
and React UI are all pi-forge's own. The prompt snippet + tool
description + guidelines are **ported verbatim with attribution**
in `packages/server/src/processes/prompt-strings.ts` — wording
like "avoid shell background patterns such as `&`, `nohup`,
`disown`, or `setsid` when the process tool fits" steers the
model toward the right primitive; rederiving it risks worse
tool-invocation patterns.
