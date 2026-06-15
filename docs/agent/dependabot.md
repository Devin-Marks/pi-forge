# Agent Notes: Dependabot Review

Read this when reviewing, triaging, sweeping, or batching Dependabot pull
requests for pi-forge.

## Purpose

Dependabot review is a safety check for this codebase, not a generic dependency
upgrade summary. Decide whether each update is safe for how pi-forge actually
uses the dependency, then present merge or hold recommendations in batches that
are easy for the user to act on.

For every PR, check:

- Breaking changes and migration notes for the exact version range being bumped.
- Direct pi-forge usage of the dependency, including imports, CLI calls, config,
  lockfile peers, build plugins, and runtime assumptions.
- CI, build, test, release, Docker, and dev-server implications.
- Published npm metadata for package updates, especially scripts and dependency
  shape:

  ```sh
  npm view <pkg>@<version> scripts dependencies optionalDependencies peerDependencies dist.integrity dist.tarball
  ```

- `preinstall`, `install`, `postinstall`, `prepare`, and other package lifecycle
  script changes. Treat new or changed install-time code as security-sensitive:
  inspect the published package metadata/diff where possible, call it out in the
  verdict, and do not recommend merge if the script cannot be explained.
- PR diff and lockfile-only surprises, including new native dependencies, new
  optional dependencies, lifecycle scripts, transitive major churn, or peer
  version movement. Do not trust the Dependabot PR title's semver classification
  on its own.
- Transitive dependency and lockfile churn that could affect the client runtime,
  server runtime, native builds, or package publication.

## Preconditions Before Batch Triage

Before fanning out review work, verify the repository and merge gates. If any
precondition fails, surface the problem and stop instead of reviewing blindly.

1. Confirm the repo is `Devin-Marks/pi-forge`:

   ```sh
   gh repo view --json nameWithOwner
   ```

   The review rules are pi-forge-specific, including the pinned pi SDK trio,
   Node-LTS rule, and ruleset id `15775004`.

2. Confirm the main ruleset requires `check + build`:

   ```sh
   gh api repos/Devin-Marks/pi-forge/rulesets/15775004 \
     --jq '.rules[] | select(.type == "required_status_checks")'
   ```

   The `required_status_checks` rule must contain `check + build`. If it is
   missing, warn that MERGE verdicts should be downgraded to REVIEW until the
   gate exists.

3. Confirm repository auto-merge is enabled:

   ```sh
   gh api repos/Devin-Marks/pi-forge --jq .allow_auto_merge
   ```

   The value should be `true`. If it is false, queue commands will not engage;
   the user must enable auto-merge under Settings → General → Pull Requests.

## Listing PRs

List open Dependabot PRs with:

```sh
gh pr list --author "app/dependabot" --state open \
  --json number,title,statusCheckRollup --limit 50
```

If the user named specific PR numbers, restrict review to those PRs. Otherwise,
triage the full open Dependabot list.

## Controlled Reviewer Fanout

Use the `dependabot-reviewer` subagent for one PR at a time. For multiple PRs,
fan out in sequential batches of three reviewers with fresh context.

Required pattern:

```typescript
// Batch 1 — wait for this call to return before starting batch 2.
subagent({
  tasks: [
    { agent: "dependabot-reviewer", task: "Review PR #54" },
    { agent: "dependabot-reviewer", task: "Review PR #53" },
    { agent: "dependabot-reviewer", task: "Review PR #52" },
  ],
  concurrency: 3,
  context: "fresh",
})
```

Rules for fanout:

- Cap reviewer concurrency at **3** to avoid provider rate limits, contain cost
  if an agent is misconfigured, and keep batch output easy to inspect.
- Wait for each batch to fully resolve before issuing the next batch. Do not
  fire-and-forget multiple batches concurrently.
- Use `context: "fresh"` so each PR is inspected independently and findings do
  not bleed between reviews.
- Set `concurrency: 3` explicitly, even for three-task batches, to document the
  cap and prevent future drift.
- Do not wrap all batches in a single chain. Sequential batch calls let the
  parent inspect each result group and abort early if something looks wrong.
- Do not request filesystem worktree isolation for read-only review. Reviewers
  should inspect `gh pr view`, `gh pr diff`, `gh api`, manifests, and lockfiles;
  they should not mutate the checkout.

For 19 PRs, use 6 batches of 3 plus 1 batch of 1: seven sequential subagent
calls.

## Merge Safety Standard

Use `VERDICT: MERGE` only when all of these are true:

- Required checks are green, or the PR is clearly waiting only on the configured
  required checks that will gate auto-merge.
- No unexplained lifecycle script was added or changed, and npm install-script
  approval state is understood.
- Direct pi-forge usage has no breaking change or required migration.
- Peer/version coupling is safe, especially for client packages and native/tooling
  packages.
