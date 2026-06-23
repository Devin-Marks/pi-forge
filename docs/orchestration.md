# Session orchestration

A session can act as a **supervisor** that spawns, observes,
messages, interrupts, and kills other sessions in the same project.
The instance-level surface is enabled by default (unless disabled by
operator config or `MINIMAL_UI`); each session that should run as a
supervisor still opts in separately from the chat-view toolbar.

> Different from **pi-subagents.** Subagents are LLM-internal child
> agents scoped to one tool call within a single session. Orchestrated
> workers are full first-class sessions — they show up in the session
> picker, have their own transcripts, can be opened directly in the
> browser, and survive after the supervisor ends.

## Why turn it on

Two concrete workflows the feature is built for:

- **Supervisor watching peers.** A lead session breaks down a goal,
  spawns one worker per discrete task, watches the worker inbox for
  turn-ends and ask-user-question requests, and coordinates the
  overall progress. Useful when work decomposes cleanly into
  parallel chunks (audit N files, test N components, port N
  modules).
- **Handoff pipeline.** Session A finishes its piece of work,
  spawns session B with a `contextSummary` of what it learned, and
  detaches. Useful when work is sequential but the context window
  pressure on a single session would force premature compaction.

## Topology

Strict **hub-and-spoke at depth=1.**

- The supervisor is the hub. Every worker reports to it via the
  inbox; workers do not see each other.
- A worker cannot become a supervisor (depth is capped at 1). This
  is enforced at `enableSupervisor()` and at `registerWorker()` —
  the store rejects with `depth_limit_exceeded` if you try.
- Hub-and-spoke is enforced **by the tool surface**, not by a
  permission check: workers literally don't get the
  `orchestrate_*` tools, so there's no API for them to express
  worker→worker comms. There's nothing to enforce because there's
  nothing to express.
- **Same-project only** in v1. Cross-project orchestration is
  intentionally out of scope — it would complicate the data model
  for a use case the design hasn't seen yet.

## Availability — default-on, per-session opt-in

### 1. Instance disable switch (operator)

Session orchestration is available by default. To remove the instance-level
surface entirely, set:

```bash
ORCHESTRATION_DISABLED=true
```

Or in `docker/.env`:

```
ORCHESTRATION_DISABLED=true
```

For backward compatibility, `ORCHESTRATION_ENABLED=false` also disables
orchestration. `ORCHESTRATION_ENABLED=true` is no longer required; it is the
default behavior. Availability makes the chat-view `Orch` toggle render. It
does NOT enable supervisor mode for any session — that's the second gate.

**Hard-disabled under `MINIMAL_UI=true`** regardless of these flags.
MINIMAL_UI deployments are locked-down by design; orchestration
opens a tool surface the operator probably doesn't want end users
touching.

### 2. Per-session toggle (user)

Open a session, click the `Orch` button in the chat-view toolbar,
click **Enable supervisor mode**. The server rebuilds the live
AgentSession in-place (same SessionManager, fresh `customTools`,
SSE clients stay attached) so the `orchestrate_*` tools become
available immediately — no reload, no reconnect.

Disable the same way to drop the tools. Disabling also detaches
every linked worker (they survive as standalone sessions) and
clears the supervisor's inbox.

## Tool surface

The supervisor's agent gets eight new tools (all prefixed
`orchestrate_`):

| Tool | Purpose |
|---|---|
| `orchestrate_spawn_worker` | Create a new worker session with a task. `name` is required so the picker stays legible; optional `contextSummary` prepends handoff context to the initial prompt. |
| `orchestrate_list_workers` | Current state per worker (streaming / idle / cold) with message counts and last-activity timestamps. |
| `orchestrate_read_worker` | Fetch the worker's most recent messages, rendered as a readable transcript. Default `limit` is **1** (latest message only) — bump only when one-message context isn't enough. |
| `orchestrate_send_to_worker` | Inject a message into the worker's prompt stream. `mode` chooses between `prompt` (default, new turn or queue), `steer` (interrupt current turn — for course-correction), `followUp` (queue until idle — for next-task assignment). |
| `orchestrate_interrupt_worker` | Abort the worker's current turn. Session stays live. |
| `orchestrate_kill_worker` | Dispose the worker session. Optional `deleteOnDisk: true` also removes the `.jsonl`. |
| `orchestrate_detach_worker` | Drop the supervisor↔worker link; the worker continues as a standalone session. |
| `orchestrate_read_inbox` | Drain pending worker events (turn-ends, ask-user-question requests, retry failures, process alerts, deletions). Items return oldest-first and get marked delivered. |

