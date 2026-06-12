# Quick actions

Operator-defined chips on the chat-view toolbar that either run a
shell command in the active project's cwd OR insert/send a
templated prompt to the active session. Configure from
**Settings → Quick Actions**.

## Two kinds

Each action is one or the other — never both:

| Kind | Discriminator | What happens when clicked |
|---|---|---|
| **Command** | `command` is set | pi-forge runs the command in the active project's working directory and renders the result as a `QuickActionRunCard` in the chat. |
| **Prompt** | `text` is set | The templated prompt either **sends** to the active session (`mode: "send"`) or **inserts** into the composer (`mode: "insert"`) for you to edit before sending. |

Why the split: commands are about "I want to see the output of
`npm run build` right now" — fast, one-shot, no LLM round trip.
Prompts are about "I want to say the same thing to the agent
every time without retyping it" — `Refactor this for clarity`,
`Add tests for this module`, etc.

## Storage

`${FORGE_DATA_DIR}/quick-actions.json` (mode `0600`). Atomic-write
+ in-process lock pattern, same as the other forge-owned
JSON files. Single flat array — chips are the operator's
personal toolbox, global by design rather than per-project.

```json
[
  {
    "id": "build",
    "name": "Build",
    "command": "npm run build",
    "timeoutMs": 60000,
    "enabled": true
  },
  {
    "id": "refactor",
    "name": "Refactor for clarity",
    "text": "Refactor the file I'm currently looking at for clarity. Keep behavior identical.",
    "mode": "insert",
    "enabled": true
  }
]
```

## Field reference

| Field | Required | Notes |
|---|---|---|
| `id` | yes | UUID generated at create time; stable across renames. |
| `name` | yes | Label shown on the chip. |
| `enabled` | optional | Defaults to `true`. Disabled actions stay in the registry but don't render the chip. |
| `command` | one-of | Shell command string. Required when this is a command action. Capped at 8 KB. |
| `timeoutMs` | optional (command-only) | Per-run timeout. Default 30 s, ceiling 5 min. |
| `text` | one-of | Prompt template. Required when this is a prompt action. Capped at 32 KB. |
| `mode` | optional (prompt-only) | `send` (default for prompts created via UI) or `insert`. |

The store rejects entries with **both** `command` and `text`, or
**neither** — that's the discriminator integrity check.

## Command execution

- Spawned via `child_process.spawn` with `shell: false` and
  `["bash", "-lc", command]` as argv, so shell built-ins (pipes,
  redirects, `&&`) work.
- **cwd is the active project's path.** The chip is project-scoped
  at runtime even though chip definitions are global.
- **Env is scrubbed** through the same allowlist as the integrated
  terminal (`pty-manager.ts#scrubbedEnv`). Provider API keys from
  the pi-forge process env do **not** leak into chip-spawned
  commands by default. Add specific passthrough vars via
  `TERMINAL_PASSTHROUGH_ENV` (e.g.,
  `TERMINAL_PASSTHROUGH_ENV=KUBECONFIG,EDITOR`).
- **Output is captured both streams**, truncated at 1 MB per
  stream (re-run in the integrated terminal if you need the full
  output). Truncation surfaces as `truncated: true` on the result.
- **Disabled under `MINIMAL_UI=true`.** Command runs return 403
  `minimal_ui_disabled`. The Quick Actions Settings tab itself is
  hidden; chips don't render in the chat toolbar.

## Prompt actions

- The template text is delivered as a user-role message to the
  active session — exactly as if the user had typed it.
- `mode: "send"` posts straight to
  `POST /api/v1/sessions/:id/prompt`.
- `mode: "insert"` writes the text into the chat composer; the
  user can edit before pressing send.
- Templates are static for v1 — no variable interpolation. If you
  need per-call dynamism, use `mode: "insert"` and edit at run
  time.
- **Available under `MINIMAL_UI=true`**: prompts don't open a
  shell, they just deliver text to the agent. Same gate as the
  rest of the chat surface.

## REST surface

| Method + path | Purpose |
|---|---|
| `GET /api/v1/quick-actions` | List configured actions (any project context). |
| `POST /api/v1/quick-actions` | Create. Validates the one-of discriminator + byte caps. |
| `PUT /api/v1/quick-actions/:id` | Update. Switching kind (command → prompt or vice-versa) drops the now-unused fields. |
| `DELETE /api/v1/quick-actions/:id` | Remove. |
| `POST /api/v1/quick-actions/:id/run?projectId=…` | Run a command action against the given project's cwd. Returns `{ success, exitCode, stdout, stderr, durationMs, timedOut, truncated }`. Returns 403 `minimal_ui_disabled` if MINIMAL_UI is on. |

Prompt-mode actions don't have a server-side `run` route — the
client just posts to the session's `/prompt` endpoint. Full
schemas at `/api/docs`.

## UI surface

- **Settings → Quick Actions.** Hidden under MINIMAL_UI.
  Add/edit/delete chips, reorder is by creation order (not yet
  draggable in v1).
- **Chat toolbar `QuickActionsMenu`.** Renders the enabled chips
  for the active project. Click → run (command) or send/insert
  (prompt). Hidden under MINIMAL_UI.
- **`QuickActionRunCard`.** Inline card in the chat surface that
  renders a completed command run — stdout, stderr, exit code,
  duration, truncation indicator. Lives in the chat transcript so
  the agent can see what ran (and reference it in subsequent
  turns).

## Troubleshooting

**Command returns immediately with `exitCode: -1` and
`stderr: "spawn …"`**: the binary isn't on the agent process's
PATH. Pi-forge launches commands with the same PATH as the
parent process; for chips that need `gh`, `kubectl`, etc.,
ensure they're installed in the container (the shipped image
already has `git`, `gh`, `tea`, `ripgrep`, `bash`, `curl`, `less`,
`procps`).

**Chip ran successfully but the output looks cut off.** Stream
output caps at 1 MB per stream; `truncated: true` on the result
means there was more. Re-run in the integrated terminal for the
full output, or pipe through `head` / `tail` in the command
itself.

**Chip secrets aren't available.** That's the scrubbed-env
behaviour — see `TERMINAL_PASSTHROUGH_ENV` in
[`configuration.md`](./configuration.md#environment-variables).
Add specific var names to the passthrough allowlist.

**Quick Actions tab missing under MINIMAL_UI.** Intentional. The
chip surface lets the operator embed arbitrary shell commands;
under MINIMAL_UI the deployment is locked down and end users
shouldn't be configuring those. Edit
`${FORGE_DATA_DIR}/quick-actions.json` directly and restart.

## See also

- [`configuration.md`](./configuration.md) — `FORGE_DATA_DIR`
  layout, `TERMINAL_PASSTHROUGH_ENV` allowlist.
- [`processes.md`](./processes.md) — the chip-vs-process
  distinction. Chips are one-shot synchronous; the `process`
  tool is for long-running background processes the agent
  manages.