- The update does not violate project policy, such as the Node-LTS rule or pinned
  pi SDK trio handling.
- Changelog, source, package metadata, and PR diff are available enough to justify
  confidence. If evidence cannot be fetched or confidence is partial, use
  `BATCH: hold`, not “probably safe.”

## npm Package and Install-Script Review

For npm dependency PRs, review both package metadata and the repository's script
approval state. New or changed install-time code is security-sensitive.

Use package metadata to inspect scripts and dependency shape for both the old and
new versions when possible:

```sh
npm view <pkg>@<old-version> scripts dependencies optionalDependencies peerDependencies dist.integrity dist.tarball
npm view <pkg>@<new-version> scripts dependencies optionalDependencies peerDependencies dist.integrity dist.tarball
```

Inspect the published package contents and package-level diff when the update is
not obviously trivial, when lifecycle scripts are present, or when the package is
security-sensitive:

```sh
npm pack <pkg>@<new-version> --dry-run --json
npm diff --diff=<pkg>@<old-version> --diff=<pkg>@<new-version> -- package.json
```

Use the PR diff and lockfile to catch lockfile-only surprises. Do not rely on the
Dependabot title's semver label alone:

```sh
gh pr diff <N> > /tmp/dependabot-pr-<N>.diff
grep -E 'hasInstallScript|node-gyp|preinstall|postinstall|prepare|optionalDependencies|peerDependencies' /tmp/dependabot-pr-<N>.diff
```

Also check whether the updated dependency graph introduces unreviewed lifecycle
scripts:

```sh
npx npm@latest approve-scripts --allow-scripts-pending
```

If this reports pending scripts, place the PR in `BATCH: hold` until the user
decides whether each script should be approved or denied. Do not approve or deny
install scripts on the user's behalf without explicit direction.

## Sensitive Dependency Groups

Some dependencies should usually be reviewed or merged together because solo
bumps can create peer drift, config breakage, or runtime mismatches:

