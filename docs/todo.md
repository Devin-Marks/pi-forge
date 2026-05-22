# todo

pi-forge ships a browser-native implementation of the `todo` tool: a
session-scoped task list the agent uses to plan and track multi-step
work. The agent calls `todo` with action `create / update / list /
get / delete / clear`; the browser shows a checklist that updates
live.

## UI

A small `ListChecks` icon appears in the top-right of the chat input
**only when the active session has at least one task** (so it's
gone the moment the list is cleared). The badge shows
`completed/total` so you have at-a-glance progress without clicking.

Clicking the icon opens a **bottom-strip panel** in the right pane.
The strip splits whatever right-pane tab is currently visible
(Files, Search, Changes, Git, or Context) — bottom-third gets
todos, top-two-thirds stays whatever you were looking at. A
horizontal divider lets you resize the strip; the height persists in
localStorage.

When the right pane is collapsed and you click the icon, the right
pane auto-opens so the panel has somewhere to land. Closing the
strip (X in its header, or re-clicking the icon) hides only the
strip; your right-pane tab is unaffected.

## Persistence

State persists via **branch replay** — exactly the model
[`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo)
uses. Every successful `todo` tool call returns the full state
(`details.tasks`, `details.nextId`) in its result envelope, which
gets recorded in the session JSONL. On session resume / fork /
compaction, pi-forge walks the branch and reads the latest todo
result to rebuild state. There is **no separate todo database** —
the message history is the source of truth.

The in-memory cache (`packages/server/src/todo/store.ts`) is a fast
path for read-heavy consumers (the UI panel, SSE snapshots);
cache-miss falls back to branch replay so a server restart can't
lie about state.

## Disabling the tool

The tool appears under **Settings → Tools → Built-in tools**.
Toggle it off there to filter `todo` out of every new session's
tool allowlist. Live sessions keep the tool list they were created
with.

## Relationship to `@juicesharp/rpiv-todo`

The wire contract — tool name (`todo`), action enum (`create |
update | list | get | delete | clear`), 4-state machine (`pending
→ in_progress → completed` plus `deleted` as a terminal
tombstone), `blockedBy` dependency model with cycle detection, and
response envelope (`{content:[{type:"text",text}], details:{action,
params, tasks, nextId, error?}}`) — is **contract-compatible**
with the upstream Pi extension (MIT). An agent prompt authored
against the plugin works against this implementation unchanged.

Implementation is independent. The reducer, validators, envelope
builder, replay logic, store, and React UI are pi-forge's own.
Prompt snippet, tool description, and guidelines are
**ported verbatim with attribution** in
`packages/server/src/todo/prompt-strings.ts` — the plugin author's
wording has been tuned against real model behavior (rules like
"exactly one task in_progress at a time" and "never mark completed
if tests are failing"), and matching it avoids regressions in
tool-call quality.
