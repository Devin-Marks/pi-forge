# Security Policy

## Supported versions

Only the latest tagged release receives security fixes. No LTS branch.

## Threat model

pi-forge is **single-tenant** by design — one deploy, one user, one
workspace root. Assumptions:

- **Pi-forge trusts its own user.** No isolation between the user and
  the agent's filesystem / shell access; the agent runs with the
  process's full permissions.
- **The container is the unit of isolation.** Run pi-forge in Docker
  so the agent's `bash` tool can't damage anything outside the
  bind-mounted workspace.
- **No plain HTTP on a routable interface.** Terminate TLS at a
  reverse proxy and set `UI_PASSWORD` (or `API_KEY`) for any
  non-loopback deployment. `JWT_SECRET` auto-generates on first boot;
  set it explicitly only to override.
- **No cross-project isolation.** The project registry trusts every
  path the user adds; the agent can read / modify anything inside.

## What the project tries to defend against

- **Path traversal.** Every filesystem op goes through
  `packages/server/src/file-manager.ts`, which validates the resolved
  absolute path is inside the project root via a `realpath` walk and
  rejects with a 403.
- **Auth bypass.** Every route under `/api/v1/` (except the
  explicitly-public `/health`, `/auth/*`, `/ui-config`, and the
  `/terminal` WS handshake) goes through the global JWT / API-key
  check. New public routes must opt in via `config: { public: true }`.
- **Brute-force login.** Rate-limited per IP (10 / 60 s default,
  configurable via `RATE_LIMIT_LOGIN_*`). Behind a reverse proxy, set
  `TRUST_PROXY=true` so the limit sees real client IPs.
- **Token leaks via logs.** The terminal WS upgrade URL carries
  `?token=...` because browsers can't attach headers on WS connects.
  Pino's `req` serializer redacts `token=...` from query params before
  any log line is emitted.
- **Malicious uploads.** Path-validated like everything else, plus
  per-file (500 MB), aggregate (2 GB), and per-request file-count (16)
  caps, plus SHA-256 round-trip verification.
- **Prompt-injection via attached text files.** Inserted into prompts
  inside fenced code blocks with a fence longer than the longest
  backtick-run in the file — a hostile file can't escape the fence.
- **Host env-var leakage to the integrated terminal.** The terminal
  and the `!` exec route start from a small allowlist of harmless
  system vars (`PATH`, `HOME`, `USER`, `SHELL`, `TERM`, `LANG`,
  `LC_*`, `TZ`). Everything else — pi-forge secrets, provider keys
  (`*_API_KEY`), cloud credentials (`AWS_*`, `KUBECONFIG`, `GH_TOKEN`)
  — is dropped before spawn. Opt vars back in via
  `TERMINAL_PASSTHROUGH_ENV`. Allowlist lives in
  `pty-manager.ts#TERMINAL_ENV_ALLOWLIST`.

### Optional: agent secret-hygiene system-prompt nudge

The agent's autonomous `bash` tool **does** inherit pi-forge's process
env (deliberate — skills legitimately need `$GITHUB_TOKEN`,
`$AWS_*`, etc.). The failure mode: the model `printenv`'s while
debugging and dumps secrets into the transcript (which the user may
screen-share, log, or paste into a bug report).

Enable a system-prompt addendum that asks the model to treat env-var
values as credentials and reference them by name rather than
expanding them inline:

```
AGENT_SECRET_HYGIENE_RULE=true
```

Exact rule text in
`packages/server/src/agent-resource-loader.ts#FORGE_SECRET_HYGIENE_RULE`.
**This is a behavioral nudge, not a control** — the model can be
talked out of it by a determined user, a prompt injection in a tool
result, or its own reasoning. Pair with the rest of the threat model
(don't put sensitive env vars in `process.env` if the agent doesn't
need them; prefer `~/.pi/agent/auth.json` for provider keys — read
by the SDK before tool spawn, not inherited at spawn). Intentionally
not surfaced in `docker-compose.yml` so operators meet the rule and
its caveats together.

## Known technical limitations

- **Terminal can read pi config files.** The integrated terminal
  runs with pi-forge's filesystem access. The pi SDK needs to read
  `~/.pi/agent/auth.json`, so a shell running under the same UID can
  read it too — an authenticated user can `cat` provider API keys /
  OAuth tokens. Path-based blocking inside the shell is trivially
  bypassable (`cat $(echo ~)/...`, `python -c "open(...)"`, `dd
  if=...`) and would offer false confidence. The real mitigation is
  OS-level: run pi-forge and the shell as **separate UIDs** with
  `auth.json` mode 0600 owned by pi-forge's UID. Achievable in
  custom Docker setups; the stock image runs both as the same user.
  If your threat model includes "authenticated user must not be
  able to read provider credentials," prefer OAuth (re-auth costs
  less than key rotation) and rotate API keys when you suspect
  terminal access was abused.

## Explicitly out of scope

- **Trusted user running malicious commands.** The agent's `bash`
  tool is a real shell. Don't add a project containing secrets you
  don't want the agent to read.
- **Compromised LLM provider.** Pi-forge forwards prompts to the
  configured provider; malicious provider output is on the provider.
- **Mass user / cross-tenant attacks.** There is no multi-user model.

## Reporting a vulnerability

**Do not** open a public issue or PR for security vulnerabilities.

Use GitHub's private vulnerability reporting:

```
Repository → Security → Advisories → Report a vulnerability
```

If GitHub's advisory feature is unavailable, email the maintainer at the
address in `git log --format="%ae" | head -1` for the most recent commit.
Encrypt with the project's PGP key if one is published in the GitHub profile.

### What to include

1. A description of the vulnerability and its impact
2. Steps to reproduce (with a minimal proof-of-concept where possible)
3. The version / commit SHA you tested against
4. Whether the issue is currently public anywhere (Twitter, Stack Overflow,
   another bug tracker, etc.)

### Response window

Best-effort, not contractual SLAs. The maintainer aims for:

- **Acknowledge** within ~5 business days
- **Triage** within a couple of weeks
- **Fix + disclose**: Critical (RCE, auth bypass, container escape)
  prioritized for the next patched release with coordinated
  disclosure; High (path traversal, auth-required RCE, sensitive data
  exposure) at the next release window; Medium / Low in the next
  regular release.

CVEs may be requested via GitHub's advisory pipeline for Critical /
High issues at the maintainer's discretion. MIT-licensed software, no
warranty — see [LICENSE](./LICENSE) and the README's risks section.

## Out of scope

The following are not vulnerabilities and will be closed as such:

- Reports against unpatched dependencies where the dependency is reachable
  only through code paths we don't expose. (Supply-chain reviews welcome via
  PR; we keep `npm audit` clean for direct deps.)
- Self-XSS that requires the user to paste hostile content into a developer
  console.
- Anything that requires bypassing the deploy assumptions in the threat
  model (e.g., "RCE if you point the agent at /etc and tell it to delete
  files" is the agent doing what you told it to do).
- Reports about LLM provider behaviour (prompt-injection of the model
  itself, jailbreaks, etc.). Those belong with the provider.
