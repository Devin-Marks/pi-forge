# Contributing to pi-forge

Thanks for the interest. This document covers everything you need to send a
pull request that has a good chance of landing quickly.

## Quick start

```bash
git clone https://github.com/<your-fork>/pi-forge.git
cd pi-forge
npm install
npm rebuild node-pty # rebuild native PTY binding for your local Node/runtime
npm run dev          # server on :3000, client on :5173
```

The Vite dev server proxies `/api/*` to Fastify (including WebSocket upgrades
for the integrated terminal), so the client calls `/api/v1/...` directly with
no base-URL config. Environment variables are in
[`docs/configuration.md`](./docs/configuration.md); the Docker-compose path
is in [`docs/containers.md`](./docs/containers.md).

### Running dev:remote behind a proxy

`npm run dev:remote` exposes Vite on `0.0.0.0` so other devices on
your LAN can hit it directly by IP. Vite's anti-DNS-rebinding
allowlist permits `localhost` + LAN-IP requests by default, but
*blocks* requests whose `Host:` header is a hostname (e.g. a
reverse-proxied `dev.example.com`) with `Blocked request. This host
(...) is not allowed.`

Pass extra allowed hosts via `VITE_DEV_ALLOWED_HOSTS`:

```bash
# Specific hostnames (comma-separated, whitespace-tolerant):
VITE_DEV_ALLOWED_HOSTS=dev.example.com,staging.example.com npm run dev:remote

# Or disable the check entirely (dev convenience; accepts the
# DNS-rebinding risk — only use on trusted networks):
VITE_DEV_ALLOWED_HOSTS=all npm run dev:remote
```

Unset, the default Vite behaviour stays in effect. Production builds
are unaffected — this is dev-server only.

### Native module gotcha (node-pty)

The integrated terminal needs `node-pty`'s prebuilt binary to be
executable. The shipped npm-install postinstall (`bin/fix-pty-perms.mjs`)
handles this. If you hit `posix_spawnp failed.` after a manual install,
run `node bin/fix-pty-perms.mjs` from the repo root.

After `npm install`, run `npm rebuild node-pty` once to make sure the
native PTY binding is compiled for your local Node/runtime. You usually
only need to rerun it after deleting `node_modules`, changing Node
versions, or moving between OS/architecture/container environments.

The rebuild needs Python plus a C++ toolchain: Xcode CLT on macOS, or
`python3`, `make`, `gcc`, and `g++` / `build-essential` on Linux. The
Docker image avoids both issues — its build stage compiles node-pty
against the runtime Node automatically.

## Before you open a PR

```bash
npm run check        # tsc + eslint + prettier --check
npm run build        # full client + server build (catches Vite-only failures)
npm run test:ci      # full integration suite (~40s; same set CI runs)
```

All three must pass. CI re-runs `test:ci` on every PR; running it
locally first catches the failures faster.

For iteration during development, run a focused subset rather than
the full loop:

```bash
scripts/run-tests.sh --only auth,session     # one or comma-separated
scripts/run-tests.sh --skip docker           # everything except docker
```

The full test catalogue (one-line per script) lives in
[`CLAUDE.md`](./CLAUDE.md#test-script-catalogue). When you change
behaviour that an existing script tests, **update the script in the
same PR** — drift here is the single most common source of test
failures landing weeks later.

## Branch + commit conventions

- Branch off `main`. Name your branch with intent (`fix/session-fork-hijack`,
  `feat/context-inspector-search`).
- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
  `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, `ci:`. The
  history is full of examples — match the prevailing style.
- **Atomic commits** — one logical change per commit. The commit message
  explains the *why*, not just the *what*. Bug fixes should describe the
  root cause and the symptom users saw.
- No `Co-Authored-By` or AI-attribution lines. The repo's commit history is
  unsigned and human-attributed.

## Pull request checklist

The PR template walks you through this; the short version:

- [ ] `npm run check` and `npm run build` pass locally
- [ ] Relevant test script(s) pass (list which ones in the PR description)
- [ ] Public route changes ship with `schema.description` + JSON-Schema
      `body` / `response` so the OpenAPI spec at `/api/docs` stays accurate

## Architecture and conventions

[`CLAUDE.md`](./CLAUDE.md) is the canonical contributor reference —
repository layout, critical conventions (path validation, atomic
writes, single-source-of-truth modules, Zustand-only state, no
default exports, etc.), Pi SDK gotchas. Read it once before sending
a non-trivial PR; many recurring review comments are addressed there
already.

[`docs/architecture.md`](./docs/architecture.md) covers the *why*
behind the layout — request lifecycles, persistence model, threading.

## Reporting issues

- **Security vulnerabilities:** see [`SECURITY.md`](./SECURITY.md). Do NOT
  open a public issue.
- **Bugs:** GitHub Issues. Use the bug-report template; include the
  reproduction steps, expected behaviour, observed behaviour, and the
  output of `GET /api/v1/health` if relevant.
- **Feature requests:** GitHub Issues with the feature-request template.
  Linking to a real use-case helps prioritise.

## Code of conduct

By participating you agree to abide by the
[`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Contribution terms

No separate CLA. By opening a PR you represent that:

- **Original work.** It's yours (or otherwise rightfully submittable
  under MIT). No GPL/AGPL pasted into runtime files; no someone-else's
  proprietary code.
- **MIT licensed.** You license your contribution under the same MIT
  [LICENSE](./LICENSE) as the rest of the codebase; you retain
  copyright.
- **Patent grant.** To the extent you hold patent claims reading on
  your contribution, you grant a perpetual, worldwide, royalty-free
  license under those claims for downstream use. Mirrors Apache-2.0
  §3 — protects the project if a contributor later asserts a patent
  against their own code.
- **No warranty from you.** "As-is" — no support / indemnification
  obligation.

Trivial fixes (typos, formatting, comments) don't need to think about
this — submitting them is the representation. If your employer
claims rights in code you write, get their sign-off before opening
the PR.