- pi SDK trio: `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, and
  related pi SDK packages.
- React pair: `react` and `react-dom`.
- Vite pair: `vite` and `@vitejs/plugin-react`.
- CodeMirror packages: `@codemirror/*` and related editor packages.
- xterm packages: `@xterm/*`.
- ESLint stack: `eslint`, `@eslint/*`, `typescript-eslint`, and ESLint plugins.
- Fastify/OpenAPI stack: `fastify`, `@fastify/*`, Swagger, and type-provider
  packages when their APIs or schemas move together.

Use `BATCH: cluster:<name>` when separate Dependabot PRs should be closed in
favor of one coordinated branch.

## Docker and Base Image Updates

For Dockerfile, base image, or runtime image PRs, check:

- Node version policy. Defer non-LTS Node majors unless the user explicitly wants
  to track current.
- Distro changes, package manager changes, and system package availability.
- Native build impact for packages such as `node-pty`, `esbuild`, and optional
  platform packages.
- Image security notes, deprecations, and changes to default users, shells,
  certificates, or libc/toolchain assumptions.

## Branch Freshness and Stale Checks

Before printing queue commands for a PR, check whether the Dependabot branch is
behind `main`, whether it is mergeable, and whether status checks are stale. If
the branch needs a rebase or checks need rerunning, do not queue it yet; ask
Dependabot/GitHub to rebase or wait for fresh checks first.

Useful inspection commands:

```sh
gh pr view <N> --json mergeStateStatus,isDraft,reviewDecision,statusCheckRollup,headRefOid,baseRefOid,updatedAt
gh pr checks <N>
```

Treat stale, missing, pending, or failing required checks as `BATCH: hold` unless
the user explicitly asks to queue and rely on GitHub's required checks to gate the
merge.

## Reviewer Verdict Shape

Collect the structured block from each reviewer. If a reviewer fails because of a
timeout, GitHub CLI error, or malformed output, put that PR in `BATCH: hold` with
reason `reviewer failed, needs manual triage`.

Expected block:

```text
VERDICT: MERGE | REVIEW | DEFER
BATCH:   trivial | npm-major | ci-action | cluster:<name> | defer | hold
PR:      #<N> — <title>
SEMVER:  ...
KIND:    ...
CI:      ...
REASON:  ...
NOTES:   ...
QUEUE COMMAND: gh pr review <N> --approve && gh pr merge <N> --auto --squash --delete-branch
```

Preserve the reviewer details when presenting results. Do not paraphrase away
breaking-change notes, script/security notes, or queue commands.

## BATCH Buckets

Present buckets in ascending risk order.

### `trivial`

Patch/minor updates with no meaningful pi-forge impact after usage, changelog,
CI, install-script review, lockfile review, and branch freshness checks. List
each PR and include a fenced queue command. End the bucket with one combined loop
the user can paste:

```sh
for n in <space-separated PR numbers>; do
  gh pr review $n --approve
  gh pr merge $n --auto --squash --delete-branch
done
```

### `ci-action`

GitHub Actions, CI-only tooling, or non-Node Docker major updates that are
usually safe but still deserve a one-line changelog/security note. Use the same
shape as `trivial`, including a combined loop when appropriate.

### `npm-major`

Major npm updates that require individual attention. List each PR separately with
its breaking-change notes, direct usage impact, CI/dev-server implications,
lifecycle-script findings, `approve-scripts` status, and lockfile surprises.
Recommend merging one at a time and running the full verification protocol below
between merges. Do **not** include a bulk loop.

### `cluster:<name>`

Related dependency updates that should move together, such as ESLint packages,
React/React DOM, Vite/plugin pairs, CodeMirror packages, xterm packages,
Fastify/OpenAPI packages, or the pi SDK trio. List siblings together, quote
relevant breaking-change notes, and recommend closing the individual Dependabot
PRs in favor of one coordinated local branch.

### `defer`

Updates that should not be merged now, such as non-LTS Node majors or updates
blocked by project policy. Include the reason and suggest `.github/dependabot.yml`
ignore rules where applicable.

### `hold`

Failed, suspicious, incomplete, stale, or ambiguous reviews. Include the failure
or security reason. Use this bucket for unreviewed install scripts, unavailable
metadata/changelogs, stale checks, and partial-confidence results. These need
manual user review before any action.

## Queue Command Rules

Print queue commands; do not execute them unless the user explicitly authorizes a
specific batch or PR in a separate instruction. Approval and auto-merge are the
user's call.

Do not try to manually optimize merge order. Once the user queues auto-merge,
GitHub serializes merges and Dependabot rebases surviving PRs automatically.

## Verification Protocol for npm-major and Client Dependencies

Include this protocol whenever a batch contains an `npm-major` PR. Also include a
per-row note for `trivial` or `ci-action` PRs that touch client dependencies,
including `react`, `react-dom`, `vite*`, `@vitejs/*`, `@xterm/*`,
`@codemirror/*`, `lucide-react`, and `react-*`.

`npm run check && npm run test:ci` is not enough for client-touching majors:

- The check/build/test pipeline exercises the production Rollup path, but not
  the dev-server Rolldown transform pipeline used by `npm run dev`.
- React, CodeMirror, Vite, xterm, and related packages can require exact or
  tightly coupled peer versions. Solo bumps can pass server-side checks and fail
  only in a browser render or dev transform.

Run this after each merge and before queueing the next npm-major/client update:

```sh
# 1. Re-resolve the lockfile against the new main
git pull --ff-only
npm install

# 2. Static / bundled checks
npm run check
npm run build
npm run test:ci

# 3. Dev-server boot-and-fetch — catches dev-mode transform errors
(cd packages/client && npx vite > /tmp/v.log 2>&1 &) && sleep 5
curl -fsS http://localhost:5173/ > /dev/null
curl -fsS http://localhost:5173/src/main.tsx > /dev/null
pkill -f "node.*\.bin/vite"
grep -E "error|Error" /tmp/v.log && echo "DEV BROKEN — STOP" || echo "DEV OK"

# 4. Browser runtime check
# Open http://localhost:5173 in a browser and confirm the DevTools console has
# no red errors. A white screen with clean server logs is usually a client-side
# peer/version drift.
```

Steps 3 and 4 are mandatory for packages on the client dependency graph. Skip
them only for server-only or pure CI-action bumps.

## Output Skeleton

```text
Triaged N Dependabot PRs.

# trivial (k)
- #54 — chore(deps): bump ip-address and express-rate-limit
  Queue:
  gh pr review 54 --approve && gh pr merge 54 --auto --squash --delete-branch

Queue all:
for n in 54 53 52 50 42; do
  gh pr review $n --approve
  gh pr merge $n --auto --squash --delete-branch
done

# ci-action (k)
- #55 — chore(deps): bump actions/setup-node from 4 to 5
  Note: CI-only major; changelog reviewed.

# npm-major (k)
- #49 — chore(deps): bump @xterm/xterm 5.5.0 → 6.0.0
  Breaking: drops legacy WebGL renderer; direct terminal rendering usage checked.
  Install scripts: none added or changed.
  Queue: gh pr review 49 --approve && gh pr merge 49 --auto --squash --delete-branch

# cluster:eslint-v10 (3)
- #43 — @eslint/js 9 → 10
- #47 — eslint 9 → 10
- #51 — eslint-plugin-react-hooks 5 → 7
Recommendation: close all three and open one chore/eslint-v10 branch that bumps
and fixes them together.

# defer (k)
- #41 — Dockerfile node 22 → 26: current, not LTS. Add a dependabot ignore rule.

# hold (k)
- #60 — reviewer failed, needs manual triage.
```