Workers do NOT get these tools — that's the topology enforcement.

### Why prompts to workers should read as task briefs

The `initialPrompt` and `send_to_worker.message` parameters are
described to the supervisor LLM as **tasks, not conversation**.
Workers are autonomous agents with no shared transcript or memory
— "can you help me look at the auth stuff" gives the worker
nothing to act on. "Audit `packages/server/src/auth.ts` for the
JWT verification path; report yes/no on whether expired tokens are
rejected" is a usable brief.

## Worker → supervisor wake-up

Worker events route into a per-supervisor inbox queue. Five event
types:

| Event | Source |
|---|---|
| `worker.ended` | Worker's AgentSession emitted `agent_end` |
| `worker.ask_user` | Worker called `ask_user_question` |
| `worker.auto_retry_failed` | Worker's SDK auto-retry exhausted on a provider error |
| `worker.process_alert` | Not enqueued for worker process alerts; process success/failure/kill notifications stay in the worker session and do not wake the supervisor |
| `worker.deleted` | Worker's session was deleted externally (cold or live); kills initiated through orchestration tools/UI controls update worker state but do not notify the supervisor about its own action. |

When an event lands, the bridge enqueues it AND tries to wake the
supervisor with a small `[orchestration] N pending events…` prompt.
The wake-up only fires when:

1. The supervisor session is live (in the in-memory registry), AND
2. The supervisor is **idle** (not currently mid-turn), AND
3. There isn't already an in-flight wake-up for the current idle
   window (per-supervisor dedupe flag).

Orchestration-initiated kills are filtered before they reach the inbox, so the supervisor is not woken for its own worker-deletion tool/UI action.

If the supervisor is mid-turn, the items wait on the queue.
Recovery fires another wake-up when the supervisor's own
`agent_end` lands — closing the "supervisor finished a turn
without calling `orchestrate_read_inbox`" gap.

The supervisor's LLM is expected to call `orchestrate_read_inbox`
to drain the queue, then `orchestrate_read_worker` /
`orchestrate_send_to_worker` to act on individual workers.

## Safety

- **Fanout cap.** Each supervisor can have at most
  `ORCHESTRATION_MAX_WORKERS_PER_SUPERVISOR` (default 8) **live**
  workers at a time. Killed / cold workers don't count. Bounded
  to `[1, 100]` so a typo in env doesn't disable the limit.
- **Ownership guard.** Every tool that names a `workerId` verifies
  the worker is linked to *this* supervisor before acting. A
  confused supervisor LLM can't reach into another supervisor's
  workers by id-guessing — the worker store is the source of truth.
- **Depth cap.** Workers cannot themselves become supervisors. No
  fork-bombs from a buggy prompt loop.
- **Same-project guard.** `spawn_worker` always spawns into the
  supervisor's project; the parameter for cross-project doesn't
  exist in the tool schema.
- **Audit trail.** Every orchestration tool call and inbox event
  writes a JSON-line entry to `process.stderr`
  (`orchestration-inbox-enqueued`, `orchestration-wake-delivered`,
  `orchestration-wake-failed`, etc.). No separate audit UI by
  design — operators tail container logs.

## Storage

Two files in `${FORGE_DATA_DIR}`:

| File | Purpose | Mode |
|---|---|---|
| `session-orchestration.json` | Supervisor opt-in flags + supervisor↔worker links | `0600` |
| `orchestrator-inbox.json` | Per-supervisor pending event queue (FIFO-capped at 200 / supervisor) | `0600` |

Same atomic-write + in-process-lock pattern as
[`webhooks.md`](./webhooks.md). The inbox file can carry assistant-
message previews — anything the worker's agent has been talking
about — so it gets the secret-grade `0600` even though it has no
literal secrets.

## REST surface

The agent-facing tools above are mirrored as REST endpoints the UI
calls. All are gated by the instance disable switch and the
MINIMAL_UI hard gate — they return `403 orchestration_disabled` or
`403 minimal_ui_disabled` when off.

