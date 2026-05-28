# Agent Notes: Testing

Read this before adding tests, changing product behavior with server-visible contracts, updating route response shapes, changing on-disk formats, or deciding which validation command to run.

## Testing Approach

No JS test framework. Each script under `tests/` is a standalone tsx file
that boots its own server in-process (or imports the registry directly), drives
it via fetch / WebSocket, prints PASS/FAIL per assertion, and exits 0 if all
pass or 1 on any failure. Each script is self-contained — `mkdtemp`s its own
WORKSPACE_PATH / PI_CONFIG_DIR / FORGE_DATA_DIR, runs, and cleans up.

### Running tests

Use the runner — never enumerate scripts by hand. The single most common
mistake on this codebase has been "I touched X so I'll only run test-X" while
neighboring tests silently rotted. The runner exists to make "run them all"
the path of least resistance.

```bash
npm run test:ci                      # CI loop (skips test-docker)
npm run test                         # Local loop (no CI skip list)
scripts/run-tests.sh --only session  # Single or comma-separated subset
scripts/run-tests.sh --skip docker,attachments
PI_TEST_LIVE_PROMPT=1 npm run test   # Enables optional live-LLM branches
                                     # in test-session/sse/api (needs a
                                     # configured pi provider)
```

The runner stops on the first failure (downstream tests sharing global state
just produce noise once an upstream broke), prints per-test wall time, and
finishes with a PASS/FAIL summary. Run it locally before opening a PR — CI
runs `npm run test:ci` on every PR via `.github/workflows/ci.yml`.

### What runs in CI vs not

CI (ubuntu-latest, free runner): every `tests/test-*.ts` except those in the
runner's `CI_SKIP` list. Currently that's just **test-docker**, which builds
the production image (2-5 min cold) and is brutal as a per-PR gate; run it
locally before tagging a release.

LLM-gated branches: a few scripts have an optional "send a real prompt to the
agent" tail conditioned on `PI_TEST_LIVE_PROMPT === "1"`. These never run in
CI (the env var isn't set) and require a configured pi provider to run
locally. The non-LLM portions of those scripts always run.

### When you change product behavior, update the test in the same PR

The recurring failure mode on this codebase has been: refine a route's error
codes / change an on-disk format / harden a default, then merge without
touching the integration test. The test's stale assertion goes unnoticed
because no one is iterating the test directory. Months later someone runs the
suite and finds 6 broken tests with no obvious bisect signal.

The fix is procedural: when you change a server-visible contract — error
codes, response shapes, on-disk file format, default behavior — find the
integration test that exercises it (`grep -l <code-or-shape> tests/`) and
update it in the same PR. The runner makes verifying easy: `npm run test:ci`
should be green at PR-merge time, every time.

### Gotchas to know about before writing a new test

- **Project paths are realpath'd on creation.** `project-manager.createProject`
  resolves the input path through `realpath` before storing, so symlinks
  can't bypass the workspace boundary. On macOS that turns the test's
  `mkdtemp(...)` path (`/var/folders/...`) into the canonical form
  (`/private/var/folders/...`). Tests that send file ops with the un-realpath'd
  path get rejected by file-manager as "outside the project root." Capture the
  canonical path from the create response and use it for HTTP requests
  (`tests/test-files.ts` shows the pattern). Setup ops via Node fs against
  the un-realpath'd path are fine — only HTTP-bound paths matter.
- **`disposeSession` is async.** It awaits an in-flight LLM-call abort with
  a 5 s ceiling before tearing down. Always `await` it, or downstream
  assertions race the dispose. Dispose-then-immediate-resume on the same id
  hits a 1.5 s tombstone (`TOMBSTONE_MS`) — sleep through it.
- **Initial-login JWTs are scoped.** With `REQUIRE_PASSWORD_CHANGE=true`
  (default), the JWT issued by `/auth/login` is restricted to
  `POST /auth/change-password`. Tests that just want a "valid JWT passes
  auth" assertion should set `REQUIRE_PASSWORD_CHANGE=false` in the spawned
  server's env.
- **Skills overrides use pattern syntax.** `settings.skills` is a list of
  `!name` (exclude) / `+name` (force-include) patterns, NOT bare names.
  Skills are enabled by default; absence of `!name` is the signal.

### Adding a new test script

Drop a `tests/test-<feature>.ts` that:
1. `mkdtemp`s its own dirs and sets WORKSPACE_PATH / PI_CONFIG_DIR /
   FORGE_DATA_DIR / SESSION_DIR before importing `dist/index.js`.
2. Boots the server via `buildServer()` from the compiled module (or spawns
   a child process — see `tests/test-terminal.ts` for the spawn pattern when
   the test needs env that's read at module load).
3. Prints `PASS`/`FAIL` per assertion using the `assert(label, ok, detail?)`
   helper local to each script. Exits 1 if `failures > 0`.
4. Cleans up its temp dirs in a `try/finally`.

The runner picks up the new file automatically — no registration needed.

### Test-script catalogue

Every script's filename matches the area it covers. Skim the doc-comment at
the top for what each verifies; the runner output prints them in order.

```
test-api                  REST surface + OpenAPI spec
test-attachments          multipart prompt uploads + size/type guards
test-auth                 password / API-key / JWT flows + persisted-hash regression
test-cli-flags            argv → env-write parser (parseCliArgs round-trip)
test-config               models.json / auth.json / settings.json / skills overrides
test-config-export        backup tar.gz export + import (atomic, partial-failure)
test-diff                 per-turn diff aggregation
test-diff-parser          unified-diff hunk parser
test-docker               full Docker image build + smoke (CI-skipped)
test-files                file browser + write/read/move/delete + path safety
test-folder-references    `@<dir>/` chat references — preserved for the model to ls/grep
test-fork                 session.fork + tree navigation
test-git                  git wrapper (status, diff, stage, commit, push)
test-mcp                  MCP server registry + customTools wiring
test-mcp-truncation       MCP tool-output truncation behavior
test-projects             project CRUD + workspace boundary enforcement
test-prompts              pi prompt-template discovery + per-project overrides
test-pty-reattach         terminal WS reattach across drops
test-publish-package      published-package shape (publish/ dir + bin shim end-to-end)
test-scaffold             baseline server boots + health + auth gate
test-search               file content search via ripgrep
test-session              AgentSession registry + dispose / resume / fork
test-sse                  SSE event stream + snapshot-on-connect
test-subagent-discovery   pi-subagents child-JSONL discovery
test-subagent-parser      pi-subagents tool-result parsing for the rich card
test-terminal             PTY WebSocket + idle-reap
test-tool-overrides       per-project tool enable/disable + cascade
```
