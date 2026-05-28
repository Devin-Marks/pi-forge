# Agent Notes: Pull Requests

Read this near the end of a session when preparing a PR description, handoff summary, or merge-ready change report.

## Pull Request Structure

When preparing or describing a PR, use a concise, review-friendly structure with
these sections in this order. Prefer concrete file paths, commands, and manual
verification steps over vague summaries.

### Summary

Explain the user-visible problem, why it happens, and what the PR does to fix it.
Include enough context for a reviewer who has not followed the discussion. If the
change is motivated by an error message, paste the relevant message in a fenced
code block. Call out scope boundaries such as "dev-server only" or "production
unaffected" when relevant.

### Usage

Show how an operator or developer should use the change. Use shell snippets for
commands, env vars, flags, or API calls. Document accepted values and important
trade-offs, especially security-sensitive shortcuts or compatibility behavior. If
there is no direct user-facing usage, say so briefly and explain how the behavior
is exercised.

### What changed

Start with a compact change count when useful, for example
`What changed (3 files, +75)`. Then list each changed file with a short bullet
that explains the meaningful implementation detail, not just "updated file".
Mention new helpers, route/schema changes, config wiring, docs, changelog entries,
and inline comments added to preserve future context.

### Test plan

Use a checkbox list. Include the strongest automated check that was run, usually
`npm run check` and, when behavior warrants it, `npm run test:ci` or the relevant
`npx tsx tests/test-*.ts` / `scripts/run-tests.sh --only ...` command. Add manual
verification steps for browser, proxy, terminal, auth, or other flows automated
tests do not cover. Leave unchecked items unchecked if they still need to happen
before merge, such as CI green or environment-specific manual validation.

Example outline:

~~~markdown
## Summary

<Problem, cause, and fix. Include exact error text when useful.>

## Usage

```bash
<commands or env vars showing how to use the change>
```

<Scope notes, defaults, and trade-offs.>

## What changed (N files, +X)

- `path/to/file.ts` — meaningful implementation detail
- `docs/example.md` — user-facing documentation added or updated
- `CHANGELOG.md` — `### Added` / `### Changed` entry under `## [Unreleased]`

## Test plan

- [x] `npm run check`
- [ ] Manual: <specific scenario and expected result>
- [ ] CI green before merge
~~~