| Method + path | Purpose |
|---|---|
| `GET /api/v1/orchestration/config` | Instance availability + caps. Used by the UI to decide whether to render the toggle. |
| `GET /api/v1/orchestration/sessions/:id` | Role of a session (`supervisor` / `worker` / `standalone`) + linkage. |
| `POST /api/v1/orchestration/sessions/:id/enable` | Make the session a supervisor; rebuild the live AgentSession in place. |
| `POST /api/v1/orchestration/sessions/:id/disable` | Drop supervisor mode; detach workers; clear inbox; rebuild. |
| `GET /api/v1/orchestration/sessions/:id/workers` | Live worker list for a supervisor (drives the Workers panel). |
| `GET /api/v1/orchestration/sessions/:id/inbox` | Full inbox history (delivered + pending), newest first. |
| `POST /api/v1/orchestration/sessions/:id/inbox/clear` | Wipe inbox. |
| `POST /api/v1/orchestration/sessions/:id/workers/:wid/detach` | UI detach. |
| `POST /api/v1/orchestration/sessions/:id/workers/:wid/kill` | UI kill (transcript stays on disk; use `DELETE /sessions/:id` to remove it). |
| `POST /api/v1/orchestration/sessions/:id/workers/:wid/resume` | Force-resume a cold worker into the registry. |

Full schemas: open `/api/docs` in your deploy.

## UI surface

- **Toolbar `Orch` button** — renders when orchestration is available
  for the instance. Toggles the per-session Orchestration panel.
- **Orchestration panel** (collapsible, mounted between the chat
  toolbar and the message list):
  - **Standalone** session → "Enable supervisor mode" button.
  - **Supervisor** session → workers list with state pills
    (streaming / idle / cold), per-worker Resume / Detach / Kill
    buttons, pending-inbox badge, expandable inbox history with
    type-coded labels, "Disable supervisor mode" button, "Clear
    inbox" button.
  - **Worker** session → back-link to the supervisor (click to
    jump), handoff badge if spawned from a `contextSummary`.
- The panel polls `/orchestration/sessions/:id/workers` and
  `/inbox` every 4s while open so the live state stays fresh.

## Troubleshooting

**`Orch` button isn't visible.** Either `ORCHESTRATION_DISABLED=true`
(or legacy `ORCHESTRATION_ENABLED=false`) is set, or `MINIMAL_UI=true`
is overriding it. Check `GET /api/v1/orchestration/config` —
`disabledReason` tells you which gate is closed.

**Enabling supervisor mode succeeded but `orchestrate_*` tools
aren't visible to the agent.** The route rebuilds the live
AgentSession in place, but only for sessions that are currently
live in the registry. A cold session needs to be opened (SSE
attach) first; opening it triggers `resumeSession`, which picks
up the supervisor flag and includes the tools in `customTools`.

**Supervisor doesn't react to worker activity.** Two failure
modes to distinguish:

1. The supervisor LLM isn't calling `orchestrate_read_inbox`. The
   inbox file is being written to; check
   `${FORGE_DATA_DIR}/orchestrator-inbox.json` and look for
   `delivered: false` items. The wake-up prompt may have been
   ignored — strengthen the supervisor's system prompt or
   instruct it explicitly.
2. The wake-up isn't firing. Look for
   `orchestration-wake-delivered` / `orchestration-wake-failed`
   lines in stderr. A "failed" line usually means the supervisor
   session has no model configured — supervisors need provider
   credentials just like any other session.

**`fanout_limit_exceeded` errors.** Spawn was rejected because the
supervisor already has the max live workers. Either kill some
(`orchestrate_kill_worker`), detach the ones you no longer care
about (`orchestrate_detach_worker`), or raise
`ORCHESTRATION_MAX_WORKERS_PER_SUPERVISOR`.

**`depth_limit_exceeded`.** A worker is trying to become a
supervisor. v1 disallows this by design — depth is capped at 1.

## See also

- [`webhooks.md`](./webhooks.md) — the other "tell something about
  agent events" surface. Webhooks fan out OVER HTTPS to external
  systems; orchestration fans IN to a supervisor session.
- [`processes.md`](./processes.md) — workers can spawn background
  processes the same way standalone sessions can; process alerts stay
  local to the worker session and do not wake the supervisor.
- [`ask-user-question.md`](./ask-user-question.md) — when a worker
  calls this tool, the supervisor sees a `worker.ask_user` inbox
  item and can answer via `orchestrate_send_to_worker`.
- [`CLAUDE.md`](../CLAUDE.md) — file-by-file map of the
  `packages/server/src/orchestration/` module.
